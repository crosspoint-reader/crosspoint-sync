import crypto from 'node:crypto';
import { Hono } from 'hono';
import type { DB } from '../db/db.js';
import type { AppEnv } from '../auth/middleware.js';
import { combineGlobalStats, completedBookStatsSql, type GlobalStatsSnapshot } from '../models/stats.js';
import { readBookorbitStats } from '../models/bookorbit-stats.js';
import { readingActivity } from '../models/activity.js';
import { fontFaces } from './web.js';

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

/** Trimmed display name (case and inner spaces kept), null when blank, undefined when invalid. */
export function cleanDisplayName(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const name = value.trim();
  if (/[\p{Cc}]/u.test(name) || [...name].length > 64) return undefined;
  return name || null;
}

/** Turn the signed-in account's public profile on (new random link) or off, and set its display name. */
export function profileSettingsRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const profileOf = (id: number) => {
    const row = db.prepare('SELECT profile_slug, display_name FROM users WHERE id = ?').get(id) as
      { profile_slug: string | null; display_name: string | null };
    return { slug: row.profile_slug, display_name: row.display_name };
  };

  app.get('/profile', (c) => c.json(profileOf(c.get('user').id)));

  app.put('/profile', async (c) => {
    const user = c.get('user');
    let body: Record<string, unknown> = {};
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      /* validated below */
    }
    const { enabled } = body;
    const name = 'display_name' in body ? cleanDisplayName(body.display_name) : null;
    if ((enabled !== undefined && typeof enabled !== 'boolean') || name === undefined || (enabled === undefined && !('display_name' in body))) {
      return c.json({ code: 2003, message: 'Send { enabled?: boolean, display_name?: string | null } (display name up to 64 characters)' }, 400);
    }
    if ('display_name' in body) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(name, user.id);
    if (typeof enabled === 'boolean') {
      // Keep an existing link when it's already on; turning off and on again makes a new one.
      const slug = enabled ? (profileOf(user.id).slug ?? crypto.randomBytes(9).toString('base64url')) : null;
      db.prepare('UPDATE users SET profile_slug = ? WHERE id = ?').run(slug, user.id);
    }
    return c.json(profileOf(user.id));
  });

  return app;
}

/** Consecutive reading days (YYYY-MM-DD, sorted) ending today or yesterday, in UTC. */
export function syncStreak(days: string[], now = Date.now()): number {
  // ponytail: UTC days, the visitor's and reader's time zones are unknown here.
  const set = new Set(days);
  const day = (offset: number) => new Date(now - offset * 86400000).toISOString().slice(0, 10);
  let offset = set.has(day(0)) ? 0 : 1;
  let streak = 0;
  while (set.has(day(offset++))) streak++;
  return streak;
}

interface ProfileBook {
  document: string;
  title: string | null;
  author: string | null;
  filename: string | null;
  cover_url: string | null;
  status: string;
  percentage: number;
}

