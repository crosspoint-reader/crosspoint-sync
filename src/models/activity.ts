import type { DB } from '../db/db.js';
import { combineBookStats, type BookStatsSnapshot } from './stats.js';
import { resolveDocument, statsAliases, statsDocuments } from './merge.js';
import { readBookorbitStats } from './bookorbit-stats.js';

/**
 * Reading activity derived from the progress history, for readers that never
 * send stats (stock CrossPoint, KOReader). Pages are PRINT pages: percent of
 * the book times the print edition's page count - not screen pages.
 *
 * - A book's pages read = furthest percent reached x page count (so reading
 *   done before history began still counts toward totals).
 * - Per-day pages only count forward progress AFTER a book's first logged
 *   sync; otherwise the first sync of an old book would dump its whole history
 *   onto one day. Progress is a running max across devices, so device
 *   ping-pong and re-reads never double count.
 * - Every day with any sync counts as a reading day (`syncs`), even a book's
 *   first sync or one with no known page count: a sync means the book was open.
 * - Finished = first sync at >= 98%, unless a manual status says otherwise.
 *   A device-reported finish date (CrossInk stats) wins over the sync date,
 *   since a book can be finished offline and only synced days later.
 * - Start and finish dates the user set by hand win over everything else.
 */
export const FINISHED_AT = 0.98;

export interface LogRow {
  document: string;
  percentage: number;
  at: number;
}

export interface DocInfo {
  page_count: number | null;
  status: string | null;
  status_at: number | null;
  /** Dates the user set by hand: unix seconds at UTC midnight of the calendar day. */
  start_date?: number | null;
  finished_date?: number | null;
}

export interface BookActivity {
  document: string;
  started_at: number;
  last_at: number;
  percentage: number;
  finished_at: number | null;
  completed: boolean;
  page_count: number | null;
  pages_read: number | null;
  /** Calendar days from start to finish, counting both (a one-day read is 1). Null when
   *  unfinished, finished only by a manual status, or already finished on its first sync. */
  days_to_finish: number | null;
  /** Whether started_at / finished_at are dates the user set by hand. */
  start_manual: boolean;
  finish_manual: boolean;
}

export interface Activity {
  pages_total: number;
  books: BookActivity[];
  /** Reading-grid dates from syncs and a book's chosen start and finish days.
   *  These dates do not add pages, time, sessions, or syncs. */
  reading_days: string[];
  /** Local-day buckets (YYYY-MM-DD) with syncs, and print pages read that day, oldest first. */
  days: { day: string; pages: number; syncs: number; books: DayBook[] }[];
}

/** One book's activity on one day, for the timeline. `from`/`to` are the furthest
 *  position before and after that day's syncs (0..1). */
export interface DayBook {
  document: string;
  /** A chosen start date, independent of the first uploaded position. */
  started?: boolean;
  pages: number;
  syncs: number;
  from: number;
  to: number;
}

/**
 * `finishedDates` / `startDates`: device-reported dates (CrossInk `finished_date` /
 * `start_date`), unix seconds at UTC midnight of the device's local calendar date.
 */
