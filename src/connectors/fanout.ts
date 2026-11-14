import type { DB } from '../db/db.js';
import { secretsEnabled } from '../crypto/secrets.js';
import { getConnector } from './registry.js';
import { enqueue } from './queue.js';
import { activeConnectorIds, carriesFor, documentMeta, getMatch } from './store.js';
import { extractTitleAuthor } from './matching.js';
import { nowSeconds } from '../models/sync.js';
import type { Connector, OutboundEvent } from './types.js';
import { combineBookStats, type BookStatsSnapshot } from '../models/stats.js';
import { resolveDocument, statsDocuments } from '../models/merge.js';
import { HISTORY_DEVICE } from '../models/koinsight-import.js';
import { scheduleMicroblogClippings } from './microblog-clippings.js';

/**
 * Whether it's worth attempting a document on this connector. Metadata-matched
 * services (Hardcover, BookFusion, Audiobookshelf) can only match a book we have
 * title/author for, so a document with no metadata and no existing match would
 * just dead-letter as "no book match" - skip it. Document-keyed connectors (a
 * kosync mirror) always apply. A manual "no match" override also skips.
 */
export function isAttemptable(db: DB, userId: number, conn: Connector, document: string): boolean {
  if (conn.matchBy === 'document') return true;
  const match = getMatch(db, userId, conn.id, document);
  if (match) {
    if (match.external_id != null) return true; // already matched
    if (match.source === 'manual') return false; // explicit "don't sync this"
  }
  // No usable match yet: only attempt if we have metadata to match on.
  return extractTitleAuthor(documentMeta(db, userId, document)) != null;
}

/**
 * Enqueue canonical reading events to every linked connector that carries the
 * event's kind. Best-effort and synchronous-but-cheap (DB inserts only); the
 * queue worker does the network I/O. Never throws into the request path.
 */
function fanOut(
  db: DB,
  userId: number,
  ev: OutboundEvent,
  coalesceKey?: string,
  exceptConnectorId?: string
): void {
  if (!secretsEnabled()) return;
  try {
    for (const connectorId of activeConnectorIds(db, userId)) {
      if (connectorId === 'microblog' && ev.kind === 'highlight') continue;
      if (connectorId === exceptConnectorId) continue; // loop suppression: don't echo to the source
      const conn = getConnector(connectorId);
      if (!conn || !conn.capabilities.write || !carriesFor(db, userId, conn, ev.kind)) continue;
      if (!isAttemptable(db, userId, conn, ev.document)) continue; // no metadata/match: skip
      enqueue(db, userId, connectorId, coalesceKey ? withFloor(db, userId, connectorId, ev, coalesceKey) : ev, coalesceKey);
    }
  } catch (err) {
    console.error(
      JSON.stringify({ msg: 'fanout enqueue failed', error: err instanceof Error ? err.message : String(err) })
    );
  }
}

export function fanOutProgress(
  db: DB,
  userId: number,
  document: string,
  percentage: number,
  timestamp: number,
  progress?: string,
  positionJson?: string | null,
  exceptConnectorId?: string
): void {
  try {
    scheduleMicroblogClippings(db, userId, document);
  } catch (err) {
    console.error(JSON.stringify({ msg: 'microblog schedule failed', user_id: userId, document,
      error: err instanceof Error ? err.message : String(err) }));
  }
  const finished = percentage >= 0.98;
  let position: Record<string, unknown> | null = null;
  if (positionJson) {
    try {
      position = JSON.parse(positionJson) as Record<string, unknown>;
    } catch {
      position = null;
    }
  }
  fanOut(
    db,
    userId,
    {
      kind: finished ? 'finished' : 'progress',
      document,
      percentage,
      progress,
      position,
      timestamp,
    },
    undefined,
    exceptConnectorId
  );
}

/** Clipping columns a highlight event is built from. */
export interface ClippingHighlightRow {
  text: string;
  note: string | null;
  created_at: number;
  spine_index: number;
  start_offset: number | null;
  end_offset: number | null;
  chapter_title: string;
}

