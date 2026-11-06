import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type DB = DatabaseSync;

const DEFAULT_MIGRATIONS_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'migrations'
);

export function openDatabase(dbPath: string): DB {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

export function withTransaction(db: DB, fn: () => void): void {
  // Savepoints also nest: an individual progress write can be atomic inside a
  // batch. SQLite resolves repeated names to the innermost active savepoint.
  db.exec('SAVEPOINT transaction_scope');
  try {
    fn();
    db.exec('RELEASE transaction_scope');
  } catch (err) {
    db.exec('ROLLBACK TO transaction_scope');
    db.exec('RELEASE transaction_scope');
    throw err;
  }
}

export function migrate(db: DB, migrationsDir: string = DEFAULT_MIGRATIONS_DIR): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)'
  );
  const applied = new Set(
    (db.prepare('SELECT name FROM migrations').all() as { name: string }[]).map((r) => r.name)
  );
  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    withTransaction(db, () => {
      // Early installs applied 0029 before attempted_at was added to it.
      // Newer installs already have the column, so the repair must accept both.
      const hasBookorbitAttempt = file === '0032_bookorbit_stats_attempted_at.sql' &&
        db.prepare('PRAGMA table_info(bookorbit_stats_sync)').all().some((column) => column.name === 'attempted_at');
      // Development installs recorded this identical migration as 0044 before
      // upstream assigned 0048. Adopt only that known history and exact schema;
      // never drop goals or silently accept an unrelated existing table.
      let hasLegacyReadingGoals = false;
      if (file === '0048_reading_goals.sql' && applied.has('0044_reading_goals.sql')) {
        const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='reading_goals'").get();
        if (table) {
          const normalized = (value: string) => value.trim().replace(/;$/, '').replace(/\s+/g, ' ').toLowerCase();
          if (normalized(String(table.sql)) !== normalized(sql)) {
            throw new Error('Cannot reconcile legacy reading_goals migration: existing table has an unexpected schema.');
          }
          hasLegacyReadingGoals = true;
        }
      }
      if (!hasBookorbitAttempt && !hasLegacyReadingGoals) db.exec(sql);
      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        Math.floor(Date.now() / 1000)
      );
    });
  }
}