export function computeActivity(
  rows: LogRow[],
  docs: Map<string, DocInfo>,
  tzOffsetMinutes = 0,
  finishedDates: Map<string, number> = new Map(),
  startDates: Map<string, number> = new Map()
): Activity {
  // Device dates are calendar dates: pin them to local noon in the client
  // timezone so they land on that same day however they're displayed.
  const localNoon = (date: number | undefined) => (date ? date + 12 * 3600 + tzOffsetMinutes * 60 : null);
  const byDoc = new Map<string, LogRow[]>();
  for (const r of rows) {
    const list = byDoc.get(r.document) ?? [];
    list.push(r);
    byDoc.set(r.document, list);
  }

  // Dates and completion can exist without a synced reader position.
  for (const [document, info] of docs) {
    if ((info.start_date || info.finished_date || info.status === 'finished' || startDates.has(document) || finishedDates.has(document)) && !byDoc.has(document)) {
      byDoc.set(document, []);
    }
  }

  const books: BookActivity[] = [];
  const readingDays = new Set<string>();
  const days = new Map<string, { pages: number; syncs: number; books: Map<string, DayBook> }>();
  // The day bucket for a sync, and this book's entry in it (opened at position `from`).
  const dayKey = (at: number) => new Date((at - tzOffsetMinutes * 60) * 1000).toISOString().slice(0, 10);
  const dayOf = (at: number, document: string, from: number) => {
    const key = dayKey(at);
    readingDays.add(key);
    let d = days.get(key);
    if (!d) days.set(key, (d = { pages: 0, syncs: 0, books: new Map() }));
    let b = d.books.get(document);
    if (!b) d.books.set(document, (b = { document, pages: 0, syncs: 0, from, to: from }));
    d.syncs++;
    b.syncs++;
    return { d, b };
  };
  let pagesTotal = 0;
  for (const [document, list] of byDoc) {
    list.sort((a, b) => a.at - b.at);
    const info = docs.get(document);
    const pageCount = info?.page_count ?? null;
    let max = list[0]?.percentage ?? 0;
    let logFinish = max >= FINISHED_AT ? list[0].at : null;
    if (list.length) dayOf(list[0].at, document, max);
    for (const r of list.slice(1)) {
      const { d, b } = dayOf(r.at, document, max);
      if (r.percentage <= max) continue;
      if (pageCount) {
        d.pages += (r.percentage - max) * pageCount;
        b.pages += (r.percentage - max) * pageCount;
      }
      max = r.percentage;
      b.to = max;
      if (logFinish === null && max >= FINISHED_AT) logFinish = r.at;
    }
    // A finish date the user set, else the device's.
    const manualFinish = localNoon(info?.finished_date ?? undefined);
    const datedFinish = manualFinish ?? localNoon(finishedDates.get(document));
    const finished =
      info?.status == null
        ? (datedFinish ?? logFinish)
        : info.status === 'finished'
          ? (datedFinish ?? logFinish ?? info.status_at)
          : null;
    // Finished offline on a day the book never synced: still give that day a
    // timeline entry (no syncs, so it isn't counted as a reading day).
    if (datedFinish !== null && finished === datedFinish) {
      const key = dayKey(datedFinish);
      let d = days.get(key);
      if (!d) days.set(key, (d = { pages: 0, syncs: 0, books: new Map() }));
      if (!d.books.has(document)) {
        const at = list.reduce((m, r) => (dayKey(r.at) <= key ? Math.max(m, r.percentage) : m), 0);
        d.books.set(document, { document, pages: 0, syncs: 0, from: at, to: at });
      }
    }
    const completed = info?.status === 'finished' || finished !== null;
    const pagesRead = pageCount ? (list.length ? Math.round(max * pageCount) : completed ? pageCount : null) : null;
    pagesTotal += pagesRead ?? 0;
    // A start date the user set, else CrossInk's when it comes before the first sync: a book is often
    // read before it ever syncs. A device that started later (another device opened it first) did not
    // start the book; the first sync did.
    const manualStart = localNoon(info?.start_date ?? undefined);
    const deviceStart = localNoon(startDates.get(document));
    const firstSync = list[0]?.at;
    const datedStart =
      manualStart ?? (deviceStart !== null && (firstSync === undefined || deviceStart <= firstSync) ? deviceStart : null);
    const started = datedStart ?? firstSync ?? 0;
    if (datedStart !== null) {
      const key = dayKey(datedStart);
      let d = days.get(key);
      if (!d) days.set(key, (d = { pages: 0, syncs: 0, books: new Map() }));
      let b = d.books.get(document);
      if (!b) d.books.set(document, (b = { document, pages: 0, syncs: 0, from: 0, to: 0 }));
      b.started = true;
    }
    // Explicit dates mark only their own days, without inventing daily progress.
    // Resolve each endpoint independently: manual -> CrossInk -> server history.
    if (datedStart !== null) readingDays.add(dayKey(datedStart));
    if (datedFinish !== null && finished === datedFinish) readingDays.add(dayKey(datedFinish));
    let daysToFinish: number | null = null;
    // A manual "finished" (status_at) marks when it was tapped, not when it was read.
    const realFinish = finished !== null && (finished === datedFinish || finished === logFinish);
    if (realFinish && started > 0 && (datedStart !== null || finished > started)) {
      const days = (Date.parse(dayKey(finished)) - Date.parse(dayKey(started))) / 86400000 + 1;
      if (days >= 1) daysToFinish = days;
    }
    books.push({
      document,
      started_at: started,
      last_at: list.at(-1)?.at ?? finished ?? datedStart ?? info?.status_at ?? 0,
      percentage: max,
      finished_at: finished,
      completed,
      page_count: pageCount,
      pages_read: pagesRead,
      days_to_finish: daysToFinish,
      start_manual: manualStart !== null,
      finish_manual: manualFinish !== null && finished === manualFinish,
    });
  }

  return {
    pages_total: pagesTotal,
    books: books.sort((a, b) => b.last_at - a.last_at),
    reading_days: [...readingDays].sort(),
    days: [...days]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, d]) => ({
        day,
        pages: Math.round(d.pages),
        syncs: d.syncs,
        books: [...d.books.values()].map((b) => ({ ...b, pages: Math.round(b.pages) })),
      })),
  };
}

