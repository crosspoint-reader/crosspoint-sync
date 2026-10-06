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
    let max = list[0].percentage;
    let logFinish = max >= FINISHED_AT ? list[0].at : null;
    dayOf(list[0].at, document, max);
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
    const pagesRead = pageCount ? Math.round(max * pageCount) : null;
    pagesTotal += pagesRead ?? 0;
    // A start date the user set, else CrossInk's: a book is often read before it ever syncs.
    const manualStart = localNoon(info?.start_date ?? undefined);
    const datedStart = manualStart ?? localNoon(startDates.get(document));
    const started = datedStart ?? list[0].at;
    // Explicit dates mark only their own days, without inventing daily progress.
    // Resolve each endpoint independently: manual -> CrossInk -> server history.
    if (datedStart !== null) readingDays.add(dayKey(datedStart));
    if (datedFinish !== null && finished === datedFinish) readingDays.add(dayKey(datedFinish));
    let daysToFinish: number | null = null;
    // A manual "finished" (status_at) marks when it was tapped, not when it was read.
    const realFinish = finished !== null && (finished === datedFinish || finished === logFinish);
    if (realFinish && (datedStart !== null || finished > started)) {
      const days = (Date.parse(dayKey(finished)) - Date.parse(dayKey(started))) / 86400000 + 1;
      if (days >= 1) daysToFinish = days;
    }
    books.push({
      document,
      started_at: started,
      last_at: list[list.length - 1].at,
      percentage: max,
      finished_at: finished,
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
