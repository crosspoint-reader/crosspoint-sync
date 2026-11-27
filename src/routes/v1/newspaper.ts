import { Hono, type Context } from 'hono';
import type { DB } from '../../db/db.js';
import type { AppEnv } from '../../auth/middleware.js';
import type { HttpTransport } from '../../connectors/types.js';
import { escapeXml } from '../../connectors/kindle-fiona.js';
import { addFeed, buildEpub, issueArticles, issueTitle, NewspaperError, PAPER_NAME, refreshFeeds, rollUp, saveArticle } from '../../models/newspaper.js';

import { assignKagiIssue, kagiArticles, kagiIssues, kagiProvider, kagiSettings, saveKagiSettings } from '../../models/newspaper-kagi.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Today's date where the reader is; tz is minutes behind UTC, as in the stats API. */
function localDay(c: Context): { today: string; offset: number } {
  const tz = Number(c.req.query('tz') ?? 0);
  // ponytail: a reader fetching over OPDS sends no tz, so its paper rolls over at UTC midnight; store a per-user tz if that matters.
  const offset = Number.isFinite(tz) ? Math.max(-840, Math.min(840, tz)) : 0;
  return { today: new Date(Date.now() - offset * 60_000).toISOString().slice(0, 10), offset };
}

async function bodyUrl(c: Context): Promise<string> {
  const body = await c.req.json().catch(() => null) as { url?: unknown } | null;
  return typeof body?.url === 'string' ? body.url.slice(0, 2000) : '';
}