/** A user's activity from the database: progress history, plus finish and start
 *  dates from device stats and reading days from a BookOrbit import. */
export function readingActivity(db: DB, userId: number, tz: number): Activity {
  const rows = db
    .prepare('SELECT document, percentage, at FROM progress_log WHERE user_id = ?')
    .all(userId) as unknown as LogRow[];
  const docs = new Map(
    (
      db
        .prepare('SELECT document, page_count, status, status_at, start_date, finished_date FROM documents WHERE user_id = ?')
        .all(userId) as unknown as (DocInfo & { document: string })[]
    ).map((d) => [d.document, d])
  );
  // CrossInk's own finish dates, combined across devices like /stats/books/:document.
  const merged = statsAliases(db, userId);
  const snapshotsByDoc = new Map<string, BookStatsSnapshot[]>();
  for (const r of db
    .prepare('SELECT document, payload FROM stats_device_book WHERE user_id = ?')
    .all(userId) as { document: string; payload: string }[]) {
    const document = merged.get(r.document) ?? r.document;
    const list = snapshotsByDoc.get(document) ?? [];
    list.push(JSON.parse(r.payload) as BookStatsSnapshot);
    snapshotsByDoc.set(document, list);
  }
  const finishedDates = new Map<string, number>();
  const startDates = new Map<string, number>();
  for (const [document, snapshots] of snapshotsByDoc) {
    const combined = combineBookStats(snapshots);
    if (combined.completed && combined.finished_date > 0) finishedDates.set(document, combined.finished_date);
    if (combined.start_date > 0) startDates.set(document, combined.start_date);
  }
  const activity = computeActivity(rows, docs, tz, finishedDates, startDates);
  const imported = readBookorbitStats(db, userId);
  activity.reading_days = [...new Set([...activity.reading_days, ...imported.daily.map((d) => d.date)])].sort();
  return activity;
}

/** One book's day: syncs and print pages from the progress history, and the seconds every device recorded. */
export interface BookActivityDay {
  day: string;
  syncs: number;
  pages: number;
  seconds: number;
  /** Furthest position before and after that day's syncs (0..1); 0 on a day with recorded time only. */
  from: number;
  to: number;
  /** A chosen start date, independent of the first uploaded position. */
  started?: boolean;
}

export interface BookActivityDetail extends BookActivity {
  /** Days with a sync, recorded time, or a chosen start or finish, oldest first. */
  reading_days: string[];
  days: BookActivityDay[];
}

/**
 * One book's activity, for a reader that wants the book's whole history without the account's:
 * the same dates and pages as {@link readingActivity}, plus each day's seconds from every device's
 * stats (merged copies and BookOrbit imports folded in, as `/stats/books/:document` combines them).
 * `document` may be any hash the book is known by. Null when the server knows nothing about it.
 */
