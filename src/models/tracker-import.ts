import { createHash } from 'node:crypto';
import { withTransaction, type DB } from '../db/db.js';
import { AccountImportError } from './account-data.js';
import { resolveDocument } from './merge.js';
import { parseCalendarDate, STATUSES } from '../routes/v1/documents.js';

const fail = (message: string): never => { throw new AccountImportError(message); };
const normalized = (s: string) => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
type Status = typeof STATUSES[number];
type TrackerBook = { source_id: string; title: string; author: string; isbn: string | null; user_rating: number | null;
  page_count: number | null; status: Status; start_date: string | null; finished_date: string | null };
export type Tracker = { source: 'Goodreads' | 'StoryGraph'; books: TrackerBook[]; skipped: number; warnings: string[] };

/** RFC 4180 quoting, including embedded newlines and doubled quotes; never evaluate cells. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false, closed = false;
  const field = () => { row.push(cell); cell = ''; closed = false; if (row.length > 100) fail('CSV has too many columns.'); };
  const record = () => { field(); if (row.some(v => v.trim())) rows.push(row); row = []; if (rows.length > 10_001) fail('Import at most 10,000 books at once.'); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') { quoted = false; closed = true; }
      else cell += c;
    } else if (c === ',') field();
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; record(); }
    else if (c === '"' && !cell && !closed) quoted = true;
    else {
      if (closed || c === '"') fail('Malformed CSV quoting. Export the file again.');
      cell += c;
    }
    if (cell.length > 256_000) fail('CSV cell exceeds 256,000 characters.');
  }
  if (quoted) fail('CSV contains an unclosed quoted field.');
  if (cell || row.length || closed) record();
  return rows;
}

/** Normalize valid ISBN-10 and ISBN-13 to ISBN-13, including Goodreads' ="..." wrapper. */
export function normalizeIsbn(value: string): string | null {
  let s = value.trim().replace(/^="([\dXx -]+)"$/, '$1').replace(/[ -]/g, '').toUpperCase();
  if (/^\d{9}[\dX]$/.test(s)) {
    if ([...s].reduce((n, c, i) => n + (10 - i) * (c === 'X' ? 10 : Number(c)), 0) % 11) return null;
    s = '978' + s.slice(0, 9);
    s += String((10 - [...s].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0) % 10) % 10);
  }
  if (!/^\d{13}$/.test(s) || [...s].reduce((n, c, i) => n + Number(c) * (i % 2 ? 3 : 1), 0) % 10) return null;
  return s;
}

function calendar(value: string, label: string, dayFirst = false): string | null {
  if (!value.trim()) return null;
  let date = value.trim();
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(date)) date = date.replaceAll('/', '-');
  else if (dayFirst && /^\d{2}\/\d{2}\/\d{4}$/.test(date)) date = date.split('/').reverse().join('-');
  if (parseCalendarDate(date) === undefined) fail(`Invalid ${label}: ${value}. Use a complete calendar date.`);
  return date;
}