export function newspaperRoutes(db: DB, http: HttpTransport, kagiEnabled = false, kagiHttp = http): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const kagi = kagiProvider(kagiHttp);

  if (kagiEnabled) {
    app.get('/newspaper/kagi/categories', async (c) => {
      try {
        const categories = await kagi.categories(await kagi.latest());
        return c.json({ categories: categories.map(({ id, name }) => ({ id, name })) });
      } catch {
        return c.json({ message: 'Kagi News categories are temporarily unavailable.' }, 503);
      }
    });
    app.put('/newspaper/kagi', async (c) => {
      const body = await c.req.json().catch(() => null);
      if (!saveKagiSettings(db, c.get('user').id, body?.categories)) {
        return c.json({ message: 'Choose up to five distinct Kagi News categories.' }, 422);
      }
      return c.json({ ok: true });
    });
  }

  // Fetching a stranger's site fails in many ways; all of them are the user's to read.
  const attempt = async <T>(c: Context, work: () => Promise<T>) => {
    try { return c.json(await work() as object); }
    catch (error) {
      return c.json({ message: error instanceof NewspaperError ? error.message : "Couldn't reach that site." }, 422);
    }
  };

  // Articles with no issue are waiting for today's edition; the rest belong to past editions.
  app.get('/newspaper', (c) => {
    const userId = c.get('user').id;
    const { today, offset } = localDay(c);
    rollUp(db, userId, today, offset);
    const briefings = kagiIssues(db, userId, today);
    const briefingArticles = briefings.flatMap((snapshot) => kagiArticles(snapshot).map((article, index) => ({
      id: `kagi-${snapshot.issue}-${index}`, issue: snapshot.issue, title: article.title,
      url: article.url, section: article.category ? `Kagi News · ${article.category}` : 'Kagi News',
    })));
    return c.json({
      kagi: kagiEnabled ? {
        categories: kagiSettings(db, userId), lastIncluded: briefings[0]?.issue ?? null,
        missing: JSON.parse(briefings.find(({ issue }) => issue === today)?.missing ?? '[]'),
      } : null,
      feeds: db.prepare('SELECT id, url, title FROM news_feeds WHERE user_id = ? ORDER BY title COLLATE NOCASE').all(userId),
      articles: [...db.prepare(
        `SELECT id, url, title, section, issue, created_at FROM news_articles
         WHERE user_id = ? AND content != '' ORDER BY created_at DESC, id DESC LIMIT 200`
      ).all(userId), ...briefingArticles],
    });
  });

  app.post('/newspaper/refresh', async (c) => {
    await refreshFeeds(db, c.get('user').id, http);
    return c.json({ ok: true });
  });

  app.post('/newspaper/articles', async (c) => {
    const url = await bodyUrl(c);
    return attempt(c, () => saveArticle(db, c.get('user').id, url, http));
  });

  app.delete('/newspaper/articles/:id', (c) => {
    // Blank rather than delete: the row keeps a feed from offering the item again.
    db.prepare("UPDATE news_articles SET content = '' WHERE user_id = ? AND id = ?").run(c.get('user').id, Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  app.post('/newspaper/feeds', async (c) => {
    const url = await bodyUrl(c);
    return attempt(c, () => addFeed(db, c.get('user').id, url, http));
  });

  app.delete('/newspaper/feeds/:id', (c) => {
    db.prepare('DELETE FROM news_feeds WHERE user_id = ? AND id = ?').run(c.get('user').id, Number(c.req.param('id')));
    return c.json({ ok: true });
  });

  // today.epub pulls feeds and gathers everything waiting; YYYY-MM-DD.epub replays a past issue.
  app.get('/newspaper/issue/:file', async (c) => {
    const userId = c.get('user').id;
    const name = c.req.param('file').replace(/\.epub$/, '');
    const { today, offset } = localDay(c);
    rollUp(db, userId, today, offset);
    const date = name === 'today' ? today : name;
    if (!DATE_RE.test(date)) return c.json({ message: 'Unknown issue.' }, 404);
    if (date === today) await refreshFeeds(db, userId, http);
    if (kagiEnabled && date === today) {
      await assignKagiIssue(db, userId, today, kagi).catch(() => {});
    }
    const briefing = kagiIssues(db, userId, today).find(({ issue }) => issue === date);
    const articles = [...issueArticles(db, userId, date, date === today), ...kagiArticles(briefing)];
    if (!articles.length) return c.json({ message: 'Nothing new to read yet.' }, 404);
    return c.body(new Uint8Array(buildEpub(date, articles)), 200, {
      'Content-Type': 'application/epub+zip',
      'Content-Disposition': `attachment; filename="${issueTitle(date)}.epub"`,
    });
  });

  return app;
}

/**
 * The paper as an OPDS catalog, for a reader to fetch on its own. Readers only
 * speak HTTP Basic, so the sync username and password are translated into the
 * headers the API already accepts and the request is replayed against it.
 */
export function newspaperOpdsRoutes(api: Hono<AppEnv>, basePath: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const root = `${basePath}/opds/crosspaper`;

  const asUser = (c: Context, path: string): Promise<Response> | null => {
    const basic = /^Basic\s+(.+)$/i.exec(c.req.header('authorization') ?? '')?.[1];
    const [, user, key] = /^([^:]*):(.*)$/s.exec(basic ? Buffer.from(basic, 'base64').toString('utf8') : '') ?? [];
    return user && key ? Promise.resolve(api.request(path, { headers: { 'x-auth-user': user, 'x-auth-key': key } })) : null;
  };
  const challenge = (c: Context) => c.text('Sign in with your sync username and password.', 401, { 'WWW-Authenticate': 'Basic realm="CrossPoint Sync"' });

  app.get('/opds/crosspaper', async (c) => {
    const res = await asUser(c, '/newspaper');
    if (!res || res.status !== 200) return challenge(c);
    const { articles } = await res.json() as { articles: { issue: string | null }[] };
    const past = [...new Set(articles.map((a) => a.issue).filter((d): d is string => !!d))].sort().reverse();
    const entry = (id: string, title: string, summary: string) =>
      `<entry><id>urn:crosspoint:newspaper:${id}</id><title>${escapeXml(title)}</title><updated>${new Date().toISOString()}</updated><content type="text">${escapeXml(summary)}</content><link rel="http://opds-spec.org/acquisition" type="application/epub+zip" href="${root}/${id}.epub"/></entry>`;
    return c.body(
      `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom"><id>urn:crosspoint:newspaper</id><title>${PAPER_NAME}</title><updated>${new Date().toISOString()}</updated><link rel="self" type="application/atom+xml;profile=opds-catalog;kind=acquisition" href="${root}"/>${
        entry('today', "Today's CrossPaper", 'Saved pages and new items from your feeds.')
      }${past.map((date) => entry(date, issueTitle(date), 'An earlier issue.')).join('')}</feed>`,
      200, { 'Content-Type': 'application/atom+xml;profile=opds-catalog;kind=acquisition', 'Cache-Control': 'no-store' });
  });

  app.get('/opds/crosspaper/:file', async (c) => {
    const res = await asUser(c, `/newspaper/issue/${encodeURIComponent(c.req.param('file'))}`);
    return !res || res.status === 401 ? challenge(c) : res;
  });

  return app;
}