/** Public, embeddable reading profile: stats, currently reading, finished. */
export function publicProfileRoutes(db: DB, basePath: string): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/u/:slug', (c) => {
    const user = db.prepare('SELECT id, username, display_name FROM users WHERE profile_slug = ?').get(c.req.param('slug')) as
      | { id: number; username: string; display_name: string | null }
      | undefined;
    if (!user) return c.notFound();

    const snapshots = (
      db.prepare('SELECT payload FROM stats_device_global WHERE user_id = ?').all(user.id) as { payload: string }[]
    ).map((r) => JSON.parse(r.payload) as GlobalStatsSnapshot);
    const imported = readBookorbitStats(db, user.id);
    if (imported.global.sessions) snapshots.push(imported.global);
    const stats = combineGlobalStats(snapshots);

    // Newest progress per book (SQLite returns the MAX row's other columns), status as in GET /progress.
    const books = db
      .prepare(
        `SELECT p.document, d.title, d.author, d.filename, d.cover_url, p.percentage,
                COALESCE(d.status, CASE WHEN p.percentage >= 0.98 OR ${completedBookStatsSql('p.user_id', 'p.document')}
                  THEN 'finished' ELSE 'reading' END) AS status
         FROM (SELECT user_id, document, percentage, MAX(updated_at) AS at FROM progress WHERE user_id = ? GROUP BY document) p
         LEFT JOIN documents d ON d.user_id = p.user_id AND d.document = p.document
         WHERE d.title IS NOT NULL OR d.filename IS NOT NULL
         ORDER BY COALESCE(d.finished_date, d.status_at, p.at) DESC`
      )
      .all(user.id) as unknown as ProfileBook[];
    const reading = books.filter((b) => b.status === 'reading');
    const finished = books.filter((b) => b.status === 'finished');

    // Pages and streak as the app's library header counts them: from the sync
    // history, so readers that never upload stats still get them.
    const activity = readingActivity(db, user.id, 0);
    const listed = new Set(books.map((b) => b.document));
    const pages = activity.books.reduce((n, b) => n + (listed.has(b.document) ? (b.pages_read ?? 0) : 0), 0);
    const streak = Math.max(stats.current_streak, syncStreak(activity.reading_days));

    const name = esc(user.display_name ?? user.username);
    // Zero stats are left out: a reader that never uploads time shouldn't show "0 hours read".
    const tile = (value: number, label: string) =>
      value > 0 ? `<div class="tile"><b>${value.toLocaleString('en-US')}</b><span>${label}</span></div>` : '';
    const tiles = [
      tile(Math.round(stats.seconds / 3600), 'hours read'),
      tile(pages, 'pages read'),
      tile(finished.length, 'books finished'),
      tile(streak, 'day streak'),
    ].join('');
    const book = (b: ProfileBook) => {
      const title = esc(b.title ?? b.filename!.replace(/\.[a-z0-9]+$/i, ''));
      const cover = b.cover_url && /^https?:\/\//.test(b.cover_url) ? `<img src="${esc(b.cover_url)}" alt="" loading="lazy">` : '<div class="blank"></div>';
      const bar = b.status === 'reading' ? `<div class="bar"><i style="width:${Math.round(b.percentage * 100)}%"></i></div>` : '';
      return `<li>${cover}<div><p class="t">${title}</p>${b.author ? `<p class="a">${esc(b.author)}</p>` : ''}${bar}</div></li>`;
    };
    const shelf = (heading: string, list: ProfileBook[]) =>
      list.length ? `<h2>${heading} <small>${list.length}</small></h2><ul>${list.map(book).join('')}</ul>` : '';

    c.header('cache-control', 'public, max-age=300');
    return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}'s reading</title>
<link rel="icon" type="image/png" href="${basePath}/favicon.png">
<style>${fontFaces(basePath)}
:root{color-scheme:light dark;--page:#fafaf9;--surface:#fff;--ink:#1c1917;--soft:#78716c;--line:#e7e5e4;--brand:#4a7a62}
@media (prefers-color-scheme:dark){:root{--page:#121110;--surface:#1b1917;--ink:#f3f0ed;--soft:#a09993;--line:#2e2a27;--brand:#6fa287}}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:15px/1.4 InterVariable,system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px}
h1,h2{font-family:Lora,Georgia,serif;font-weight:600}h1{font-size:28px;margin:0 0 16px}h2{font-size:20px;margin:28px 0 12px}
small{color:var(--soft);font:500 14px InterVariable,system-ui,sans-serif}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.tile{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:12px}
.tile b{display:block;font-size:22px}.tile span{color:var(--soft);font-size:13px}
ul{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:minmax(0,1fr);gap:10px}
li{display:flex;gap:12px;align-items:center}
li img,.blank{width:44px;height:66px;object-fit:cover;border-radius:4px;background:var(--line);flex-shrink:0}
li>div:last-child{min-width:0;flex:1}.t{margin:0;font-weight:600;overflow:hidden;overflow-wrap:anywhere;display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2}.a{margin:2px 0 0;color:var(--soft);font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar{margin-top:6px;height:4px;border-radius:2px;background:var(--line);max-width:200px}.bar i{display:block;height:100%;border-radius:2px;background:var(--brand)}
footer{margin-top:32px;color:var(--soft);font-size:12px}footer a{color:inherit}
</style></head><body><main>
<h1>${name}'s reading</h1>
${tiles ? `<div class="tiles">${tiles}</div>` : ''}
${shelf('Reading now', reading)}
${shelf('Finished', finished)}
<footer>Synced with <a href="https://crosspointreader.com" target="_blank" rel="noopener">CrossPoint Sync</a></footer>
</main></body></html>`);
  });

  return app;
}