export function highlightFromRow(
  r: ClippingHighlightRow,
  meta: { title: string | null; author: string | null }
): NonNullable<OutboundEvent['highlight']> {
  return {
    text: r.text,
    note: r.note,
    title: meta.title,
    author: meta.author,
    highlightedAt: r.created_at > 0 ? r.created_at : null,
    spine: r.spine_index,
    startOffset: r.start_offset,
    endOffset: r.end_offset,
    chapter: r.chapter_title || null,
  };
}

export function fanOutHighlight(
  db: DB,
  userId: number,
  document: string,
  clippingId: string,
  h: NonNullable<OutboundEvent['highlight']>,
  timestamp: number,
  exceptConnectorId?: string
): void {
  // Per-clipping coalesce key so distinct highlights on one book each queue.
  fanOut(db, userId, { kind: 'highlight', document, timestamp, highlight: h }, `highlight:${clippingId}`, exceptConnectorId);
}

export type StatsBaseline = NonNullable<NonNullable<OutboundEvent['stats']>['baseline']>;

/**
 * One source's running totals for a book as a reader sees them: every counter lifetime
 * of that device, across the book's stats-merged copies, under the canonical document
 * (the id progress is sent under). Sources are devices and the KOReader history import.
 */
export function bookStatsFor(
  db: DB,
  userId: number,
  document: string,
  deviceId: string
): { document: string; book: BookStatsSnapshot; updatedAt: number } | null {
  const canonical = resolveDocument(db, userId, document);
  const documents = statsDocuments(db, userId, canonical);
  const rows = db
    .prepare(
      `SELECT payload, updated_at FROM stats_device_book
       WHERE user_id = ? AND device_id = ? AND document IN (${documents.map(() => '?').join(',')})
       ORDER BY updated_at`
    )
    .all(userId, deviceId, ...documents) as { payload: string; updated_at: number }[];
  const snapshots: BookStatsSnapshot[] = [];
  let updatedAt = 0;
  for (const r of rows) {
    try {
      snapshots.push(JSON.parse(r.payload) as BookStatsSnapshot);
      updatedAt = Math.max(updatedAt, Number(r.updated_at));
    } catch {
      // A row that does not parse is left out; the rest still add up.
    }
  }
  if (!snapshots.length) return null;
  const book = {
    ...snapshots[snapshots.length - 1],
    ...combineBookStats(snapshots),
    pace_n: snapshots.reduce((n, s) => n + s.pace_n, 0),
  };
  return { document: canonical, book, updatedAt };
}

/** A source's total as it stood, to measure the next upload from. */
export function statsSince(totals: { book: BookStatsSnapshot; updatedAt: number } | null): StatsBaseline | undefined {
  return totals ? { seconds: totals.book.seconds, pages: totals.book.pages, at: totals.updatedAt } : undefined;
}

const statsKey = (deviceId: string) => `stats:${deviceId}`;
const between = (n: number, low: number, high: number) => Math.min(Math.max(n, low), high);

/**
 * Settles, for one connector, the point a stats event's new reading is measured from.
 *
 * Every event has a floor: its history (`baseline`, which is sent) or the source's total
 * before the upload (`since`, which is not). A stats event replaces the pending one for
 * its source, so whatever the pending event had not delivered yet is carried over: its
 * history stays history, and reading it was about to report stays above the floor, so
 * neither a retry nor a later upload can turn one into the other. A dead-lettered event
 * is carried the same way.
 *
 * A source this connector has never been sent, but which already had a total here (it
 * was read on before the link), starts from that total, so what the upload adds is
 * credited instead of being used up as the starting point.
 */
