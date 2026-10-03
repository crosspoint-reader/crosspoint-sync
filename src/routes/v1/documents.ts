import { Hono } from 'hono';
import { withTransaction, type DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { isValidDocument } from '../kosync.js';
import { nowSeconds } from '../../models/sync.js';
import { mergeDocuments, resolveDocument, unmergeDocument } from '../../models/merge.js';
import { coverCandidates, documentInfo } from '../../models/cover.js';
import { nextAfter, seriesBooks } from '../../models/hardcover-catalog.js';
import { extractTitleAuthor } from '../../connectors/matching.js';
import { documentMeta } from '../../connectors/store.js';
import { fanOutProgress } from '../../connectors/fanout.js';
import type { HttpTransport } from '../../connectors/types.js';
import { fetchTransport } from '../../connectors/registry.js';

const MAX_BATCH = 50;
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
    const upsert = db.prepare(
      `INSERT INTO documents (user_id, document, title, author, filename, filesize, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, document) DO UPDATE SET
         title = COALESCE(excluded.title, documents.title),
         author = COALESCE(excluded.author, documents.author),
         filename = COALESCE(excluded.filename, documents.filename),
         filesize = COALESCE(excluded.filesize, documents.filesize),
         updated_at = excluded.updated_at`
    );
    type Row = {
      document: string;
      title: string | null;
      author: string | null;
      filename: string | null;
      filesize: number | null;
    };
    const rows: Row[] = [];
    for (const raw of items) {
      const o = raw as Record<string, unknown>;
      if (!isValidDocument(o.document)) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      rows.push({
        document: o.document,
        title: typeof o.title === 'string' ? o.title.slice(0, 512) : null,
        author: typeof o.author === 'string' ? o.author.slice(0, 512) : null,
        filename: typeof o.filename === 'string' ? o.filename.slice(0, 512) : null,
        filesize:
          typeof o.filesize === 'number' && Number.isInteger(o.filesize) && o.filesize >= 0
            ? o.filesize
            : null,
      });
    }
    withTransaction(db, () => {
      for (const r of rows) {
        upsert.run(user.id, r.document, r.title, r.author, r.filename, r.filesize, now);
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

  // The book's description (from Hardcover's catalog). Kept out of the progress
  // list so that stays small enough to cache offline.
  app.get('/documents/:document/about', (c) => {
    const param = c.req.param('document');
    if (!isValidDocument(param)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    const row = db
      .prepare('SELECT description FROM documents WHERE user_id = ? AND document = ?')
      .get(user.id, resolveDocument(db, user.id, param)) as { description: string | null } | undefined;
    return c.json({ description: row?.description ?? null });
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

  // Manual cover / print page count when the lookup got it wrong. Manual values stick
  // (lookups only fill blanks); null clears a field so it's looked up again.
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
    const coverOk = cover === undefined || cover === null || (typeof cover === 'string' && /^https?:\/\/\S{1,2000}$/.test(cover));
    const pagesOk = pages === undefined || pages === null || (Number.isInteger(pages) && (pages as number) > 0 && (pages as number) <= 100000);
    if (!isValidDocument(param) || !coverOk || !pagesOk) {
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
      db.prepare('UPDATE documents SET page_count = ?, cover_checked_at = CASE WHEN ? IS NULL THEN NULL ELSE cover_checked_at END WHERE user_id = ? AND document = ?').run(pages as number | null, pages as number | null, user.id, document);
    }
    const row = db.prepare('SELECT cover_url, page_count FROM documents WHERE user_id = ? AND document = ?').get(user.id, document) as { cover_url: string | null; page_count: number | null };
    return c.json({ document, cover_url: row.cover_url, page_count: row.page_count });
  });

  app.get('/documents', (c) => {
    const user = c.get('user');
    const rows = db
      .prepare(
        'SELECT document, title, author, filename, filesize, status, status_at, pause_reason, cover_url, page_count, updated_at FROM documents WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500'
      )
      .all(user.id);
    return c.json({ items: rows });
  });

  return app;
}
