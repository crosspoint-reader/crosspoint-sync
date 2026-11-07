import { expect, it } from 'vitest';
import { migrate, openDatabase, withTransaction } from '../src/db/db.js';

it('upgrades the renamed legacy reading-goals migration without losing targets', () => {
  const db = openDatabase(':memory:');
  try {
    migrate(db);
    db.prepare("INSERT INTO users (username, key_hash, created_at) VALUES ('legacy-reader', 'test-key', 0)").run();
    const userId = Number(db.prepare("SELECT id FROM users WHERE username='legacy-reader'").get()!.id);
    db.prepare('INSERT INTO reading_goals (user_id, year, target) VALUES (?, 2026, 24)').run(userId);
    db.prepare("UPDATE migrations SET name='0044_reading_goals.sql' WHERE name='0048_reading_goals.sql'").run();
    migrate(db);
    migrate(db);
    expect(db.prepare('SELECT year, target FROM reading_goals WHERE user_id=?').get(userId)).toEqual({ year: 2026, target: 24 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM migrations WHERE name='0048_reading_goals.sql'").get()).toEqual({ n: 1 });
    expect(() => db.prepare('INSERT INTO reading_goals (user_id,year,target) VALUES (?,2027,0)').run(userId)).toThrow();
  } finally { db.close(); }
});

it('does not adopt an incompatible table when repairing the legacy goal migration', () => {
  const db = openDatabase(':memory:');
  try {
    migrate(db);
    db.prepare("UPDATE migrations SET name='0044_reading_goals.sql' WHERE name='0048_reading_goals.sql'").run();
    db.exec('DROP TABLE reading_goals; CREATE TABLE reading_goals (unexpected TEXT); INSERT INTO reading_goals VALUES (\'keep this\')');
    expect(() => migrate(db)).toThrow(/reading.goals|reading_goals/i);
    expect(db.prepare('SELECT unexpected FROM reading_goals').get()).toEqual({ unexpected: 'keep this' });
    expect(db.prepare("SELECT COUNT(*) AS n FROM migrations WHERE name='0048_reading_goals.sql'").get()).toEqual({ n: 0 });
  } finally { db.close(); }
});

it.each([false, true])('repairs BookOrbit imports with an existing attempted_at column: %s', (hasColumn) => {
  const db = openDatabase(':memory:');
  try {
    migrate(db);
    db.prepare("DELETE FROM migrations WHERE name = '0032_bookorbit_stats_attempted_at.sql'").run();
    if (!hasColumn) db.exec('ALTER TABLE bookorbit_stats_sync DROP COLUMN attempted_at');
    // Keep a saved import checkpoint while upgrading the earlier schema.
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('INSERT INTO bookorbit_stats_sync (user_id, external_id, active_generation, refreshed_at) VALUES (1, ?, 7, 123)').run('42');
    migrate(db);
    migrate(db);
    expect(db.prepare('SELECT external_id, active_generation, refreshed_at, attempted_at FROM bookorbit_stats_sync').get())
      .toEqual({ external_id: '42', active_generation: 7, refreshed_at: 123, attempted_at: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM migrations WHERE name = '0032_bookorbit_stats_attempted_at.sql'").get()).toEqual({ n: 1 });
  } finally {
    db.close();
  }
});

it('rolls back a failed inner transaction without losing the outer transaction', () => {
  const db = openDatabase(':memory:');
  try {
    db.exec('CREATE TABLE writes (value INTEGER NOT NULL)');
    withTransaction(db, () => {
      db.exec('INSERT INTO writes VALUES (1)');
      expect(() => withTransaction(db, () => {
        db.exec('INSERT INTO writes VALUES (2)');
        throw new Error('inner failure');
      })).toThrow('inner failure');
      withTransaction(db, () => db.exec('INSERT INTO writes VALUES (3)'));
    });
    expect(db.prepare('SELECT value FROM writes ORDER BY value').all()).toEqual([{ value: 1 }, { value: 3 }]);
  } finally {
    db.close();
  }
});
