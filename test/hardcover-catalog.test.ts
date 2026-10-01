import { beforeEach, describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import type { HttpTransport } from '../src/connectors/types.js';
import { hardcoverBook, nextAfter, resetHardcoverThrottle, searchHardcover } from '../src/models/hardcover-catalog.js';
import { documentInfo } from '../src/models/cover.js';

// Trimmed from a live Hardcover `search` hit (Foundryside), including its messy
// user-entered moods ("Adventurous" and "adventurous" style duplicates).
const HIT = {
  id: '41398',
  slug: 'foundryside',
  title: 'Foundryside',
  author_names: ['Robert Jackson Bennett'],
  pages: 512,
  moods: ['Adventurous', 'mysterious', 'dark', 'tense', 'adventurous', 'funny'],
  genres: ['Fantasy', 'Science Fiction', 'Magic'],
  content_warnings: ['Violence', 'Slavery'],
  rating: 4.222984562607204,
  ratings_count: 583,
  series_names: ['The Founders Trilogy'],
  featured_series: { position: 1, series: { id: 4975, name: 'The Founders Trilogy' } },
  featured_series_position: 1,
  release_year: 2018,
  image: { url: 'https://assets.hardcover.app/cover.jpeg' },
};

function fake(status = 200, hits = [{ document: HIT }]) {
  const calls: string[] = [];
  const http: HttpTransport = async (url) => {
    calls.push(url);
    const body = url.includes('hardcover') ? { data: { search: { results: { hits } } } } : {};
    return { status: url.includes('hardcover') ? status : 200, text: async () => JSON.stringify(body), json: async () => body };
  };
  return { http, calls };
}

beforeEach(() => resetHardcoverThrottle());

describe('Hardcover catalog details', () => {
  it('maps a search hit and tidies user-entered moods', async () => {
    const book = await searchHardcover(fake().http, 'Foundryside', 'Robert Jackson Bennett', 'hc_pat_x');
    expect(book).toMatchObject({
      id: '41398',
      slug: 'foundryside',
      moods: ['Adventurous', 'Mysterious', 'Dark', 'Tense', 'Funny'],
      genres: ['Fantasy', 'Science Fiction', 'Magic'],
      rating: 4.22,
      series: 'The Founders Trilogy',
      series_position: 1,
      release_year: 2018,
      pages: 512,
    });
  });

  it('ignores a hit for a different book', async () => {
    const other = [{ document: { ...HIT, title: 'The Way of Kings', author_names: ['Brandon Sanderson'] } }];
    expect(await searchHardcover(fake(200, other).http, 'Foundryside', 'Robert Jackson Bennett', 'k')).toBeNull();
  });

  it('looks each book up once across users, and backs off on 429 without caching', async () => {
    const { db } = makeTestApp();
    const busy = fake(429);
    expect(await hardcoverBook(db, busy.http, 'Foundryside', 'Robert Jackson Bennett', 'k')).toBe('later');
    expect(db.prepare('SELECT COUNT(*) AS n FROM catalog_cache').get()).toMatchObject({ n: 0 });

    resetHardcoverThrottle();
    const ok = fake();
    await hardcoverBook(db, ok.http, 'Foundryside', 'Robert Jackson Bennett', 'k');
    await hardcoverBook(db, ok.http, 'Foundryside: A Novel', 'Bennett, Robert Jackson', 'k'); // same book, other user
    expect(ok.calls).toHaveLength(1);
  });

  it('stores details on the book and returns them in the book list', async () => {
    const { app, db } = makeTestApp();
    const { username, headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: '/body/DocFragment[2]', percentage: 0.2, device: 'X4', device_id: 'x4',
        metadata: { title: 'Foundryside', authors: 'Robert Jackson Bennett' } }),
    });
    const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
    const info = await documentInfo(db, id, DOC, fake().http, { HARDCOVER_API_KEY: 'k' }, { hardcover: true });
    expect(info.pages).toBe(512); // Hardcover fills the page count the free sources missed

    const list = (await (await app.request('/api/v1/progress', { headers })).json()) as { items: any[] };
    expect(list.items[0]).toMatchObject({
      moods: ['Adventurous', 'Mysterious', 'Dark', 'Tense', 'Funny'],
      series: 'The Founders Trilogy',
      series_position: 1,
      hardcover_slug: 'foundryside',
      rating: 4.22,
    });
  });
});

describe('next in series', () => {
  const book = (position: number, title: string) => ({ position, title, author: 'Robert Jackson Bennett', year: null, slug: null, cover: null });

  it('picks the next whole-numbered book, skipping novellas', () => {
    const list = [book(1, 'Foundryside'), book(1.5, 'A Novella'), book(2, 'Shorefall'), book(3, 'Locklands')];
    expect(nextAfter(list, 1)?.title).toBe('Shorefall');
    expect(nextAfter(list, 3)).toBeNull();
    expect(nextAfter([book(1, 'A'), book(1.5, 'B')], 1)?.title).toBe('B'); // only a novella left
  });

  it('serves the next book for a finished series book', async () => {
    const series = {
      data: {
        book_series: [
          { position: 1, book: { title: 'Foundryside', slug: 'foundryside', release_year: 2018, cached_contributors: [{ author: { name: 'Robert Jackson Bennett' } }], cached_image: { url: 'https://img/1.jpg' } } },
          { position: 2, book: { title: 'Shorefall', slug: 'shorefall', release_year: 2020, cached_contributors: [{ author: { name: 'Robert Jackson Bennett' } }], cached_image: { url: 'https://img/2.jpg' } } },
        ],
      },
    };
    const http: HttpTransport = async (url, init) => {
      const isSeries = url.includes('hardcover') && (init.body ?? '').includes('book_series');
      const body = !url.includes('hardcover') ? {} : isSeries ? series : { data: { search: { results: { hits: [{ document: HIT }] } } } };
      return { status: 200, text: async () => JSON.stringify(body), json: async () => body };
    };
    const { app, db } = makeTestApp({}, { connectorTransport: http });
    const { username, headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: '/body/DocFragment[2]', percentage: 1, device: 'X4', device_id: 'x4',
        metadata: { title: 'Foundryside', authors: 'Robert Jackson Bennett' } }),
    });
    const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
    await documentInfo(db, id, DOC, http, { HARDCOVER_API_KEY: 'k' }, { hardcover: true });
    process.env.HARDCOVER_API_KEY = 'k';
    try {
      const r = (await (await app.request(`/api/v1/documents/${DOC}/next`, { headers })).json()) as any;
      expect(r).toMatchObject({ series: 'The Founders Trilogy', next: { title: 'Shorefall', position: 2, year: 2020, cover: 'https://img/2.jpg' } });
    } finally {
      delete process.env.HARDCOVER_API_KEY;
    }
  });
});
