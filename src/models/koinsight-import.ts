import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { fromBufferPromise } from 'yauzl';
import { withTransaction, type DB } from '../db/db.js';
import { AccountImportError } from './account-data.js';
import { resolveDocument, statsDocuments } from './merge.js';
import { combineBookStats, HISTORY_BYTES, HISTORY_DAYS, type BookStatsSnapshot } from './stats.js';

export const MAX_HISTORY_FILE = 50 * 1024 * 1024;
const DEVICE = 'import:koinsight';
const MAX_ROWS = 200_000;
const fail = (message: string): never => { throw new AccountImportError(message); };
type Page = { book_md5: string; page: number; total_pages: number; start_time: number; duration: number };
type Book = { md5: string; title: string | null; authors: string | null; reference_pages: number | null };
export type History = { books: Book[]; pages: Page[]; source?: 'KOInsight' | 'KOReader' };

function readDatabase(bytes: Buffer, path: string): History | null {
  if (bytes.subarray(0, 16).toString() !== 'SQLite format 3\0') return null;
  const source = new DatabaseSync(path, { readOnly: true, enableForeignKeyConstraints: false });
  try {
    source.exec('PRAGMA trusted_schema = OFF; PRAGMA query_only = ON');
    const schema = source.prepare("SELECT name, type, sql FROM sqlite_master WHERE name IN ('book', 'page_stat', 'page_stat_data')").all();
    const native = schema.some(t => t.name === 'page_stat_data');
    const names = native ? ['book', 'page_stat_data'] : ['book', 'page_stat'];
    const tables = schema.filter(t => names.includes(String(t.name)));
    if (tables.length !== 2) return null;
    if (tables.some(t => t.type !== 'table' || !/^CREATE TABLE\s/i.test(String(t.sql)))) fail('Expected ordinary reading-history tables.');
    // KOReader's page_stat is a calculated view; read its bounded raw table instead.
    const books = source.prepare(native
      ? 'SELECT DISTINCT md5, title, authors, NULL AS reference_pages FROM book LIMIT 10001'
      : 'SELECT md5, title, authors, reference_pages FROM book WHERE COALESCE(soft_deleted, 0) = 0 LIMIT 10001').all() as unknown as Book[];
    const pages = source.prepare(native
      ? `SELECT b.md5 AS book_md5, p.page, p.total_pages, p.start_time, p.duration FROM page_stat_data p JOIN book b ON b.id = p.id_book LIMIT ${MAX_ROWS + 1}`
      : `SELECT book_md5, page, total_pages, start_time, duration FROM page_stat LIMIT ${MAX_ROWS + 1}`).all() as unknown as Page[];
    if (!books.length || books.length > 10_000 || pages.length > MAX_ROWS) fail('Use a KOInsight or KOReader database with 1–10,000 books and at most 200,000 page records.');
    const hashes = new Set<string>();
    for (const b of books) {
      if (typeof b.md5 !== 'string' || !/^[a-f0-9]{32}$/i.test(b.md5) || (!native && hashes.has(b.md5))) fail('Invalid or duplicate KOInsight book identifier.');
      hashes.add(b.md5);
      if ([b.title, b.authors].some(v => v !== null && (typeof v !== 'string' || v.length > 4096))) fail('Invalid book metadata.');
      if (b.reference_pages !== null && (!Number.isSafeInteger(b.reference_pages) || b.reference_pages < 0 || b.reference_pages > 1_000_000)) fail('Invalid page count.');
    }
    for (const p of pages) {
      if (typeof p.book_md5 !== 'string' || ![p.page, p.total_pages, p.start_time, p.duration].every(Number.isSafeInteger) ||
          p.page < 0 || p.total_pages < 0 || p.total_pages > 1_000_000 || p.page > p.total_pages ||
          p.start_time < 946684800 || p.start_time > 4102444799 || p.duration < 0 || p.duration > 86400) fail('Invalid KOInsight page history. Nothing was imported.');
    }
    const uniqueBooks = [...new Map(books.map(b => [b.md5, b])).values()];
    const validPages = pages.filter(p => hashes.has(p.book_md5) && p.total_pages > 0);
    const uniquePages = new Map<string, Page>();
    for (const p of validPages) {
      const key = `${p.book_md5}:${p.page}:${p.total_pages}:${p.start_time}`;
      if (!uniquePages.has(key) || uniquePages.get(key)!.duration < p.duration) uniquePages.set(key, p);
    }
    return { books: uniqueBooks, pages: native ? [...uniquePages.values()] : validPages, source: native ? 'KOReader' : 'KOInsight' };
  } finally { source.close(); }
}