export function bookActivity(db: DB, userId: number, tz: number, document: string): BookActivityDetail | null {
  const canonical = resolveDocument(db, userId, document);
  // Merging re-homes the progress history; stats stay under each copy's hash and combine on read.
  const statsDocs = statsDocuments(db, userId, canonical);
  const marks = statsDocs.map(() => '?').join(',');
  const rows = db
    .prepare('SELECT document, percentage, at FROM progress_log WHERE user_id = ? AND document = ?')
    .all(userId, canonical) as unknown as LogRow[];
  const info = db
    .prepare('SELECT page_count, status, status_at, start_date, finished_date FROM documents WHERE user_id = ? AND document = ?')
    .get(userId, canonical) as DocInfo | undefined;
  const snapshots = (
    db.prepare(`SELECT payload FROM stats_device_book WHERE user_id = ? AND document IN (${marks})`).all(userId, ...statsDocs) as {
      payload: string;
    }[]
  ).map((r) => JSON.parse(r.payload) as BookStatsSnapshot);
  const finishedDates = new Map<string, number>();
  const startDates = new Map<string, number>();
  if (snapshots.length) {
    const combined = combineBookStats(snapshots);
    if (combined.completed && combined.finished_date > 0) finishedDates.set(canonical, combined.finished_date);
    if (combined.start_date > 0) startDates.set(canonical, combined.start_date);
  }
  // Always this book: with no documents row, device-reported dates alone still make an entry.
  const docInfo: DocInfo = info ?? { page_count: null, status: null, status_at: null };
  const activity = computeActivity(rows, new Map([[canonical, docInfo]]), tz, finishedDates, startDates);

  const seconds = new Map<string, number>();
  const timed = db
    .prepare(`SELECT date, seconds FROM stats_device_book_day WHERE user_id = ? AND document IN (${marks})`)
    .all(userId, ...statsDocs) as { date: string; seconds: number }[];
  for (const d of [...timed, ...readBookorbitStats(db, userId, statsDocs).daily]) {
    seconds.set(d.date, (seconds.get(d.date) ?? 0) + Number(d.seconds));
  }
  // Sessions measure the same reading as the snapshots: per day the larger, as the overview counts it.
  const sessions = new Map<string, number>();
  for (const s of db
    .prepare(`SELECT started_at, utc_offset_minutes, seconds FROM reading_sessions WHERE user_id = ? AND document IN (${marks})`)
    .all(userId, ...statsDocs) as { started_at: number; utc_offset_minutes: number; seconds: number }[]) {
    const date = new Date((Number(s.started_at) + Number(s.utc_offset_minutes) * 60) * 1000).toISOString().slice(0, 10);
    sessions.set(date, (sessions.get(date) ?? 0) + Number(s.seconds));
  }
  for (const [date, s] of sessions) seconds.set(date, Math.max(seconds.get(date) ?? 0, s));
  const book = activity.books.find((b) => b.document === canonical);
  if (!book && seconds.size === 0) return null;

  const days = new Map<string, BookActivityDay>();
  for (const d of activity.days) {
    const b = d.books.find((x) => x.document === canonical);
    if (b) days.set(d.day, { day: d.day, syncs: b.syncs, pages: b.pages, seconds: 0, from: b.from, to: b.to, ...(b.started ? { started: true } : {}) });
  }
  for (const [day, s] of seconds) {
    const d = days.get(day);
    if (d) d.seconds = s;
    else days.set(day, { day, syncs: 0, pages: 0, seconds: s, from: 0, to: 0 });
  }
  const readingDays = new Set(activity.reading_days);
  for (const [day, s] of seconds) if (s > 0) readingDays.add(day);
  // Known only from recorded time: it started on the first day with any (local noon, as device dates are).
  const firstTimed = [...seconds.keys()].sort()[0];
  const timedStart = firstTimed ? Date.parse(`${firstTimed}T12:00:00Z`) / 1000 + tz * 60 : 0;
  return {
    ...(book ?? {
      document: canonical,
      started_at: timedStart,
      last_at: 0,
      percentage: 0,
      finished_at: null,
      completed: false,
      page_count: info?.page_count ?? null,
      pages_read: null,
      days_to_finish: null,
      start_manual: false,
      finish_manual: false,
    }),
    document: canonical,
    reading_days: [...readingDays].sort(),
    days: [...days.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}