export function readTrackerCsv(bytes: Buffer): Tracker {
  if (bytes.length > 10 * 1024 * 1024) fail('CSV imports are limited to 10 MB.');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return fail('Use a UTF-8 CSV export.'); }
  const [header, ...rows] = parseCsv(text.replace(/^\uFEFF/, ''));
  if (!header || new Set(header).size !== header.length) fail('Missing or duplicate CSV headers.');
  const has = (...names: string[]) => names.every(n => header.includes(n));
  const source = has('Book Id', 'Title', 'Author', 'Exclusive Shelf') ? 'Goodreads'
    : has('Title', 'Authors', 'ISBN/UID', 'Read Status') ? 'StoryGraph' : fail('Choose a Goodreads or StoryGraph CSV export.');
  const books: TrackerBook[] = [], warnings = new Set<string>(), seen = new Set<string>();
  let skipped = 0;
  for (const [index, cells] of rows.entries()) {
    if (cells.length !== header.length) fail(`CSV row ${index + 2} has the wrong number of columns.`);
    const r = Object.fromEntries(header.map((name, i) => [name, cells[i].trim()]));
    const shelf = (source === 'Goodreads' ? r['Exclusive Shelf'] : r['Read Status']).toLowerCase();
    if (shelf === 'to-read') { skipped++; continue; }
    const statuses: Record<string, Status> = { read: 'finished', 'currently-reading': 'reading', 'did-not-finish': 'dnf', dnf: 'dnf', paused: 'paused' };
    const status = statuses[shelf];
    if (!status) fail(`Unknown reading status on CSV row ${index + 2}: ${shelf || '(empty)'}.`);
    const title = r.Title, author = (source === 'Goodreads' ? r.Author : r.Authors) || '';
    if (!title || title.length > 4096 || author.length > 4096) fail(`Invalid title or author on CSV row ${index + 2}.`);
    const uid = source === 'Goodreads' ? r['Book Id'] : r['ISBN/UID'];
    if (source === 'Goodreads' && !/^\d{1,30}$/.test(uid)) fail(`Invalid Goodreads Book Id on CSV row ${index + 2}.`);
    const source_id = source === 'Goodreads' ? `goodreads.${uid}`
      : `storygraph.${createHash('sha256').update(uid || `${normalized(title)}\n${normalized(author)}`).digest('hex').slice(0, 40)}`;
    if (seen.has(source_id)) fail(`Duplicate book on CSV row ${index + 2}. Import each edition once.`);
    seen.add(source_id);
    const isbn = source === 'Goodreads' ? normalizeIsbn(r.ISBN13 || '') || normalizeIsbn(r.ISBN || '') : normalizeIsbn(uid);
    let start_date: string | null = null, finished_date: string | null = null;
    if (source === 'Goodreads') finished_date = calendar(r['Date Read'] || '', 'Date Read');
    else {
      const periods = (r['Dates Read'] || '').split(',').map(s => s.trim()).filter(Boolean).map(period => {
        const match = /^(\d{4}\/\d{2}\/\d{2})?\s*-\s*(\d{4}\/\d{2}\/\d{2})?$/.exec(period);
        if (!match) fail(`Unsupported Dates Read on CSV row ${index + 2}.`);
        const start = calendar(match![1] || '', 'start date'), finish = calendar(match![2] || '', 'finish date');
        if (start && finish && start > finish) fail(`Start date follows finish date on CSV row ${index + 2}.`);
        return { start, finish };
      });
      periods.sort((a, b) => (b.finish || b.start || '').localeCompare(a.finish || a.start || ''));
      const latest = status === 'reading' ? periods.find(p => !p.finish) : periods[0];
      start_date = latest?.start ?? null;
      finished_date = latest?.finish ?? calendar(r['Last Date Read'] || '', 'Last Date Read', true);
      if (periods.length > 1) warnings.add('For reread books, only the latest available reading period is imported.');
    }
    if (Number(r['Read Count']) > 1) warnings.add('For reread books, only the latest available reading period is imported.');
    if (status !== 'finished') finished_date = null;
    const rawRating = (source === 'Goodreads' ? r['My Rating'] : r['Star Rating']) || '';
    const user_rating = rawRating && !(source === 'Goodreads' && Number(rawRating) === 0) ? Number(rawRating) : null;
    if (user_rating !== null && (!/^\d(?:\.\d{1,2})?$/.test(rawRating) || user_rating < 0 || user_rating > 5)) fail(`Invalid rating on CSV row ${index + 2}.`);
    const rawPages = r['Number of Pages'] || '';
    const page_count = rawPages ? Number(rawPages) : null;
    if (page_count !== null && (!/^\d+$/.test(rawPages) || !Number.isSafeInteger(page_count) || page_count > 1_000_000)) fail(`Invalid page count on CSV row ${index + 2}.`);
    books.push({ source_id, title, author, isbn, user_rating, page_count: page_count || null, status, start_date, finished_date });
  }
  if (skipped) warnings.add(`${skipped} to-read books skipped: CrossPoint does not have a want-to-read shelf.`);
  return { source, books, skipped, warnings: [...warnings] };
}