/** Read only known tables, never execute uploaded SQL or extract archive paths. */
export async function readHistoryFile(bytes: Buffer): Promise<History> {
  if (!bytes.length || bytes.length > MAX_HISTORY_FILE) fail('Choose a file no larger than 50 MB.');
  const dir = await mkdtemp(join(tmpdir(), 'crosspoint-history-'));
  const path = join(dir, 'source.sqlite');
  const read = async (data: Buffer) => {
    await writeFile(path, data, { mode: 0o600 });
    return readDatabase(data, path);
  };
  try {
    if (bytes.subarray(0, 2).toString() !== 'PK') {
      return (await read(bytes)) ?? fail('Choose a KOInsight or KOReader SQLite database or a ZIP containing one.');
    }
    const zip = await fromBufferPromise(bytes, { lazyEntries: true, strictFileNames: true });
    let history: History | null = null;
    let entries = 0;
    let expanded = 0;
    try {
      for await (const entry of zip.eachEntry()) {
        if (++entries > 100) fail('ZIP contains too many files (maximum 100).');
        if (!/\.(sqlite3?|db)$/i.test(entry.fileName)) continue;
        if (entry.uncompressedSize > MAX_HISTORY_FILE || expanded + entry.uncompressedSize > MAX_HISTORY_FILE * 2) fail('Databases in the ZIP are too large.');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of await zip.openReadStreamPromise(entry)) {
          size += chunk.length;
          if (size > MAX_HISTORY_FILE || expanded + size > MAX_HISTORY_FILE * 2) fail('Databases in the ZIP are too large.');
          chunks.push(chunk);
        }
        expanded += size;
        const data = Buffer.concat(chunks);
        if (crc32(data) !== entry.crc32) fail('ZIP checksum mismatch. Upload a fresh copy.');
        const candidate = await read(data);
        if (candidate && history) fail('ZIP contains multiple reading-history databases. Upload just one.');
        if (candidate) history = candidate;
      }
    } finally { zip.close(); }
    return history ?? fail('No supported KOInsight or KOReader database found in the ZIP.');
  } catch (error) {
    if (error instanceof AccountImportError) throw error;
    return fail('Could not read this KOInsight or KOReader database or ZIP. Export a complete, closed database and try again.');
  } finally { await rm(dir, { recursive: true, force: true }); }
}

function dateFormatter(timezone: string) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); }
  catch { return fail('Choose a valid time zone.'); }
}
const midnight = (date: string) => Date.parse(`${date}T00:00:00Z`) / 1000;
const isoDate = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

