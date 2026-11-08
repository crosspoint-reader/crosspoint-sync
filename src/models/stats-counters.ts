import type { DB } from '../db/db.js';
import {
  combineBookStats, combineGlobalStats, combineHistory, LEGACY_COUNTER_ID,
  type BookStatsSnapshot, type DailyReading, type GlobalStatsSnapshot,
} from './stats.js';

/** Also covers restored pre-counter-ID account archives and direct history imports. */
export function seedStatsCounters(db: DB, userId: number, deviceId?: string, scope?: string) {
  for (const [table, document] of [['stats_device_global', "''"], ['stats_device_book', 's.document']] as const) {
    db.prepare(`INSERT INTO stats_counter_snapshots
      SELECT s.user_id, s.device_id, ${document}, ?, s.payload, s.updated_at FROM ${table} s
      WHERE s.user_id = ? ${deviceId === undefined ? '' : 'AND s.device_id = ?'} ${scope === undefined ? '' : `AND ${document} = ?`}
      AND NOT EXISTS (SELECT 1 FROM stats_counter_snapshots r
        WHERE r.user_id = s.user_id AND r.device_id = s.device_id AND r.document = ${document})`)
      .run(LEGACY_COUNTER_ID, userId, ...(deviceId === undefined ? [] : [deviceId]), ...(scope === undefined ? [] : [scope]));
  }
  for (const [table, document] of [['stats_device_day', "''"], ['stats_device_book_day', 's.document']] as const) {
    db.prepare(`INSERT INTO stats_counter_days
      SELECT s.user_id, s.device_id, ${document}, ?, s.date, s.seconds, s.updated_at FROM ${table} s
      WHERE s.user_id = ? ${deviceId === undefined ? '' : 'AND s.device_id = ?'} ${scope === undefined ? '' : `AND ${document} = ?`}
      AND NOT EXISTS (SELECT 1 FROM stats_counter_days r
        WHERE r.user_id = s.user_id AND r.device_id = s.device_id AND r.document = ${document} AND r.date = s.date)`)
      .run(LEGACY_COUNTER_ID, userId, ...(deviceId === undefined ? [] : [deviceId]), ...(scope === undefined ? [] : [scope]));
  }
}

type Snapshot = GlobalStatsSnapshot | BookStatsSnapshot;
const maxArray = (a: number[], b: number[]) => a.map((n, i) => Math.max(n, b[i]));

function preserveCounters(old: Snapshot, incoming: Snapshot, book: boolean, legacyUpload: boolean): Snapshot {
  // Completion, dates and pace are editable. Accept them on current checkpoints,
  // while a stale/reset legacy snapshot cannot clear the previous metadata.
  const regressed = incoming.sessions < old.sessions || incoming.seconds < old.seconds || incoming.pages < old.pages;
  const result = { ...(regressed ? old : incoming),
    sessions: Math.max(old.sessions, incoming.sessions),
    seconds: Math.max(old.seconds, incoming.seconds), pages: Math.max(old.pages, incoming.pages),
    tod: maxArray(old.tod, incoming.tod), dow: maxArray(old.dow, incoming.dow) };
  if (book) {
    if (!legacyUpload) return result;
    // Untagged uploads cannot distinguish metadata edits from resets, even once
    // reading resumes. Library completions may have no reading counters at all.
    const a = old as BookStatsSnapshot, b = incoming as BookStatsSnapshot;
    const start = a.start_date && b.start_date ? Math.min(a.start_date, b.start_date) : a.start_date || b.start_date;
    const finish = Math.max(a.finished_date, b.finished_date);
    return { ...result, completed: a.completed || b.completed, start_date: start, finished_date: finish,
      start_manual: start === a.start_date ? a.start_manual : b.start_manual,
      finish_manual: finish === a.finished_date ? a.finish_manual : b.finish_manual } as BookStatsSnapshot;
  }
  const a = old as GlobalStatsSnapshot, global = incoming as GlobalStatsSnapshot;
  const history = combineHistory([a, global]);
  return { ...result, anchor_day: history.anchorDay, history_b64: history.history.toString('base64'),
    completed: legacyUpload ? Math.max(a.completed, global.completed) : result.completed,
    streak: Math.max(a.streak, global.streak) } as GlobalStatsSnapshot;
}

/** Called inside the route's transaction; raw lifetimes and compatible views commit together. */
export function storeStatsSnapshot(
  db: DB, userId: number, deviceId: string, document: string, counterId: string,
  incoming: Snapshot, now: number, device = '', legacyUpload = false,
) {
  const key = [userId, deviceId, document, counterId];
  const old = db.prepare(`SELECT payload FROM stats_counter_snapshots
    WHERE user_id = ? AND device_id = ? AND document = ? AND counter_id = ?`).get(...key);
  const snapshot = old ? preserveCounters(JSON.parse(String(old.payload)), incoming, !!document, legacyUpload) : incoming;
  db.prepare(`INSERT INTO stats_counter_snapshots VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, device_id, document, counter_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
    .run(...key, JSON.stringify(snapshot), now);
  const snapshots = db.prepare(`SELECT payload FROM stats_counter_snapshots
    WHERE user_id = ? AND device_id = ? AND document = ? ORDER BY counter_id`)
    .all(userId, deviceId, document).map(r => JSON.parse(String(r.payload)));
  if (!document) {
    const { current_streak: _, ...combined } = combineGlobalStats(snapshots);
    db.prepare(`INSERT INTO stats_device_global VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, device_id) DO UPDATE SET device = excluded.device, payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(userId, deviceId, device, JSON.stringify({ v: incoming.v, ...combined }), now);
  } else {
    const combined = combineBookStats(snapshots);
    db.prepare(`INSERT INTO stats_device_book VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, device_id, document) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`)
      .run(userId, deviceId, document, JSON.stringify({ ...snapshot, ...combined,
        pace_n: snapshots.reduce((n, s) => n + s.pace_n, 0) }), now);
  }
}

export function storeStatsDays(db: DB, userId: number, deviceId: string, document: string, days: DailyReading[], now: number) {
  for (const day of days) {
    db.prepare(`INSERT INTO stats_counter_days VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, device_id, document, counter_id, date) DO UPDATE SET
      seconds = MAX(stats_counter_days.seconds, excluded.seconds), updated_at = excluded.updated_at`)
      .run(userId, deviceId, document, day.counter_id ?? LEGACY_COUNTER_ID, day.date, day.seconds, now);
    const total = db.prepare(`SELECT MIN(SUM(seconds), 4294967295) AS seconds FROM stats_counter_days
      WHERE user_id = ? AND device_id = ? AND document = ? AND date = ?`).get(userId, deviceId, document, day.date)!.seconds;
    if (!document) {
      db.prepare(`INSERT INTO stats_device_day VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id, device_id, date) DO UPDATE SET seconds = excluded.seconds, updated_at = excluded.updated_at`)
        .run(userId, deviceId, day.date, total, now);
    } else {
      db.prepare(`INSERT INTO stats_device_book_day VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, device_id, document, date) DO UPDATE SET seconds = excluded.seconds, updated_at = excluded.updated_at`)
        .run(userId, deviceId, document, day.date, total, now);
    }
  }
}
