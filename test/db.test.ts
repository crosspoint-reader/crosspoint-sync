import { expect, it } from 'vitest';
import { openDatabase, withTransaction } from '../src/db/db.js';

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