export function prepareHistory(db: DB, userId: number, history: History, timezone: string) {
  const formatter = dateFormatter(timezone);
  const local = (at: number) => {
    const parts = Object.fromEntries(formatter.formatToParts(at * 1000).map(p => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
  };
  const grouped = new Map<string, { book: Book; pages: Page[] }>();
  const documents = new Map<string, string>();
  for (const book of history.books) {
    const document = resolveDocument(db, userId, book.md5);
    documents.set(book.md5, document);
    if (!grouped.has(document)) grouped.set(document, { book, pages: [] });
  }
  for (const page of history.pages) grouped.get(documents.get(page.book_md5)!)?.pages.push(page);
  return [...grouped].map(([document, { book, pages }]) => {
    pages.sort((a, b) => a.start_time - b.start_time);
    const daily = new Map<string, number>();
    const snapshot: BookStatsSnapshot = { v: 5, sessions: 0, seconds: 0, pages: 0, completed: false, avg_fwd: 0, pace_n: 0, eta: 0,
      start_manual: false, finish_manual: false, start_date: 0, finished_date: 0, tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0] };
    let end = 0;
    for (const p of pages) {
      const { date, hour } = local(p.start_time);
      // shortcut: page records separated by over five minutes start a session; use explicit sessions if KOInsight exports them.
      if (!end || p.start_time > end + 300) snapshot.sessions++;
      end = Math.max(end, p.start_time + p.duration);
      snapshot.seconds += p.duration;
      snapshot.pages++;
      snapshot.tod[hour >= 5 && hour < 12 ? 0 : hour < 17 && hour >= 12 ? 1 : hour < 21 && hour >= 17 ? 2 : 3] += p.duration;
      snapshot.dow[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7] += p.duration;
      daily.set(date, (daily.get(date) ?? 0) + p.duration);
      if (!snapshot.start_date) snapshot.start_date = midnight(date);
      if (!snapshot.finished_date && p.page / p.total_pages >= 0.98) {
        snapshot.completed = true;
        snapshot.finished_date = midnight(date);
      }
    }
    const existing = statsDocuments(db, userId, document).flatMap(id => db.prepare('SELECT device_id, payload FROM stats_device_book WHERE user_id = ? AND document = ?').all(userId, id)) as { device_id: string; payload: string }[];
    const combined = combineBookStats(existing.map(r => JSON.parse(r.payload)));
    const metadata = db.prepare('SELECT status, start_date, finished_date FROM documents WHERE user_id = ? AND document = ?').get(userId, document);
    const finish = Number(metadata?.finished_date) || (existing.length ? combined.finished_date : snapshot.finished_date);
    const start = Number(metadata?.start_date) || combined.start_date || snapshot.start_date;
    return { document, title: book.title || book.md5, author: book.authors, page_count: book.reference_pages || null, pages, daily, snapshot,
      existing_history: existing.some(r => r.device_id !== DEVICE),
      start_date: start ? isoDate(start) : null,
      finished_date: finish ? isoDate(finish) : null,
      completed: metadata?.status != null ? metadata.status === 'finished' : existing.length ? combined.completed : snapshot.completed,
      status: metadata?.status ?? null };
  });
}

export function historyPreview(prepared: ReturnType<typeof prepareHistory>) {
  return { books: prepared.map(({ document, title, author, start_date, finished_date, completed, existing_history, status, pages }) =>
    ({ document, title, author, start_date, finished_date, completed, existing_history, status, records: pages.length })) };
}

export function importHistory(db: DB, userId: number, prepared: ReturnType<typeof prepareHistory>, finishes: unknown) {
  if (!finishes || typeof finishes !== 'object' || Array.isArray(finishes)) fail('Review the finished books before importing.');
  const dates = finishes as Record<string, unknown>;
  if (Object.keys(dates).length !== prepared.length) fail('Review every book before importing.');
  for (const book of prepared) {
    const date = dates[book.document];
    if (date !== null && (typeof date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(midnight(date)) || isoDate(midnight(date)) !== date || (book.start_date && date < book.start_date))) fail('Finish dates must be valid calendar dates on or after the start date.');
  }
  const now = Math.floor(Date.now() / 1000);
  let importedHistory = 0;
  withTransaction(db, () => {
    const metadata = db.prepare(`INSERT INTO documents (user_id, document, title, author, page_count, updated_at, status, status_at, start_date, finished_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, document) DO UPDATE SET
      title = COALESCE(documents.title, excluded.title), author = COALESCE(documents.author, excluded.author),
      page_count = COALESCE(documents.page_count, excluded.page_count),
      status = COALESCE(documents.status, excluded.status), status_at = COALESCE(documents.status_at, excluded.status_at),
      start_date = COALESCE(documents.start_date, excluded.start_date), finished_date = COALESCE(documents.finished_date, excluded.finished_date)`);
    const log = db.prepare(`INSERT INTO progress_log (user_id, document, device_id, percentage, at)
      SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM progress_log WHERE user_id = ? AND document = ? AND at = ? AND percentage = ?)`);
    for (const b of prepared) {
      const finished = dates[b.document] as string | null;
      const hasProgress = db.prepare('SELECT 1 FROM progress WHERE user_id = ? AND document = ? LIMIT 1').get(userId, b.document);
      metadata.run(userId, b.document, b.title, b.author, b.page_count, now, finished ? 'finished' : hasProgress ? 'reading' : 'paused',
        finished ? midnight(finished) + 43200 : b.pages.at(-1)?.start_time ?? now, b.start_date ? midnight(b.start_date) : null, finished ? midnight(finished) : null);
      if (b.existing_history) {
        if (!db.prepare('SELECT 1 FROM progress_log WHERE user_id = ? AND document = ? LIMIT 1').get(userId, b.document)) {
          for (const p of b.pages) log.run(userId, b.document, DEVICE, p.page / p.total_pages, p.start_time, userId, b.document, p.start_time, p.page / p.total_pages);
        }
        continue;
      }
      importedHistory++;
      for (const alias of statsDocuments(db, userId, b.document).slice(1)) {
        db.prepare('DELETE FROM stats_device_book WHERE user_id = ? AND document = ? AND device_id = ?').run(userId, alias, DEVICE);
        db.prepare('DELETE FROM stats_device_book_day WHERE user_id = ? AND document = ? AND device_id = ?').run(userId, alias, DEVICE);
      }
      b.snapshot.completed = finished !== null;
      b.snapshot.finished_date = finished ? midnight(finished) : 0;
      db.prepare('DELETE FROM progress_log WHERE user_id = ? AND document = ? AND device_id = ?').run(userId, b.document, DEVICE);
      for (const p of b.pages) log.run(userId, b.document, DEVICE, p.page / p.total_pages, p.start_time, userId, b.document, p.start_time, p.page / p.total_pages);
      db.prepare(`INSERT INTO stats_device_book (user_id, device_id, document, payload, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, device_id, document) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`).run(userId, DEVICE, b.document, JSON.stringify(b.snapshot), now);
      db.prepare('DELETE FROM stats_device_book_day WHERE user_id = ? AND document = ? AND device_id = ?').run(userId, b.document, DEVICE);
      const day = db.prepare('INSERT INTO stats_device_book_day (user_id, device_id, document, date, seconds, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
      for (const [date, seconds] of b.daily) day.run(userId, DEVICE, b.document, date, seconds, now);
    }
    // Rebuild only this importer’s aggregate, including books from previous uploads.
    const snapshots = db.prepare('SELECT payload FROM stats_device_book WHERE user_id = ? AND device_id = ?').all(userId, DEVICE).map(r => JSON.parse(String(r.payload)) as BookStatsSnapshot);
    if (snapshots.length) {
      const totals = combineBookStats(snapshots);
      const daily = db.prepare('SELECT date, SUM(seconds) AS seconds FROM stats_device_book_day WHERE user_id = ? AND device_id = ? GROUP BY date ORDER BY date').all(userId, DEVICE) as { date: string; seconds: number }[];
      const epoch = midnight('2000-01-01');
      const days = daily.map(d => (midnight(d.date) - epoch) / 86400);
      const anchor = days.at(-1) ?? 0;
      const bits = Buffer.alloc(HISTORY_BYTES);
      let streak = 0, longest = 0, previous = -2;
      for (const day of days) {
        const offset = anchor - day;
        if (offset < HISTORY_DAYS) bits[offset >> 3] |= 1 << (offset & 7);
        streak = day === previous + 1 ? streak + 1 : 1;
        longest = Math.max(longest, streak);
        previous = day;
      }
      const global = { v: 5, sessions: totals.sessions, seconds: totals.seconds, pages: totals.pages, completed: snapshots.filter(s => s.completed).length,
        tod: totals.tod, dow: totals.dow, anchor_day: anchor, history_b64: bits.toString('base64'), streak: longest };
      db.prepare(`INSERT INTO stats_device_global (user_id, device_id, device, payload, updated_at) VALUES (?, ?, 'Reader history import', ?, ?)
        ON CONFLICT(user_id, device_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`).run(userId, DEVICE, JSON.stringify(global), now);
      db.prepare('DELETE FROM stats_device_day WHERE user_id = ? AND device_id = ?').run(userId, DEVICE);
      const day = db.prepare('INSERT INTO stats_device_day (user_id, device_id, date, seconds, updated_at) VALUES (?, ?, ?, ?, ?)');
      for (const d of daily) day.run(userId, DEVICE, d.date, d.seconds, now);
    }
  });
  return { books: prepared.length, imported_history: importedHistory, preserved_history: prepared.length - importedHistory };
}
