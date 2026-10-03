import type { DB } from '../db/db.js';
import { nowSeconds } from './sync.js';

export const AUTO_PAUSE_DAYS = 30;
// Matches the derived "finished" in GET /progress.
const FINISHED = 0.98;

/**
 * Pause books in progress (status unset or 'reading') whose position hasn't
 * moved (progress_log) for AUTO_PAUSE_DAYS. Scoped to one user, or one book;
 * all users when userId is omitted (the daily sweep).
 */
export function autoPause(db: DB, opts: { userId?: number; document?: string } = {}, now = nowSeconds()): number {
  const cutoff = now - AUTO_PAUSE_DAYS * 86_400;
  return Number(db.prepare(
    `INSERT INTO documents (user_id, document, status, status_at, pause_reason, updated_at)
     SELECT l.user_id, l.document, 'paused', ?, 'auto', ?
       FROM progress_log l
      WHERE (? IS NULL OR l.user_id = ?) AND (? IS NULL OR l.document = ?)
      GROUP BY l.user_id, l.document
     HAVING MAX(l.at) < ?
        AND (SELECT p.percentage FROM progress p WHERE p.user_id = l.user_id AND p.document = l.document
              ORDER BY p.updated_at DESC, p.device_id LIMIT 1) < ${FINISHED}
     ON CONFLICT(user_id, document) DO UPDATE SET
       status = 'paused', status_at = excluded.status_at, pause_reason = 'auto'
      WHERE documents.status IS NULL OR documents.status = 'reading'`
  ).run(now, now, opts.userId ?? null, opts.userId ?? null, opts.document ?? null, opts.document ?? null, cutoff).changes);
}

/** New progress unpauses a book, whoever paused it (pause_reason is kept for when that changes). */
export function autoUnpause(db: DB, userId: number, document: string, at: number): void {
  db.prepare(
    `UPDATE documents SET status = NULL, status_at = ?, pause_reason = NULL
      WHERE user_id = ? AND document = ? AND status = 'paused' AND status_at <= ?`
  ).run(at, userId, document, at);
}
