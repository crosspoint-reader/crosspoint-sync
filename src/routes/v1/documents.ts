import { Hono } from 'hono';
import { withTransaction, type DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { isValidDocument, languageTag, listCursor, parseListCursor, parseMetadata, saveDocumentMetadata, type DocumentMetadata } from '../kosync.js';
import { nowSeconds } from '../../models/sync.js';
import { mergeDocuments, resolveDocument, unmergeDocument } from '../../models/merge.js';
import { coverCandidates, documentInfo } from '../../models/cover.js';
import { nextAfter, seriesBooks, tidy } from '../../models/hardcover-catalog.js';
import { extractTitleAuthor } from '../../connectors/matching.js';
import { documentMeta } from '../../connectors/store.js';
import { fanOutProgress } from '../../connectors/fanout.js';
import type { HttpTransport } from '../../connectors/types.js';
import { fetchTransport } from '../../connectors/registry.js';
import { MANUAL_DETAILS, type ManualFlag } from '../../models/manual-details.js';

const MAX_BATCH = 50;
const DOCUMENTS_PAGE = 500;
export const STATUSES = ['reading', 'finished', 'dnf', 'paused'] as const;

const DAY = 86400;

/** 'YYYY-MM-DD' -> unix seconds at UTC midnight; null clears; undefined = invalid.
 *  Rejects impossible dates (2026-02-30) and anything past tomorrow. */
export function parseCalendarDate(v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
  const ms = Date.parse(`${v}T00:00:00Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== v) return undefined;
  const at = ms / 1000;
  return at > nowSeconds() + DAY ? undefined : at;
}

export function documentRoutes(db: DB, http?: HttpTransport): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.put('/documents', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const items = (body as Record<string, unknown> | null)?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    const now = nowSeconds();
    // filesize is this endpoint's own; a value sent replaces the stored one, as title and filename do.
    const upsertSize = db.prepare(
      `INSERT INTO documents (user_id, document, filesize, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, document) DO UPDATE SET
         filesize = COALESCE(excluded.filesize, documents.filesize),
         updated_at = excluded.updated_at`
    );
    const rows: { document: string; meta: DocumentMetadata | null; filesize: number | null }[] = [];
    for (const raw of items) {
      const o = (raw ?? {}) as Record<string, unknown>;
      if (!isValidDocument(o.document)) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      rows.push({
        document: o.document,
        // The fields progress metadata takes; `author` is still read for older clients.
        meta: parseMetadata({ ...o, authors: typeof o.authors === 'string' && o.authors ? o.authors : o.author }),
        filesize:
          typeof o.filesize === 'number' && Number.isInteger(o.filesize) && o.filesize >= 0 ? o.filesize : null,
      });
    }
    withTransaction(db, () => {
      for (const r of rows) {
        // A merged copy's metadata goes to its book, as with progress.
        const document = resolveDocument(db, user.id, r.document);
        upsertSize.run(user.id, document, r.filesize, now);
        if (r.meta) saveDocumentMetadata(db, user.id, document, r.meta, now);
      }
    });
    return c.json({ until: now, accepted: rows.length });
  });

  // Merge two synced listings that are really the same book (devices can hash
  // the same file differently). `document` becomes an alias of `into`: existing
  // data migrates onto `into`, and future pushes under `document` land there.
  // Per-book reading stats are combined on read unless `stats` is false.
  app.post('/documents/merge', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const o = (body ?? {}) as Record<string, unknown>;
    if (!isValidDocument(o.document) || !isValidDocument(o.into)) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    const from = resolveDocument(db, user.id, o.document);
    const into = resolveDocument(db, user.id, o.into);
    if (from === into) {
      return kosyncError(c, 403, 2003, 'Documents are already merged');
    }
    // Reading stats combine by default; `stats: false` keeps them apart.
    const mergeStats = o.stats !== false;
    mergeDocuments(db, user.id, from, into, nowSeconds(), mergeStats);
    return c.json({ document: into, merged: from, stats: mergeStats });
  });

  // Undo a merge: the alias hash starts syncing separately again. Rows already
  // migrated stay on the canonical document.
  app.delete('/documents/merge/:alias', (c) => {
    const alias = c.req.param('alias');
    if (!isValidDocument(alias)) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    if (!unmergeDocument(db, user.id, alias)) {
      return c.json({ code: 2003, message: 'Unknown alias' }, 404);
    }
    return c.json({ alias, unmerged: true });
  });

  // Manual reading status; null clears it back to "derive from progress".
  // Marking finished also fans out to linked services (Hardcover, Micro.blog...).
  app.put('/documents/:document/status', async (c) => {
    const param = c.req.param('document');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const status = (body as Record<string, unknown> | null)?.status ?? null;
    if (!isValidDocument(param) || (status !== null && !STATUSES.includes(status as never))) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    const document = resolveDocument(db, user.id, param);
    const now = nowSeconds();
    db.prepare(
      `INSERT INTO documents (user_id, document, status, status_at, pause_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, document) DO UPDATE SET
         status = excluded.status, status_at = excluded.status_at, pause_reason = excluded.pause_reason`
    ).run(user.id, document, status as string | null, now, status === 'paused' ? 'manual' : null, now);
    if (status === 'finished') fanOutProgress(db, user.id, document, 1, now);
    return c.json({ document, status, status_at: now });
  });

  // Manual reading dates as YYYY-MM-DD calendar dates; null clears one back to the
  // device's (CrossInk) or the sync history's date, an omitted field is left alone.
  // Setting a finish date marks the book finished, like the status button.
  app.put('/documents/:document/dates', async (c) => {
    const param = c.req.param('document');
    let body: Record<string, unknown> | null;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    if (!isValidDocument(param) || typeof body !== 'object' || body === null) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const fields = ['start_date', 'finished_date'] as const;
    const parsed: Partial<Record<(typeof fields)[number], number | null>> = {};
    for (const f of fields) {
      if (!(f in body)) continue;
      const date = parseCalendarDate(body[f]);
      if (date === undefined) return kosyncError(c, 403, 2003, 'Invalid request');
      parsed[f] = date;
    }
    const user = c.get('user');
    const document = resolveDocument(db, user.id, param);
    const now = nowSeconds();
    const stored = db
      .prepare('SELECT status, start_date, finished_date FROM documents WHERE user_id = ? AND document = ?')
      .get(user.id, document) as { status: string | null; start_date: number | null; finished_date: number | null } | undefined;
    const start = 'start_date' in parsed ? parsed.start_date! : (stored?.start_date ?? null);
    const finished = 'finished_date' in parsed ? parsed.finished_date! : (stored?.finished_date ?? null);
    if (start !== null && finished !== null && start > finished) {
      return c.json({ code: 2003, message: 'The start date is after the finish date' }, 400);
    }
    const markFinished = parsed.finished_date != null && stored?.status !== 'finished';
    db.prepare(
      `INSERT INTO documents (user_id, document, start_date, finished_date, status, status_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, document) DO UPDATE SET
         start_date = excluded.start_date,
         finished_date = excluded.finished_date,
         status = CASE WHEN ? THEN 'finished' ELSE documents.status END,
         status_at = CASE WHEN ? THEN excluded.status_at ELSE documents.status_at END,
         pause_reason = CASE WHEN ? THEN NULL ELSE documents.pause_reason END`
    ).run(
      user.id,
      document,
      start,
      finished,
      markFinished ? 'finished' : null,
      markFinished ? now : null,
      now,
      markFinished ? 1 : 0,
      markFinished ? 1 : 0,
      markFinished ? 1 : 0
    );
    // Midday UTC on the chosen day, so services that take a date get that day.
    if (markFinished) fanOutProgress(db, user.id, document, 1, finished! + 12 * 3600);
    return c.json({ document, start_date: start, finished_date: finished, status: markFinished ? 'finished' : (stored?.status ?? null) });
  });

  app.get('/documents/:document/cover', async (c) => {
    const param = c.req.param('document');
    if (!isValidDocument(param)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    const info = await documentInfo(db, user.id, resolveDocument(db, user.id, param), http);
    return c.json({ url: info.cover, pages: info.pages });
  });

  // The book's description (from Hardcover's catalog or set by hand). Kept out of the progress
  // list so that stays small enough to cache offline.
  app.get('/documents/:document/about', (c) => {
    const param = c.req.param('document');
    if (!isValidDocument(param)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    const row = db
      .prepare('SELECT description, description_manual FROM documents WHERE user_id = ? AND document = ?')
      .get(user.id, resolveDocument(db, user.id, param)) as { description: string | null; description_manual: number } | undefined;
    return c.json({ description: row?.description ?? null, manual: !!row?.description_manual });
  });

  // The next book in this book's series, from Hardcover (needs HARDCOVER_API_KEY and
  // a looked-up series). { next: null } when there is none; pending while rate-limited.
  app.get('/documents/:document/next', async (c) => {
    const param = c.req.param('document');
    if (!isValidDocument(param)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    const key = process.env.HARDCOVER_API_KEY;
    const row = db
      .prepare('SELECT series, hc_series_id, series_position FROM documents WHERE user_id = ? AND document = ?')
      .get(user.id, resolveDocument(db, user.id, param)) as
      | { series: string | null; hc_series_id: number | null; series_position: number | null }
      | undefined;
    if (!key || !row?.hc_series_id || row.series_position == null) return c.json({ next: null });
    const list = await seriesBooks(db, http ?? fetchTransport, row.hc_series_id, key);
    if (list === 'later') return c.json({ next: null, pending: true });
    return c.json({ series: row.series, next: nextAfter(list, row.series_position) });
  });

  // Covers to choose from when the automatic one is wrong. ?q= searches a different title.
  app.get('/documents/:document/cover/candidates', async (c) => {
    const param = c.req.param('document');
    if (!isValidDocument(param)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    const meta = extractTitleAuthor(documentMeta(db, user.id, resolveDocument(db, user.id, param)));
    const q = c.req.query('q')?.trim().slice(0, 200);
    const title = q || meta?.title;
    if (!title) return c.json({ items: [] });
    return c.json({ items: await coverCandidates(http ?? fetchTransport, title, q ? '' : (meta?.author ?? '')) });
  });

  // Manual cover / print page count / title and author / language / genres when lookups got it wrong.
  // Manual values stick (lookups only fill blanks, and device syncs don't replace an
  // edited title or language); null clears cover, page count or genres so they're looked
  // up again, and language so the next device sync fills it.
  app.put('/documents/:document/info', async (c) => {
    const param = c.req.param('document');
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const o = (body ?? {}) as Record<string, unknown>;
    const cover = o.cover_url;
    const pages = o.page_count;
    const text = (v: unknown) => (typeof v === 'string' ? v.trim().slice(0, 500) : v);
    const title = text(o.title);
    const author = text(o.author);
    const language = o.language === undefined || o.language === null ? o.language : languageTag(o.language);
    // Each detail set by hand (MANUAL_DETAILS): its columns' values, or null to hand it back to Hardcover.
    const details = new Map<ManualFlag, (string | number | null)[] | null>();
    let detailsOk = true;
    const take = (flag: ManualFlag, raw: unknown, parse: (v: unknown) => (string | number | null)[] | undefined) => {
      if (raw === undefined) return;
      const values = raw === null ? null : parse(raw);
      if (values === undefined) detailsOk = false;
      else details.set(flag, values);
    };
    // Genres, moods and content warnings: a short list of short names, spelled the way Hardcover's are stored (tidy():
    // trimmed, de-duplicated ignoring case, first letter capitalized), so the two sources count as one.
    const list = (max: number) => (v: unknown) => {
      if (!Array.isArray(v) || !v.every((g) => typeof g === 'string' && g.trim().length > 0 && g.trim().length <= 64)) return undefined;
      const l = tidy(v, max + 1);
      return l.length <= max ? [l.length ? JSON.stringify(l) : null] : undefined;
    };
    take('genres', o.genres, list(10));
    take('moods', o.moods, list(12));
    take('content_warnings', o.content_warnings, list(12));
    take('description', o.description, (v) => {
      // Not text(): its 500-character cut would shorten a description silently.
      const d = typeof v === 'string' ? v.trim() : v;
      return typeof d === 'string' && d.length <= 6000 ? [d || null] : undefined;
    });
    take('release_year', o.release_year, (v) => (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 9999 ? [v as number] : undefined));
    // A series name, with its number when given; the number alone is not taken, so it never lands on a
    // series Hardcover named.
    take('series', o.series, (v) => {
      const name = text(v);
      const pos = o.series_position;
      const posOk = pos === undefined || pos === null || (typeof pos === 'number' && Number.isFinite(pos) && pos >= 0 && pos <= 10000);
      return typeof name === 'string' && name.length > 0 && name.length <= 200 && posOk ? [name, (pos as number | undefined) ?? null, null] : undefined;
    });
    if (o.series_position !== undefined && o.series === undefined) detailsOk = false;
    // A title is required once edited; an empty author means "no author".
    const titleOk = title === undefined || (typeof title === 'string' && title.length > 0);
    const authorOk = author === undefined || typeof author === 'string';
    const coverOk = cover === undefined || cover === null || (typeof cover === 'string' && /^https?:\/\/\S{1,2000}$/.test(cover));
    const pagesOk = pages === undefined || pages === null || (Number.isInteger(pages) && (pages as number) > 0 && (pages as number) <= 100000);
    if (!isValidDocument(param) || !coverOk || !pagesOk || !titleOk || !authorOk || !detailsOk || (language === null && o.language !== null)) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    const document = resolveDocument(db, user.id, param);
    const now = nowSeconds();
    db.prepare('INSERT INTO documents (user_id, document, updated_at) VALUES (?, ?, ?) ON CONFLICT(user_id, document) DO NOTHING').run(user.id, document, now);
    if (cover !== undefined) {
      db.prepare('UPDATE documents SET cover_url = ?, cover_checked_at = ? WHERE user_id = ? AND document = ?').run(cover as string | null, cover === null ? null : now, user.id, document);
    }
    if (pages !== undefined) {
      db.prepare(
        `UPDATE documents SET page_count = ?, cover_checked_at = CASE WHEN ? IS NULL THEN NULL ELSE cover_checked_at END,
           pages_checked_at = CASE WHEN ? IS NULL THEN NULL ELSE pages_checked_at END WHERE user_id = ? AND document = ?`
      ).run(pages as number | null, pages as number | null, pages as number | null, user.id, document);
    }
    if (language !== undefined) {
      db.prepare('UPDATE documents SET language = ? WHERE user_id = ? AND document = ?').run(language as string | null, user.id, document);
    }
    for (const d of MANUAL_DETAILS) {
      if (!details.has(d.flag)) continue;
      const values = details.get(d.flag) ?? null;
      // Set here, it sticks over Hardcover's; cleared, it is handed back: the next enrichment pass looks the
      // book up again. Column names come from MANUAL_DETAILS, never from the request.
      db.prepare(
        `UPDATE documents SET ${d.columns.map((c) => `${c} = ?`).join(', ')}, ${d.flag}_manual = ?,
           hc_checked_at = CASE WHEN ? THEN hc_checked_at ELSE NULL END
         WHERE user_id = ? AND document = ?`
      ).run(...(values ?? d.columns.map(() => null)), values ? 1 : 0, values ? 1 : 0, user.id, document);
    }
    if (title !== undefined || author !== undefined) {
      // New title/author: everything found with the old one is looked up again
      // (blank cover and page count, Hardcover details, automatic service matches).
      // A cover or page count the user set stays; so do matches they picked.
      db.prepare(
        `UPDATE documents SET title = COALESCE(?, title), author = CASE WHEN ? THEN NULLIF(?, '') ELSE author END,
           meta_manual = 1, cover_checked_at = NULL, pages_checked_at = NULL, hc_checked_at = NULL
         WHERE user_id = ? AND document = ?`
      ).run((title as string | undefined) ?? null, author !== undefined ? 1 : 0, (author as string | undefined) ?? '', user.id, document);
      db.prepare("DELETE FROM connector_matches WHERE user_id = ? AND document = ? AND source IN ('auto', 'none')").run(user.id, document);
    }
    const row = db.prepare(
      `SELECT cover_url, page_count, title, author, language, genres, moods, content_warnings, description, series,
         series_position, release_year FROM documents WHERE user_id = ? AND document = ?`
    ).get(user.id, document) as {
      cover_url: string | null; page_count: number | null; title: string | null; author: string | null; language: string | null; genres: string | null;
      moods: string | null; content_warnings: string | null; description: string | null; series: string | null;
      series_position: number | null; release_year: number | null;
    };
    const parsed = (v: string | null) => (v ? (JSON.parse(v) as string[]) : []);
    return c.json({ document, cover_url: row.cover_url, page_count: row.page_count, title: row.title, author: row.author, language: row.language,
      genres: parsed(row.genres), moods: parsed(row.moods), content_warnings: parsed(row.content_warnings), description: row.description,
      series: row.series, series_position: row.series_position, release_year: row.release_year });
  });

  // Newest first, 500 per page; pass `next` back as `cursor` for the following page.
  app.get('/documents', (c) => {
    const user = c.get('user');
    const cursor = parseListCursor(c.req.query('cursor'));
    if (cursor === null) return kosyncError(c, 403, 2003, 'Invalid request');
    const rows = db
      .prepare(
        `SELECT document, title, author, filename, filesize, language, status, status_at, pause_reason, cover_url, page_count, updated_at
         FROM documents WHERE user_id = ?
           AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND document < ?))
         ORDER BY updated_at DESC, document DESC LIMIT ?`
      )
      .all(user.id, cursor?.at ?? null, cursor?.at ?? null, cursor?.at ?? null, cursor?.document ?? null, DOCUMENTS_PAGE + 1) as {
      document: string;
      updated_at: number;
    }[];
    const more = rows.length > DOCUMENTS_PAGE;
    if (more) rows.pop();
    return c.json({ items: rows, next: more ? listCursor(rows[rows.length - 1]) : null });
  });

  return app;
}