function withFloor(db: DB, userId: number, connectorId: string, ev: OutboundEvent, key: string): OutboundEvent {
  const stats = ev.stats;
  if (!stats) return ev;
  const row = db
    .prepare(
      `SELECT payload, status FROM connector_queue
       WHERE user_id = ? AND connector_id = ? AND document = ? AND kind = ?`
    )
    .get(userId, connectorId, ev.document, key) as { payload: string; status: string } | undefined;
  if (!row) {
    if (stats.baseline || !stats.since || stats.since.seconds > stats.book.seconds) return ev;
    return { ...ev, stats: { ...stats, baseline: stats.since, since: undefined } };
  }
  let last: OutboundEvent | undefined;
  try {
    last = JSON.parse(row.payload) as OutboundEvent;
  } catch {
    last = undefined;
  }
  const waiting = last?.stats;
  if (row.status === 'done') {
    // The total grew without an upload (a copy with its own stats was merged in, a
    // history file was imported): what was added that way is history.
    if (stats.baseline || !stats.since || !waiting || stats.since.seconds <= waiting.book.seconds) return ev;
    return { ...ev, stats: { ...stats, baseline: stats.since, since: undefined } };
  }
  if (!last || !waiting) return ev;
  // A waiting event with no floor is the source's first total, which the service takes as
  // its starting point: it is kept as history so the reading after it is still credited.
  const first = !waiting.baseline && !waiting.since;
  const theirs = waiting.baseline ?? waiting.since
    ?? { seconds: waiting.book.seconds, pages: waiting.book.pages, at: last.timestamp };
  const mine = stats.baseline ?? stats.since ?? { seconds: stats.book.seconds, pages: stats.book.pages, at: ev.timestamp };
  const floor: StatsBaseline = {
    seconds: between(mine.seconds - Math.max(0, waiting.book.seconds - theirs.seconds), 0, stats.book.seconds),
    pages: between(mine.pages - Math.max(0, waiting.book.pages - theirs.pages), 0, stats.book.pages),
    at: Math.min(theirs.at, mine.at),
  };
  return stats.baseline || waiting.baseline || first
    ? { ...ev, stats: { ...stats, baseline: floor, since: undefined } }
    : { ...ev, stats: { ...stats, since: floor } };
}

/**
 * Send one source's current total for a book to every connector that carries stats.
 * Call after the write commits. `baseline` marks how much of the total is history, and
 * `since` is the source's total before this upload.
 */
export function fanOutBookStats(
  db: DB,
  userId: number,
  document: string,
  deviceId: string,
  device: string,
  timestamp: number,
  baseline?: StatsBaseline,
  since?: StatsBaseline
): void {
  const totals = bookStatsFor(db, userId, document, deviceId);
  if (!totals) return;
  // Totals replace the same source's earlier snapshot, but two sources on one book must not overwrite each other.
  fanOut(
    db,
    userId,
    { kind: 'stats', document: totals.document, timestamp, stats: { deviceId, device, book: totals.book, baseline, since } },
    statsKey(deviceId)
  );
}

/**
 * Backfill a single connector with everything already synced ("Sync now").
 * Enqueues the latest progress per document (and highlights, if it carries
 * them) so a freshly linked service catches up on your history. Coalesce keys
 * match live fan-out, so a later real sync collapses onto the backfilled event.
 * Returns the number of items queued.
 */
