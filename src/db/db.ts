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
      db.exec(sql);
      db.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(
        file,
        Math.floor(Date.now() / 1000)
      );
    });
  }
}
