import { withTransaction, type DB } from '../db/db.js';
import { nowSeconds } from '../models/sync.js';
import type { OutboundEvent } from './types.js';

/**
 * Coalescing retry queue for connector fan-out. One pending row per
 * (user, connector, document, kind): a newer event of the same kind replaces
 * the older pending one, so bursts of progress syncs collapse to the latest.
 */

const MAX_ATTEMPTS = 8;
// Exponential backoff in seconds, capped; index by attempt count.
const BACKOFF = [30, 120, 300, 900, 3600, 10800, 43200, 86400];

export interface QueueRow {
  id: number;
  user_id: number;
  connector_id: string;
  document: string;
  kind: string;
  payload: string;
  attempts: number;
  status: string;
  next_try_at: number;
  last_error: string | null;
}

/**
 * Enqueue an event. The queue `kind` column doubles as the coalescing key: a
 * later event with the same (user, connector, document, kind) replaces the
 * pending one. Progress uses the bare event kind (collapse bursts to latest);
 * highlights pass a per-item coalesceKey so distinct highlights on the same book
 * don't overwrite each other. The stored payload always carries the real
 * OutboundEvent, whose `.kind` drives connector dispatch.
 */
export function enqueue(
  db: DB,
  userId: number,
  connectorId: string,
  ev: OutboundEvent,
  coalesceKey: string = ev.kind,
  now = nowSeconds()
): void {
  db.prepare(
    `INSERT INTO connector_queue
       (user_id, connector_id, document, kind, payload, attempts, status, next_try_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 0, 'pending', ?, ?, ?)
     ON CONFLICT(user_id, connector_id, document, kind) DO UPDATE SET
       payload = excluded.payload,
       attempts = 0,
       status = 'pending',
       next_try_at = excluded.next_try_at,
       last_error = NULL,
       updated_at = excluded.updated_at`
  ).run(userId, connectorId, ev.document, coalesceKey, JSON.stringify(ev), now, now, now);
}

export function claimReady(db: DB, limit: number, now = nowSeconds()): QueueRow[] {
  return db
    .prepare(
      `SELECT id, user_id, connector_id, document, kind, payload, attempts, status, next_try_at, last_error
       FROM connector_queue
       WHERE status = 'pending' AND next_try_at <= ?
       -- Positions before highlights: adding a highlight can make a service's copy look newer.
       ORDER BY kind LIKE 'highlight:%', next_try_at
       LIMIT ?`
    )
    .all(now, limit) as unknown as QueueRow[];
}

export function markDone(db: DB, id: number, now = nowSeconds()): void {
  db.prepare(`UPDATE connector_queue SET status = 'done', updated_at = ? WHERE id = ?`).run(now, id);
}

/** Record a failed attempt: reschedule with backoff, or dead-letter past the cap. */
export function markFailed(
  db: DB,
  row: QueueRow,
  error: string,
  retryable: boolean,
  now = nowSeconds()
): void {
  const attempts = row.attempts + 1;
  if (!retryable || attempts >= MAX_ATTEMPTS) {
    db.prepare(
      `UPDATE connector_queue SET status = 'dead', attempts = ?, last_error = ?, updated_at = ? WHERE id = ?`
    ).run(attempts, error.slice(0, 500), now, row.id);
    return;
  }
  const backoff = BACKOFF[Math.min(attempts - 1, BACKOFF.length - 1)];
  db.prepare(
    `UPDATE connector_queue SET attempts = ?, last_error = ?, next_try_at = ?, updated_at = ? WHERE id = ?`
  ).run(attempts, error.slice(0, 500), now + backoff, now, row.id);
}

/** Drop a queued row entirely (e.g. connector unlinked). */
export function purgeConnector(db: DB, userId: number, connectorId: string): void {
  db.prepare(`DELETE FROM connector_queue WHERE user_id = ? AND connector_id = ?`).run(
    userId,
    connectorId
  );
}

export function queueDepth(db: DB, userId: number, connectorId: string): { pending: number; dead: number } {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN status = 'dead' THEN 1 ELSE 0 END) AS dead
       FROM connector_queue WHERE user_id = ? AND connector_id = ?`
    )
    .get(userId, connectorId) as { pending: number | null; dead: number | null };
  return { pending: row.pending ?? 0, dead: row.dead ?? 0 };
}

/** Account-scoped delivery errors, grouped so one bad book cannot flood Settings. */
// Given-up items stop showing after this long; still-retrying ones always show.
const ERROR_SHOW_DEAD_FOR = 14 * 86400;

/** The newest failure messages for a connector, each with the books it hit.
 *  Progress and finished events count as one per book; clippings count each. */
export function queueErrors(
  db: DB, userId: number, connectorId: string, now = nowSeconds()
): { kind: 'book' | 'clipping'; message: string; count: number; titles: string[] }[] {
  const rows = db.prepare(`SELECT CASE WHEN q.kind LIKE 'highlight%' THEN 'clipping' ELSE 'book' END AS kind,
      q.last_error AS message,
      CASE WHEN q.kind LIKE 'highlight%' THEN COUNT(*) ELSE COUNT(DISTINCT q.document) END AS count,
      json_group_array(DISTINCT COALESCE(d.title, d.filename, 'Untitled book')) AS titles
    FROM connector_queue q
    LEFT JOIN documents d ON d.user_id = q.user_id AND d.document = q.document
    WHERE q.user_id = ? AND q.connector_id = ? AND q.last_error IS NOT NULL
      AND (q.status = 'pending' OR (q.status = 'dead' AND q.updated_at >= ?))
    GROUP BY 1, q.last_error
    ORDER BY MAX(q.updated_at) DESC, q.last_error LIMIT 3`)
    .all(userId, connectorId, now - ERROR_SHOW_DEAD_FOR) as { kind: 'book' | 'clipping'; message: string; count: number; titles: string }[];
  return rows.map((r) => ({ ...r, titles: (JSON.parse(r.titles) as string[]).sort() }));
}

export const _internals = { MAX_ATTEMPTS, BACKOFF, withTransaction };
