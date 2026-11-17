import { describe, expect, it } from 'vitest';
import { makeTestApp, registerUser } from './helpers.js';

describe('catalog export', () => {
  it('is absent without a token', async () => {
    const { app } = makeTestApp();
    expect((await app.request('/api/catalog/books')).status).toBe(404);
  });

  it('exports one row per book, without manual edits, user data or unrecognised documents', async () => {
    const { app, db } = makeTestApp({ catalogExportToken: 'tok' });
    const ids: number[] = [];
    for (let i = 0; i < 2; i++) {
      const u = await registerUser(app);
      ids.push(Number(db.prepare('SELECT id FROM users WHERE username = ?').get(u.username)!.id));
    }
    const add = db.prepare(`INSERT INTO documents (user_id, document, title, author, isbn, description, description_manual, genres, cover_url, meta_manual, hc_id, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`);
    add.run(ids[0], 'a', 'Dune', 'Frank Herbert', '9780441013593', 'Spice.', 0, '["Science Fiction"]', 'https://x/c.jpg', 0, null);
    add.run(ids[1], 'b', 'my dune copy', 'me', '9780441013593', 'private note', 1, null, null, 1, null);
    add.run(ids[0], 'c', 'Emma', 'Jane Austen', '9780141439587', null, 0, null, null, 0, null);
    // No ISBN: exported once per title and author, and only when Hardcover recognised it.
    add.run(ids[0], 'd', 'Piranesi', 'Susanna Clarke', null, 'A house.', 0, null, null, 0, '42');
    add.run(ids[1], 'e', 'piranesi', 'susanna clarke', null, null, 0, '["Fantasy"]', null, 0, '42');
    add.run(ids[0], 'f', 'My Tax Return 2025', null, null, null, 0, null, null, 0, null);
    add.run(ids[0], 'g', 'renamed by hand', 'x', null, null, 0, null, null, 1, '43');

    expect((await app.request('/api/catalog/books')).status).toBe(401);
    expect((await app.request('/api/catalog/books', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);

    const get = async (q: string) => (await app.request(`/api/catalog/books${q}`, { headers: { authorization: 'Bearer tok' } })).json();
    const page1 = await get('?limit=1');
    expect(page1).toEqual({ books: [{ isbn: '9780141439587', title: 'Emma', author: 'Jane Austen', description: null, genres: [], cover_url: null, moods: [], content_warnings: [], series: null, series_position: null, release_year: null, page_count: null, rating: null }], next: '9780141439587' });
    const page2 = await get(`?after=${encodeURIComponent(page1.next)}`);
    expect(page2).toEqual({ next: null, books: [
      { isbn: '9780441013593', title: 'Dune', author: 'Frank Herbert', description: 'Spice.', genres: ['Science Fiction'], cover_url: 'https://x/c.jpg', moods: [], content_warnings: [], series: null, series_position: null, release_year: null, page_count: null, rating: null },
      { isbn: null, title: 'piranesi', author: 'susanna clarke', description: 'A house.', genres: ['Fantasy'], cover_url: null, moods: [], content_warnings: [], series: null, series_position: null, release_year: null, page_count: null, rating: null },
    ] });
    // The cursor works across the ISBN / no-ISBN boundary.
    expect((await get('?limit=2')).next).toBe('9780441013593');
    expect((await get('?limit=2&after=9780441013593')).books.map((b: any) => b.title)).toEqual(['piranesi']);
  });
});
