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

  it('asks the metadata API alone when METADATA_API_URL is set without a Hardcover key', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare("INSERT INTO users (id, username, key_hash, created_at) VALUES (1, 'u', 'h', 0)").run();
    db.prepare("INSERT INTO documents (user_id, document, title, author, updated_at) VALUES (1, ?, 'dune', 'Herbert, Frank', 0)").run('b'.repeat(32));
    const asked: string[] = [];
    let auth: unknown;
    const api: HttpTransport = async (url, init) => {
      asked.push(String(url));
      auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      return Response.json({ books: [{ id: '9780441013593', isbn: '9780441013593', title: 'Dune', author: 'Frank Herbert', description: 'Spice.',
        cover_url: 'https://meta.test/covers/9780441013593', series: 'Dune', series_position: 1, genres: ['Science Fiction'], moods: ['adventurous'],
        content_warnings: [], page_count: 604, release_year: 1965, rating: 4.26 }] });
    };
    const info = await documentInfo(db, 1, 'b'.repeat(32), api, { METADATA_API_URL: 'https://meta.test/', METADATA_API_KEY: 'mk_test' }, { hardcover: true });
    expect(auth).toBe('Bearer mk_test'); // the key, when one is set
    // One request answers details, cover and pages: nothing else is asked.
    expect(asked).toEqual(['https://meta.test/books?title=dune&author=Herbert%2C+Frank']);
    expect(info).toEqual({ cover: 'https://meta.test/covers/9780441013593', pages: 604 });
    expect(db.prepare('SELECT hc_id, hc_slug, genres, moods, series, series_position, release_year, description, rating FROM documents').get()).toEqual({
      hc_id: '9780441013593', hc_slug: null, genres: '["Science Fiction"]', moods: '["Adventurous"]', series: 'Dune', series_position: 1,
      release_year: 1965, description: 'Spice.', rating: 4.26,
    });

    // On at metadata.dev unless METADATA_API is false; METADATA_API_URL names another API.
    const { metadataApiUrl } = await import('../src/models/hardcover-catalog.js');
    expect([metadataApiUrl({}), metadataApiUrl({ METADATA_API: 'true' }), metadataApiUrl({ METADATA_API: 'false' }), metadataApiUrl({ METADATA_API_URL: 'https://other.test' }), metadataApiUrl({ METADATA_API: 'false', METADATA_API_URL: 'https://other.test' })])
      .toEqual(['https://api.metadata.dev', 'https://api.metadata.dev', '', 'https://other.test', '']);

    db.prepare("INSERT INTO documents (user_id, document, title, author, cover_url, page_count, updated_at) VALUES (1, ?, 'Emma', 'Jane Austen', 'x', 1, 0)").run('c'.repeat(32));
    await documentInfo(db, 1, 'c'.repeat(32), async () => new Response('', { status: 503 }), { METADATA_API_URL: 'https://meta.test' }, { hardcover: true });
    expect(db.prepare('SELECT hc_checked_at FROM documents WHERE document = ?').get('c'.repeat(32))).toEqual({ hc_checked_at: null });
  });

  it('fills pages, cover and details from ISBNdb when ISBNDB_API_KEY is set', async () => {
    const db = openDatabase(':memory:');
    migrate(db);
    db.prepare("INSERT INTO users (id, username, key_hash, created_at) VALUES (1, 'u', 'h', 0)").run();
    db.prepare("INSERT INTO documents (user_id, document, title, author, updated_at) VALUES (1, ?, 'Dune: Deluxe', 'Herbert, Frank', 0)").run('d'.repeat(32));
    const asked: { url: string; auth: unknown }[] = [];
    const api: HttpTransport = async (url, init) => {
      if (!String(url).startsWith('https://api2.isbndb.com/')) return Response.json({}); // the free sources find nothing
      asked.push({ url: String(url), auth: (init?.headers as Record<string, string>)?.authorization });
      return Response.json({ data: [
        { title: 'Dune Messiah', isbn13: '9780593098233', authors: ['Frank Herbert'], pages: 336, image: 'https://img.test/messiah.jpg' },
        { title: 'Dune', isbn13: '9780000000001', authors: ['Frank Herbert'], binding: 'Audio CD', pages: 18, date_published: '2007-05' },
        { title: 'Dune', isbn13: '9780441013593', authors: ['Herbert, Frank'], binding: 'Paperback', pages: 704, date_published: '1965',
          image: 'https://img.test/dune.jpg', synopsis: '<p>Spice.</p><br/>Sand.', thema: [{ code: 'FL', name: 'Science fiction', type: 'subject', main: true }, { code: '1K', name: 'Americas', type: 'place', main: false }] },
      ] });
    };
    const info = await documentInfo(db, 1, 'd'.repeat(32), api, { ISBNDB_API_KEY: 'k' }, { hardcover: true });
    expect(asked).toEqual([{ url: 'https://api2.isbndb.com/search/books?text=Dune&author=Frank+Herbert&pageSize=50', auth: 'k' }]);
    expect(info).toEqual({ cover: 'https://img.test/dune.jpg', pages: 704 }); // not the audiobook's 18, not the sequel's
    expect(db.prepare('SELECT hc_id, genres, release_year, description FROM documents').get()).toEqual({
      hc_id: '9780441013593', genres: '["Science fiction"]', release_year: 1965, description: 'Spice. Sand.',
    });
  });
});