export function backfillConnector(db: DB, userId: number, connectorId: string, document?: string): number {
  if (!secretsEnabled()) return 0;
  const conn = getConnector(connectorId);
  if (!conn || !conn.capabilities.write) return 0;
  let queued = 0;

  if (carriesFor(db, userId, conn, 'progress') || carriesFor(db, userId, conn, 'finished')) {
    const rows = db
      .prepare(
        `SELECT p.document, p.percentage, p.progress, p.position, p.updated_at
         FROM progress p
         WHERE p.user_id = ?
           AND p.updated_at = (
             SELECT MAX(p2.updated_at) FROM progress p2
             WHERE p2.user_id = p.user_id AND p2.document = p.document
           )
           AND p.device_id = (
             SELECT MIN(p3.device_id) FROM progress p3
             WHERE p3.user_id = p.user_id AND p3.document = p.document
               AND p3.updated_at = p.updated_at
           )`
      )
      .all(userId) as {
      document: string;
      percentage: number;
      progress: string;
      position: string | null;
      updated_at: number;
    }[];
    for (const r of rows) {
      if (document && r.document !== document) continue;
      const finished = r.percentage >= 0.98;
      const kind = finished ? 'finished' : 'progress';
      if (!carriesFor(db, userId, conn, kind)) continue;
      if (!isAttemptable(db, userId, conn, r.document)) continue; // no metadata/match: skip
      let position: Record<string, unknown> | null = null;
      if (r.position) {
        try {
          position = JSON.parse(r.position) as Record<string, unknown>;
        } catch {
          position = null;
        }
      }
      enqueue(db, userId, connectorId, {
        kind,
        document: r.document,
        percentage: r.percentage,
        progress: r.progress,
        position,
        timestamp: r.updated_at,
      });
      queued++;
    }
  }

  if (carriesFor(db, userId, conn, 'stats')) {
    // Totals from before the link are history: sent once as the starting point, so the
    // next upload is credited for what it adds instead of being used up as the baseline.
    const sources = db
      .prepare('SELECT DISTINCT device_id, document FROM stats_device_book WHERE user_id = ?')
      .all(userId) as { device_id: string; document: string }[];
    const labels = new Map(
      (db.prepare('SELECT device_id, device FROM stats_device_global WHERE user_id = ?').all(userId) as {
        device_id: string;
        device: string;
      }[]).map((r) => [r.device_id, r.device])
    );
    const waiting = db.prepare(
      `SELECT 1 FROM connector_queue
       WHERE user_id = ? AND connector_id = ? AND document = ? AND kind = ? AND status = 'pending'`
    );
    const now = nowSeconds();
    const seen = new Set<string>();
    for (const s of sources) {
      const totals = bookStatsFor(db, userId, s.document, s.device_id);
      if (!totals || (document && totals.document !== document)) continue;
      const key = statsKey(s.device_id);
      if (seen.has(`${key}:${totals.document}`)) continue;
      seen.add(`${key}:${totals.document}`);
      // An update already on its way carries its own boundary; replacing it would lose it.
      if (waiting.get(userId, connectorId, totals.document, key)) continue;
      if (!isAttemptable(db, userId, conn, totals.document)) continue;
      const { seconds, pages } = totals.book;
      // A dead-lettered event is sent again from the floor it had, so reading it never
      // delivered is still credited; anything else is history up to the current total.
      enqueue(
        db,
        userId,
        connectorId,
        withFloor(
          db,
          userId,
          connectorId,
          {
            kind: 'stats',
            document: totals.document,
            timestamp: now,
            stats: {
              deviceId: s.device_id,
              device: s.device_id === HISTORY_DEVICE ? 'KOReader' : labels.get(s.device_id) ?? '',
              book: totals.book,
              baseline: { seconds, pages, at: now },
            },
          },
          key
        ),
        key
      );
      queued++;
    }
  }

  if (connectorId === 'microblog') queued += scheduleMicroblogClippings(db, userId, document);
  if (connectorId !== 'microblog' && carriesFor(db, userId, conn, 'highlight')) {
    const rows = db
      .prepare(
        `SELECT c.id, c.document, c.text, c.note, c.created_at, c.spine_index, c.start_offset, c.end_offset,
                c.chapter_title, d.title, d.author
         FROM clippings c
         LEFT JOIN documents d ON d.user_id = c.user_id AND d.document = c.document
         WHERE c.user_id = ? AND c.deleted = 0`
      )
      .all(userId) as unknown as (ClippingHighlightRow & { id: string; document: string; title: string | null; author: string | null })[];
    for (const r of rows) {
      if (document && r.document !== document) continue;
      enqueue(
        db,
        userId,
        connectorId,
        {
          kind: 'highlight',
          document: r.document,
          timestamp: r.created_at || nowSeconds(),
          highlight: highlightFromRow(r, r),
        },
        `highlight:${r.id}`
      );
      queued++;
    }
  }

  return queued;
}
