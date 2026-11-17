import { describe, expect, it } from 'vitest';
import { migrate, openDatabase } from '../src/db/db.js';
import { documentInfo, editionless } from '../src/models/cover.js';
import { cacheKey } from '../src/models/hardcover-catalog.js';
import type { HttpTransport } from '../src/connectors/types.js';

describe('covers', () => {
  it('drops edition notes from a title before searching', () => {
    expect(editionless('Bel Canto [Movie Tie-In]: A Novel')).toBe('Bel Canto');
    expect(editionless('Dune (Deluxe Edition)')).toBe('Dune');
    expect(editionless('The Hobbit')).toBe('The Hobbit');
  });

  it("uses a matched book's cached Hardcover cover after the free sources missed", async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    const now = Math.floor(Date.now() / 1000);
    db.prepare("INSERT INTO users (id, username, key_hash, created_at) VALUES (1, 'u', 'h', 0)").run();
    // Searched an hour ago with no cover, then matched on Hardcover.
    db.prepare(
      `INSERT INTO documents (user_id, document, title, author, cover_checked_at, hc_id, hc_checked_at, page_count, updated_at)
       VALUES (1, ?, 'The Hobbit Sketchbook', 'Alan Lee', ?, '42', ?, 160, 0)`
    ).run('a'.repeat(32), now - 3600, now);
    db.prepare('INSERT INTO catalog_cache (key, data, checked_at) VALUES (?, ?, ?)').run(
      cacheKey('The Hobbit Sketchbook', 'Alan Lee'), JSON.stringify({ id: 42, cover: 'https://hc.test/hobbit.jpg', pages: 160 }), now
    );
    const offline: HttpTransport = async () => {
      throw new Error('no network expected');
    };
    expect((await documentInfo(db, 1, 'a'.repeat(32), offline, {})).cover).toBe('https://hc.test/hobbit.jpg');
  });

  it('asks the metadata API instead of Hardcover when METADATA_API_URL is set', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare("INSERT INTO users (id, username, key_hash, created_at) VALUES (1, 'u', 'h', 0)").run();
    db.prepare("INSERT INTO documents (user_id, document, title, author, updated_at) VALUES (1, ?, 'dune', 'Herbert, Frank', 0)").run('b'.repeat(32));
    const asked: string[] = [];
    const api: HttpTransport = async (url) => {
      asked.push(String(url));
      return Response.json({ books: [{ id: '9780441013593', isbn: '9780441013593', title: 'Dune', author: 'Frank Herbert', description: 'Spice.',
        cover_url: 'https://meta.test/covers/9780441013593', series: 'Dune', series_position: 1, genres: ['Science Fiction'], moods: ['adventurous'],
        content_warnings: [], page_count: 604, release_year: 1965, rating: 4.26 }] });
    };
    const info = await documentInfo(db, 1, 'b'.repeat(32), api, { METADATA_API_URL: 'https://meta.test/' }, { hardcover: true });
    // One request answers details, cover and pages: nothing else is asked.
    expect(asked).toEqual(['https://meta.test/books?title=dune&author=Herbert%2C+Frank']);
    expect(info).toEqual({ cover: 'https://meta.test/covers/9780441013593', pages: 604 });
    expect(db.prepare('SELECT hc_id, hc_slug, genres, moods, series, series_position, release_year, description, rating FROM documents').get()).toEqual({
      hc_id: '9780441013593', hc_slug: null, genres: '["Science Fiction"]', moods: '["Adventurous"]', series: 'Dune', series_position: 1,
      release_year: 1965, description: 'Spice.', rating: 4.26,
    });

    // Busy (503) is not a miss: the book stays unchecked and is asked again later.
    db.prepare("INSERT INTO documents (user_id, document, title, author, cover_url, page_count, updated_at) VALUES (1, ?, 'Emma', 'Jane Austen', 'x', 1, 0)").run('c'.repeat(32));
    await documentInfo(db, 1, 'c'.repeat(32), async () => new Response('', { status: 503 }), { METADATA_API_URL: 'https://meta.test' }, { hardcover: true });
    expect(db.prepare('SELECT hc_checked_at FROM documents WHERE document = ?').get('c'.repeat(32))).toEqual({ hc_checked_at: null });
  });
});
