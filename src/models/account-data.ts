import crypto from 'node:crypto';
import { withTransaction, type DB } from '../db/db.js';
import { isValidDocument } from '../routes/kosync.js';
import { nextChangeSeq } from './changes.js';

// Only portable reading data belongs here; never authentication, secrets, queues or caches.
export const ACCOUNT_TABLES = [
  'documents', 'document_aliases', 'progress', 'progress_samples', 'progress_log',
  'bookmarks', 'clippings', 'stats_device_global', 'stats_device_book',
  'stats_device_day', 'stats_device_book_day', 'reading_sessions',
] as const;
const localColumns = new Set(['user_id', 'change_seq', 'server_change_seq', 'revision']);
type Row = Record<string, string | number | null>;
type Column = { name: string; type: string; notnull: number; pk: number; dflt_value: unknown };
const columns = (db: DB, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Column[]).filter(c => !localColumns.has(c.name));

export function exportAccountData(db: DB, userId: number) {
  const user = db.prepare('SELECT username, auto_pause_days, profile_slug FROM users WHERE id = ?').get(userId)!;
  const data: Record<string, Row[]> = {};
  for (const table of ACCOUNT_TABLES) {
    data[table] = db.prepare(`SELECT ${columns(db, table).map(c => c.name).join(', ')} FROM ${table} WHERE user_id = ?`).all(userId) as Row[];
  }
  return {
    format: 'crosspoint-sync-account', version: 1, exported_at: new Date().toISOString(),
    profile: { username: user.username, auto_pause_days: user.auto_pause_days, public_profile: !!user.profile_slug },
    data,
  };
}

export class AccountImportError extends Error {
  constructor(message: string, public status: 400 | 409 = 400) { super(message); }
}
const invalid = (message: string): never => { throw new AccountImportError(message); };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function importAccountData(db: DB, userId: number, input: unknown, replace: boolean) {
  if (!object(input) || input.format !== 'crosspoint-sync-account' || input.version !== 1 || !object(input.data) || !object(input.profile)) {
    return invalid('Not a supported CrossPoint Sync account export (version 1 required).');
  }
  const { data, profile } = input;
  const days = profile.auto_pause_days;
  if (!(days === null || (Number.isInteger(days) && Number(days) >= 0 && Number(days) <= 365)) || typeof profile.public_profile !== 'boolean') {
    return invalid('Invalid account preferences.');
  }
  if (Object.keys(data).some(t => !ACCOUNT_TABLES.includes(t as typeof ACCOUNT_TABLES[number]))) return invalid('Unknown archive data section.');
  let count = 0;
  for (const table of ACCOUNT_TABLES) {
    const rows = data[table];
    if (!Array.isArray(rows)) return invalid(`Missing data section: ${table}.`);
    count += rows.length;
    if (count > 200_000) return invalid('Archive exceeds the 200,000 record limit.');
    const schema = columns(db, table);
    const names = new Set(schema.map(c => c.name));
    for (const row of rows) {
      if (!object(row) || Object.keys(row).some(k => !names.has(k))) return invalid(`Invalid fields in ${table}.`);
      for (const col of schema) {
        const value = row[col.name];
        if (value === undefined && col.dflt_value !== null) continue;
        if (value == null) {
          if (col.notnull || col.pk) return invalid(`Missing ${table}.${col.name}.`);
          continue;
        }
        if (col.type === 'TEXT' ? typeof value !== 'string' : typeof value !== 'number' || !Number.isFinite(value) || (col.type === 'INTEGER' && !Number.isSafeInteger(value))) {
          return invalid(`Invalid value for ${table}.${col.name}.`);
        }
      }
      for (const key of ['document', 'alias']) {
        if (key in row && !isValidDocument(row[key])) return invalid(`Invalid ${table}.${key}.`);
      }
      if ('percentage' in row && (Number(row.percentage) < 0 || Number(row.percentage) > 1)) return invalid(`Invalid percentage in ${table}.`);
      if ('seconds' in row && (Number(row.seconds) < 0 || Number(row.seconds) > 4294967295)) return invalid(`Invalid seconds in ${table}.`);
      if ('date' in row && (typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date) || !Number.isFinite(Date.parse(row.date)) || new Date(row.date).toISOString().slice(0, 10) !== row.date)) return invalid(`Invalid date in ${table}.`);
      if (table === 'reading_sessions' && (Number(row.ended_at) < Number(row.started_at) || Number(row.seconds) > Number(row.ended_at) - Number(row.started_at))) return invalid('Invalid reading session duration.');
      for (const key of ['position', 'payload']) {
        if (typeof row[key] === 'string') {
          try { if (!object(JSON.parse(row[key] as string))) return invalid(`Invalid ${table}.${key}.`); }
          catch { return invalid(`Invalid JSON in ${table}.${key}.`); }
        }
      }
    }
  }
  const aliases = new Map((data.document_aliases as Row[]).map(r => [r.alias, r.document]));
  const checked = new Set();
  for (const alias of aliases.keys()) {
    const seen = new Set();
    let next = alias;
    while (aliases.has(next) && !checked.has(next)) {
      if (seen.has(next)) return invalid('Document aliases contain a cycle.');
      seen.add(next);
      next = aliases.get(next)!;
    }
    for (const item of seen) checked.add(item);
  }
  withTransaction(db, () => {
    const existing = ACCOUNT_TABLES.some(table => db.prepare(`SELECT 1 FROM ${table} WHERE user_id = ? LIMIT 1`).get(userId));
    if (existing && !replace) throw new AccountImportError('This account already has reading data. Export a backup, then choose Replace existing data to continue.', 409);
    // Clear work tied to the old library; credentials stay on the destination.
    for (const table of ['connector_queue', 'connector_matches', 'epub_maps', ...ACCOUNT_TABLES.slice().reverse()]) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
    }
    try {
      for (const table of ACCOUNT_TABLES) {
        for (const source of data[table] as Row[]) {
          const row: Row = { ...source, user_id: userId };
          if (table === 'progress') row.server_change_seq = row.change_seq = nextChangeSeq(db);
          if (table === 'clippings') {
            row.revision = db.prepare('UPDATE clipping_sync_clock SET revision = revision + 1 WHERE id = 1 RETURNING revision').get()!.revision as number;
          }
          const keys = Object.keys(row);
          db.prepare(`INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`).run(...keys.map(k => row[k]));
        }
      }
    } catch {
      throw new AccountImportError('Archive contains duplicate records or invalid data. Nothing was imported.');
    }
    const current = db.prepare('SELECT profile_slug FROM users WHERE id = ?').get(userId)!;
    db.prepare('UPDATE users SET auto_pause_days = ?, profile_slug = ? WHERE id = ?').run(
      days as number | null, profile.public_profile ? (current.profile_slug ?? crypto.randomBytes(9).toString('base64url')) : null, userId,
    );
  });
  return { imported: count };
}
