import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { withTransaction, type DB } from '../../db/db.js';
import type { AppEnv } from '../../auth/middleware.js';
import { AccountImportError } from '../../models/account-data.js';
import { HISTORY_DEVICE, importHistory, prepareHistory, type History } from '../../models/koinsight-import.js';
import { resolveDocument, statsDocuments } from '../../models/merge.js';
import { fanOutBookStats } from '../../connectors/fanout.js';

const MAX_PAGES = 20_000;
const HISTORY_LABEL = 'KOReader';
// Page records older than this are history being filled in, not reading to report as new.
const RECENT_READING_SECONDS = 2 * 86400;

export function koreaderRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  // One complete book per request. Retrying after a partial library upload is safe.
  app.post('/stats/koreader', bodyLimit({ maxSize: 4 * 1024 * 1024 }), async (c) => {
    let body;
    try { body = await c.req.json(); } catch { return c.json({ message: 'Invalid JSON.' }, 400); }
    const book = body?.book;
    const pages = body?.pages;
    if (body?.version !== 1 || typeof body.timezone !== 'string' || body.timezone.length > 100 ||
        !book || typeof book.md5 !== 'string' || !/^[a-f0-9]{32}$/.test(book.md5) ||
        [book.title, book.authors].some(v => v !== null && (typeof v !== 'string' || v.length > 4096)) ||
        !Array.isArray(pages) || !pages.length || pages.length > MAX_PAGES) {
      return c.json({ message: 'Send a book, time zone and 1–20,000 page records (version 1).' }, 400);
    }
    const now = Math.floor(Date.now() / 1000);
    if (pages.some(p => !p || ![p.page, p.total_pages, p.start_time, p.duration].every(Number.isSafeInteger) ||
        p.page < 0 || p.total_pages < 1 || p.total_pages > 1_000_000 || p.page > p.total_pages ||
        p.start_time < 946684800 || p.start_time > now + 300 || p.duration < 0 || p.duration > 86400)) {
      return c.json({ message: 'Invalid page history. Nothing was synced for this book.' }, 400);
    }
    const userId = c.get('user').id;
    try {
      let records = 0;
      let synced = '';
      let history = false;
      withTransaction(db, () => {
        const document = resolveDocument(db, userId, book.md5);
        const ids = statsDocuments(db, userId, document);
        const stored = ids.flatMap(id => db.prepare('SELECT * FROM reader_history_pages WHERE user_id = ? AND document = ?').all(userId, id));
        // Older imports contain only aggregates: never guess which raw events they covered.
        const legacy = ids.some(id => db.prepare(`SELECT 1 FROM stats_device_book WHERE user_id = ? AND document = ? AND device_id = ?
          AND (json_extract(payload, '$.seconds') > 0 OR json_extract(payload, '$.pages') > 0)`).get(userId, id, HISTORY_DEVICE) && !stored.some(p => p.document === id));
        if (legacy) {
          throw new AccountImportError('Re-import the original KOReader/KOInsight history file in app Settings before syncing this book. Its older import has no source records to reconcile safely.', 409);
        }
        const known = new Map<string, number>(stored.map(p => [`${p.page}:${p.total_pages}:${p.start_time}`, Number(p.duration)]));
        history = pages.some(p => p.start_time < now - RECENT_READING_SECONDS &&
          (known.get(`${p.page}:${p.total_pages}:${p.start_time}`) ?? -1) < p.duration);
        const unique = new Map<string, History['pages'][number]>();
        for (const p of [...stored, ...pages]) {
          const key = `${p.page}:${p.total_pages}:${p.start_time}`;
          if (!unique.has(key) || unique.get(key)!.duration < p.duration) {
            unique.set(key, { book_md5: document, page: p.page, total_pages: p.total_pages, start_time: p.start_time, duration: p.duration });
          }
        }
        if (unique.size > MAX_PAGES) throw new AccountImportError('This book exceeds the 20,000 page-record sync limit. Use the history-file importer.');
        const prepared = prepareHistory(db, userId, {
          books: [{ md5: document, title: book.title, authors: book.authors, reference_pages: null }],
          pages: [...unique.values()], source: 'KOReader',
        }, body.timezone);
        // The plugin adds KOReader time alongside firmware time, not instead of it.
        // No inferred completion: visiting an end page is not a reliable finished signal.
        const b = prepared[0];
        b.existing_history = false;
        importHistory(db, userId, prepared, { [document]: b.status === 'finished' ? b.finished_date : null });
        records = unique.size;
        synced = document;
      });
      fanOutBookStats(db, userId, synced, HISTORY_DEVICE, HISTORY_LABEL, now, history);
      return c.json({ version: 1, document: book.md5, accepted: pages.length, records });
    } catch (error) {
      if (error instanceof AccountImportError) return c.json({ message: error.message }, error.status);
      throw error;
    }
  });
  return app;
}
