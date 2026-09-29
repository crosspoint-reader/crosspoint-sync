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
 * - Finished = first sync at >= 98%, unless a manual status says otherwise.
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
}

export interface BookActivity {
  document: string;
  started_at: number;
  last_at: number;
  percentage: number;
  finished_at: number | null;
  page_count: number | null;
  pages_read: number | null;
}

export interface Activity {
  pages_total: number;
  books: BookActivity[];
  /** Local-day buckets (YYYY-MM-DD) of print pages read, oldest first. */
  days: { day: string; pages: number }[];
}

export function computeActivity(rows: LogRow[], docs: Map<string, DocInfo>, tzOffsetMinutes = 0): Activity {
  const byDoc = new Map<string, LogRow[]>();
  for (const r of rows) {
    const list = byDoc.get(r.document) ?? [];
    list.push(r);
    byDoc.set(r.document, list);
  }

  const books: BookActivity[] = [];
  const days = new Map<string, number>();
  let pagesTotal = 0;
  for (const [document, list] of byDoc) {
    list.sort((a, b) => a.at - b.at);
    const info = docs.get(document);
    const pageCount = info?.page_count ?? null;
    let max = list[0].percentage;
    let logFinish = max >= FINISHED_AT ? list[0].at : null;
    for (const r of list.slice(1)) {
      if (r.percentage <= max) continue;
      if (pageCount) {
        const day = new Date((r.at - tzOffsetMinutes * 60) * 1000).toISOString().slice(0, 10);
        days.set(day, (days.get(day) ?? 0) + (r.percentage - max) * pageCount);
      }
      max = r.percentage;
      if (logFinish === null && max >= FINISHED_AT) logFinish = r.at;
    }
    const finished =
      info?.status == null ? logFinish : info.status === 'finished' ? (logFinish ?? info.status_at) : null;
    const pagesRead = pageCount ? Math.round(max * pageCount) : null;
    pagesTotal += pagesRead ?? 0;
    books.push({
      document,
      started_at: list[0].at,
      last_at: list[list.length - 1].at,
      percentage: max,
      finished_at: finished,
      page_count: pageCount,
      pages_read: pagesRead,
    });
  }

  return {
    pages_total: pagesTotal,
    books: books.sort((a, b) => b.last_at - a.last_at),
    days: [...days]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, pages]) => ({ day, pages: Math.round(pages) })),
  };
}