export function trackerPreview(db: DB, userId: number, tracker: Tracker) {
  const library = db.prepare(`SELECT document, title, author, isbn FROM documents d WHERE user_id = ?
    AND NOT EXISTS (SELECT 1 FROM document_aliases a WHERE a.user_id = d.user_id AND a.alias = d.document) ORDER BY title`).all(userId) as { document: string; title: string | null; author: string | null; isbn: string | null }[];
  const byId = new Map(library.map(b => [b.document, b]));
  const books = tracker.books.map(b => {
    const known = resolveDocument(db, userId, b.source_id);
    const locked = byId.has(known);
    const isbnMatches = b.isbn ? library.filter(l => l.isbn === b.isbn) : [];
    const candidates = isbnMatches.length ? isbnMatches : library.filter(l => normalized(l.title || '') === normalized(b.title));
    return { ...b, target: locked ? known : isbnMatches.length === 1 ? isbnMatches[0].document : candidates.length ? '' : 'new', locked,
      candidates: candidates.map(l => ({ document: l.document, title: l.title, author: l.author })) };
  });
  return { kind: 'tracker' as const, source: tracker.source, books, skipped: tracker.skipped, warnings: tracker.warnings, library };
}

type Choice = { target: string | null; status: Status; start_date: string | null; finished_date: string | null };
export function importTracker(db: DB, userId: number, tracker: Tracker, input: unknown) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('Review the books before importing.');
  const choices = input as Record<string, Choice>;
  if (Object.keys(choices).length !== tracker.books.length) fail('Review every book before importing.');
  const targets = new Set<string>();
  const preview = trackerPreview(db, userId, tracker);
  const selected = preview.books.flatMap(b => {
    const choice = choices[b.source_id];
    if (!choice || typeof choice !== 'object') return fail('Missing book choice.');
    if (choice.target === null) return [];
    if (!STATUSES.includes(choice.status)) fail('Invalid reading status.');
    const start = parseCalendarDate(choice.start_date), finish = parseCalendarDate(choice.finished_date);
    if (start === undefined || finish === undefined || (start !== null && finish !== null && start > finish) || (choice.status !== 'finished' && finish !== null)) return fail('Invalid reading dates.');
    const document = choice.target === 'new' ? b.source_id : choice.target;
    if (typeof document !== 'string' || (choice.target !== 'new' && !preview.library.some(l => l.document === document))) fail('Choose a book in your own library or create a new book.');
    if (b.locked && document !== b.target) fail('This source book was already imported. Keep its existing match.');
    const stored = db.prepare('SELECT start_date, finished_date FROM documents WHERE user_id = ? AND document = ?').get(userId, document);
    const finalStart = stored?.start_date ?? start, finalFinish = stored?.finished_date ?? finish;
    if (finalStart != null && finalFinish != null && Number(finalStart) > Number(finalFinish)) fail('Imported dates conflict with saved reading dates. Adjust the dates or skip this book.');
    if (targets.has(document)) fail('Two rows match the same book. Skip one or choose separate editions.');
    targets.add(document);
    return [{ b, choice, document, start, finish }];
  });
  const now = Math.floor(Date.now() / 1000);
  withTransaction(db, () => {
    const insert = db.prepare(`INSERT INTO documents (user_id, document, title, author, isbn, user_rating, page_count, status, status_at, start_date, finished_date, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, document) DO UPDATE SET
      title = COALESCE(documents.title, excluded.title), author = COALESCE(documents.author, excluded.author),
      isbn = COALESCE(documents.isbn, excluded.isbn), user_rating = COALESCE(documents.user_rating, excluded.user_rating),
      page_count = COALESCE(documents.page_count, excluded.page_count), status = COALESCE(documents.status, excluded.status),
      status_at = CASE WHEN documents.status IS NULL THEN excluded.status_at ELSE documents.status_at END,
      start_date = COALESCE(documents.start_date, excluded.start_date), finished_date = COALESCE(documents.finished_date, excluded.finished_date)`);
    for (const { b, choice, document, start, finish } of selected) {
      insert.run(userId, document, b.title, b.author, b.isbn, b.user_rating, b.page_count, choice.status, choice.status === 'finished' ? null : now, start, finish, now);
      if (b.source_id !== document) db.prepare(`INSERT INTO document_aliases (user_id, alias, document, created_at, merge_stats) VALUES (?, ?, ?, ?, 0)
        ON CONFLICT(user_id, alias) DO NOTHING`).run(userId, b.source_id, document, now);
    }
  });
  return { books: selected.length, skipped: tracker.skipped + tracker.books.length - selected.length, imported_history: 0, preserved_history: 0 };
}
