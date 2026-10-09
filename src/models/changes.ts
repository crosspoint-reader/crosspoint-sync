import type { DB } from '../db/db.js';
import { aliasesByDocument } from './merge.js';

/**
 * Progress change feed (GET /api/v1/progress/changes). Every progress write
 * stamps the next value of one server-wide counter on the row it touches, so a
 * device can ask "what changed since N" without trusting updated_at, which
 * fan-in sets from the external service's clock.
 */

/** Claims the next change sequence number. Call inside the write that uses it. */
export function nextChangeSeq(db: DB): number {
  const row = db.prepare('UPDATE change_seq SET value = value + 1 WHERE id = 1 RETURNING value').get() as {
    value: number;
  };
  return row.value;
}

/** Highest change sequence number among a user's progress rows (0 when none). */
export function latestChangeSeq(db: DB, userId: number): number {
  const row = db.prepare('SELECT MAX(change_seq) AS seq FROM progress WHERE user_id = ?').get(userId) as {
    seq: number | null;
  };
  return row.seq ?? 0;
}

export interface ProgressChange {
  document: string;
  aliases: string[];
  percentage: number;
  progress: string;
  position: unknown;
  device: string;
  device_id: string;
  timestamp: number;
}

export interface ProgressChangesPage {
  cursor: number;
  more: boolean;
  changes: ProgressChange[];
}

export const CHANGES_DEFAULT_LIMIT = 20;
export const CHANGES_MAX_LIMIT = 50;
/** The firmware reads a page into one fixed 8 KB buffer. */
export const CHANGES_MAX_BYTES = 8 * 1024;

/**
 * One entry per document whose newest row (same tie-break as the kosync GET)
 * has change_seq > since, oldest change first. A document whose newest row was
 * written by `deviceId` is left out unless a server-side change occurred since
 * the cursor. Excluded rows still advance the cursor. Stops at `limit` changes
 * or once the body would pass CHANGES_MAX_BYTES, always returning at least one
 * change when any remain.
 */
export function listProgressChanges(
  db: DB,
  userId: number,
  since: number,
  limit: number,
  deviceId: string | null
): ProgressChangesPage {
  if (limit <= 0) {
    return { cursor: Math.max(since, latestChangeSeq(db, userId)), more: false, changes: [] };
  }
  // Narrow to documents with any row past the cursor (indexed), then pick each
  // document's newest row and keep it only if that row itself is past the cursor.
  const rows = db
    .prepare(
      `WITH changed AS (
         SELECT DISTINCT document FROM progress WHERE user_id = ? AND change_seq > ?
       ), newest AS (
         SELECT p.document, p.device_id, p.device, p.percentage, p.progress, p.position, p.updated_at, p.change_seq,
                MAX(p.server_change_seq) OVER (PARTITION BY p.document) AS server_change_seq,
                ROW_NUMBER() OVER (PARTITION BY p.document ORDER BY p.updated_at DESC, p.device_id) AS rn
         FROM progress p JOIN changed c ON c.document = p.document
         WHERE p.user_id = ?
       )
       SELECT document, device_id, device, percentage, progress, position, updated_at, change_seq, server_change_seq
       FROM newest WHERE rn = 1 AND change_seq > ?
       ORDER BY change_seq, document`
    )
    .all(userId, since, userId, since) as unknown as {
    document: string;
    device_id: string;
    device: string;
    percentage: number;
    progress: string;
    position: string | null;
    updated_at: number;
    change_seq: number;
    server_change_seq: number;
  }[];

  const aliases = rows.length > 0 ? aliasesByDocument(db, userId) : new Map<string, string[]>();
  const envelopeBytes = Buffer.byteLength(JSON.stringify({ cursor: Number.MAX_SAFE_INTEGER, more: false, changes: [] }));
  let bytes = envelopeBytes;
  let cursor = since;
  let more = false;
  const changes: ProgressChange[] = [];
  for (const row of rows) {
    if (deviceId && row.device_id === deviceId && row.server_change_seq <= since) {
      // Server-made changes must reach even the original author. Otherwise,
      // self-exclusion has no fallback to an older row from another device, which
      // would only make the device re-push what it already has.
      cursor = row.change_seq;
      continue;
    }
    let position: unknown = null;
    if (row.position) {
      try {
        position = JSON.parse(row.position);
      } catch {
        position = null;
      }
    }
    const change: ProgressChange = {
      document: row.document,
      aliases: aliases.get(row.document) ?? [],
      percentage: row.percentage,
      progress: row.progress,
      position,
      device: row.device,
      device_id: row.device_id,
      timestamp: row.updated_at,
    };
    const changeBytes = Buffer.byteLength(JSON.stringify(change)) + (changes.length > 0 ? 1 : 0);
    if (changes.length >= limit || (changes.length > 0 && bytes + changeBytes > CHANGES_MAX_BYTES)) {
      more = true;
      break;
    }
    changes.push(change);
    bytes += changeBytes;
    cursor = row.change_seq;
  }
  return { cursor, more, changes };
}
