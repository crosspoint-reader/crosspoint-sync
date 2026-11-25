import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/db.js';
import { cacheKey } from '../src/models/hardcover-catalog.js';

describe('series-numbered titles', () => {
  it('keys cached lookups on the title words, not the number', () => {
    expect(cacheKey('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner')).toBe(
      'die drei fragezeichen und das weiße auge|marco sonnleitner'
    );
    expect(cacheKey('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner')).not.toBe(
      cacheKey('240 - Die drei Fragezeichen und der Fluch des Rubins', 'Marco Sonnleitner')
    );
  });

  it('a migration looks up books matched on their series number again', () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare("INSERT INTO users (id, username, key_hash, created_at) VALUES (1, 'u', 'h', 0)").run();
    const doc = db.prepare(
      `INSERT INTO documents (user_id, document, title, author, cover_url, cover_checked_at, hc_id, hc_checked_at, updated_at)
       VALUES (1, ?, ?, 'Marco Sonnleitner', ?, 100, ?, 100, 0)`
    );
    doc.run('a'.repeat(32), '241 - Die drei Fragezeichen und das weiße Auge', null, '99');
    doc.run('b'.repeat(32), '007 – Die drei Fragezeichen und der Fluch des Rubins', 'https://set.by/user.jpg', null);
    doc.run('c'.repeat(32), '1984 - A Novel', null, '7');
    doc.run('d'.repeat(32), 'Dune', null, '8');
    const match = db.prepare(
      `INSERT INTO connector_matches (user_id, connector_id, document, external_id, source, updated_at) VALUES (1, 'hardcover', ?, ?, ?, 0)`
    );
    match.run('a'.repeat(32), null, 'none');
    match.run('b'.repeat(32), 'picked', 'manual');
    match.run('c'.repeat(32), '1984', 'auto');

    db.exec(readFileSync(new URL('../migrations/0054_rematch_series_number_titles.sql', import.meta.url), 'utf8'));

    const checked = (d: string) =>
      db.prepare('SELECT cover_url, cover_checked_at, hc_checked_at FROM documents WHERE document = ?').get(d.repeat(32));
    expect(checked('a')).toEqual({ cover_url: null, cover_checked_at: null, hc_checked_at: null });
    expect(checked('b')).toEqual({ cover_url: 'https://set.by/user.jpg', cover_checked_at: null, hc_checked_at: null });
    expect(checked('c')).toEqual({ cover_url: null, cover_checked_at: 100, hc_checked_at: 100 });
    expect(checked('d')).toEqual({ cover_url: null, cover_checked_at: 100, hc_checked_at: 100 });
    const matches = db.prepare('SELECT document, source FROM connector_matches ORDER BY document').all();
    expect(matches).toEqual([
      { document: 'b'.repeat(32), source: 'manual' },
      { document: 'c'.repeat(32), source: 'auto' },
    ]);
  });
});
