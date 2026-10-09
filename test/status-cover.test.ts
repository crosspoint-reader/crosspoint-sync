import { describe, expect, it } from 'vitest';
import type { HttpTransport } from '../src/connectors/types.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

const PUT_BODY = {
  document: DOC,
  progress: '/body/DocFragment[16]/body/div[1]/p[143]',
  percentage: 0.2853,
  device: 'CrossPoint',
  device_id: 'crosspoint-reader',
  metadata: { title: 'Foundryside', authors: 'Robert Jackson Bennett' },
};

function json(body: unknown) {
  return { status: 200, text: async () => JSON.stringify(body), json: async () => body };
}

describe('reading status', () => {
  it('derives from progress, then a manual status overrides and clears', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', { method: 'PUT', headers, body: JSON.stringify(PUT_BODY) });
    const list = async () => (await (await app.request('/api/v1/progress', { headers })).json()).items[0];
    expect((await list()).status).toBe('reading');

    const set = (status: unknown) =>
      app.request(`/api/v1/documents/${DOC}/status`, { method: 'PUT', headers, body: JSON.stringify({ status }) });
    expect((await set('dnf')).status).toBe(200);
    expect((await list()).status).toBe('dnf');
    expect((await set('bogus')).status).toBe(403);
    await set(null);
    expect((await list()).status).toBe('reading');
  });
});

describe('covers, page counts and activity', () => {
  it('falls back to Open Library for the cover, caches, and derives pages from history', async () => {
    const calls: string[] = [];
    const http: HttpTransport = async (url) => {
      calls.push(url);
      if (url.includes('itunes')) {
        return json({ results: [{ trackName: 'Something Else', artistName: 'Nobody', artworkUrl100: 'x/100x100bb.jpg' }] });
      }
      return json({ docs: [{ title: 'Foundryside', author_name: ['Robert Jackson Bennett'], cover_i: 9252092, number_of_pages_median: 500 }] });
    };
    const { app } = makeTestApp({}, { connectorTransport: http });
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', { method: 'PUT', headers, body: JSON.stringify(PUT_BODY) });

    const info = async () => (await app.request(`/api/v1/documents/${DOC}/cover`, { headers })).json();
    const want = { url: 'https://covers.openlibrary.org/b/id/9252092-L.jpg', pages: 500 };
    expect(await info()).toEqual(want);
    expect(await info()).toEqual(want);
    expect(calls).toHaveLength(2); // both sources once, second ask served from the cache

    // Every progress change is logged; activity turns forward progress into print pages.
    const put = (percentage: number) =>
      app.request('/syncs/progress', { method: 'PUT', headers, body: JSON.stringify({ ...PUT_BODY, percentage }) });
    await put(0.2853); // unchanged position: not logged again
    await put(0.5);
    const act = await (await app.request('/api/v1/stats/activity', { headers })).json();
    expect(act.books[0]).toMatchObject({ document: DOC, page_count: 500, pages_read: 250, finished_at: null });
    expect(act.days.reduce((n: number, d: { pages: number }) => n + d.pages, 0)).toBe(107); // (0.5 - 0.2853) * 500
  });
});

describe('Amazon page count fallback (SearchAPI)', () => {
  it('uses Print length from the matched product only when Open Library has no page count', async () => {
    const { findBookInfo } = await import('../src/models/cover.js');
    const calls: string[] = [];
    const http: HttpTransport = async (url) => {
      calls.push(url);
      if (url.includes('itunes')) return json({ results: [] });
      if (url.includes('openlibrary')) return json({ docs: [{ title: 'From Below', author_name: ['Darcy Coates'], cover_i: 1 }] });
      if (url.includes('amazon_search')) {
        return json({
          organic_results: [
            { asin: '9124315540', title: 'Darcy Coates Collection 4 Books Set', authors: [{ name: 'Darcy Coates' }] },
            { asin: '1728220238', title: 'From Below', authors: [{ name: 'Darcy Coates' }] },
          ],
        });
      }
      expect(url).toContain('asin=1728220238');
      return json({ product: { specifications: [{ name: 'Print length', value: '480 pages' }] } });
    };
    const info = await findBookInfo(http, 'From Below', 'Darcy Coates', { SEARCHAPI_KEY: 'k' });
    expect(info.pages).toBe(480);
    expect(calls.filter((u) => u.includes('searchapi'))).toHaveLength(2);

    // No key: never called.
    calls.length = 0;
    expect((await findBookInfo(http, 'From Below', 'Darcy Coates', {})).pages).toBeNull();
    expect(calls.some((u) => u.includes('searchapi'))).toBe(false);
  });
});

describe('manual book info, cover candidates, all clippings', () => {
  it('keeps a manual cover and page count, and clears back to lookup', async () => {
    const http: HttpTransport = async (url) =>
      url.includes('itunes')
        ? json({ results: [{ trackName: 'Foundryside', artistName: 'Robert Jackson Bennett', artworkUrl100: 'https://a/100x100bb.jpg' }] })
        : json({ docs: [{ title: 'Foundryside', author_name: ['Robert Jackson Bennett'], cover_i: 7, number_of_pages_median: 500 }] });
    const { app } = makeTestApp({}, { connectorTransport: http });
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', { method: 'PUT', headers, body: JSON.stringify(PUT_BODY) });
    const put = (body: unknown) => app.request(`/api/v1/documents/${DOC}/info`, { method: 'PUT', headers, body: JSON.stringify(body) });

    expect((await put({ cover_url: 'javascript:alert(1)' })).status).toBe(403);
    expect((await put({ page_count: -3 })).status).toBe(403);
    expect(await (await put({ cover_url: 'https://mine/cover.jpg', page_count: 612 })).json()).toMatchObject({ cover_url: 'https://mine/cover.jpg', page_count: 612 });
    // A later lookup never overwrites manual values.
    expect(await (await app.request(`/api/v1/documents/${DOC}/cover`, { headers })).json()).toEqual({ url: 'https://mine/cover.jpg', pages: 612 });

    const cands = await (await app.request(`/api/v1/documents/${DOC}/cover/candidates`, { headers })).json();
    expect(cands.items.map((c: { source: string }) => c.source)).toEqual(['Apple Books', 'Open Library']);
    expect(cands.items[0].url).toBe('https://a/600x600bb.jpg');

    await put({ cover_url: null });
    expect((await (await app.request(`/api/v1/documents/${DOC}/cover`, { headers })).json()).url).toBe('https://a/600x600bb.jpg');
  });

  it('lists every live clipping across books, newest first', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const clip = (id: string, created_at: number) => ({ id, spine: 1, start_page: 0, end_page: 0, pages: 1, start_word: 0, end_word: 1, words: 1, chapter: 'One', text: `quote ${id}`, created_at });
    const other = 'b1b2c3d4e5f60718293a4b5c6d7e8f91';
    await app.request(`/api/v1/clippings/${DOC}`, { method: 'PUT', headers, body: JSON.stringify({ items: [clip('aaaaaaaaaaaaaaa1', 100), clip('aaaaaaaaaaaaaaa2', 300)] }) });
    await app.request(`/api/v1/clippings/${other}`, { method: 'PUT', headers, body: JSON.stringify({ items: [clip('bbbbbbbbbbbbbbb1', 200)] }) });
    await app.request(`/api/v1/clippings/${DOC}`, { method: 'PUT', headers, body: JSON.stringify({ items: [{ id: 'aaaaaaaaaaaaaaa1', deleted: 1 }] }) });
    const all = await (await app.request('/api/v1/clippings', { headers })).json();
    expect(all.items.map((i: { id: string; document: string }) => [i.id, i.document])).toEqual([
      ['aaaaaaaaaaaaaaa2', DOC],
      ['bbbbbbbbbbbbbbb1', other],
    ]);
  });
});

describe('covers for non-Latin titles', () => {
  it('finds a Japanese book in the Japanese Apple Books store and matches it by its title', async () => {
    const { findBookInfo } = await import('../src/models/cover.js');
    const stores: string[] = [];
    const http: HttpTransport = async (url) => {
      if (url.includes('itunes')) {
        const store = new URL(url).searchParams.get('country')!;
        stores.push(store);
        return json({
          results: store === 'jp'
            ? [
                { trackName: '変な家(6)', artistName: '雨穴 & 綾野暁', artworkUrl100: 'https://img/v6/100x100bb.jpg' },
                { trackName: '変な家2 ～11の間取り図～', artistName: '雨穴', artworkUrl100: 'https://img/v2/100x100bb.jpg' },
              ]
            : [],
        });
      }
      return json({ docs: [] });
    };
    const info = await findBookInfo(http, '変な家２ ～11の間取り図～', '雨穴', {});
    expect(stores).toEqual(['jp']);
    expect(info.cover).toBe('https://img/v2/600x600bb.jpg');
  });

  it('keeps letters and digits from every script when normalizing', async () => {
    const { normalizeText, scoreCandidate } = await import('../src/connectors/matching.js');
    expect(normalizeText('変な家２ ～11の間取り図～')).toBe('変な家2 11の間取り図');
    expect(normalizeText('Café Society')).toBe('cafe society');
    // A different volume of the same series doesn't pass for this one.
    expect(scoreCandidate('変な家２ ～11の間取り図～', '雨穴', { externalId: 'x', title: '変な家(6)', author: '雨穴 & 綾野暁' })).toBeLessThan(0.6);
  });
});

describe('editing a book\'s title and author', () => {
  it('sticks over device syncs and looks the book up again', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    const sync = (title: string, author: string) => app.request('/syncs/progress', {
      method: 'PUT', headers, body: JSON.stringify({ ...PUT_BODY, metadata: { title, authors: author } }),
    });
    await sync('変な家２ ～11の間取り図～', '雨穴');
    // A lookup already happened (and missed); an auto match and a manual one exist.
    db.prepare('UPDATE documents SET cover_checked_at = 1, hc_checked_at = 1').run();
    db.prepare("INSERT INTO connector_matches (user_id, connector_id, document, source, confidence, updated_at) VALUES (1, 'hardcover', ?, 'none', 0, 0)").run(DOC);
    db.prepare("INSERT INTO connector_matches (user_id, connector_id, document, external_id, source, confidence, updated_at) VALUES (1, 'kosync', ?, 'x', 'manual', 1, 0)").run(DOC);

    const res = await app.request(`/api/v1/documents/${DOC}/info`, {
      method: 'PUT', headers, body: JSON.stringify({ title: '  Strange Houses 2 ', author: 'Uketsu' }),
    });
    expect(await res.json()).toMatchObject({ title: 'Strange Houses 2', author: 'Uketsu' });
    const doc = db.prepare('SELECT cover_checked_at, hc_checked_at, meta_manual FROM documents WHERE document = ?').get(DOC);
    expect(doc).toEqual({ cover_checked_at: null, hc_checked_at: null, meta_manual: 1 });
    const matches = db.prepare('SELECT connector_id FROM connector_matches WHERE document = ?').all(DOC);
    expect(matches).toEqual([{ connector_id: 'kosync' }]); // only the user's own pick survives

    // The reader keeps sending its own metadata; the edit wins.
    await sync('変な家２ ～11の間取り図～', '雨穴');
    const items = (await (await app.request('/api/v1/progress', { headers })).json()).items;
    expect(items[0]).toMatchObject({ title: 'Strange Houses 2', author: 'Uketsu' });

    // A title can't be blanked.
    const blank = await app.request(`/api/v1/documents/${DOC}/info`, { method: 'PUT', headers, body: JSON.stringify({ title: '  ' }) });
    expect(blank.status).toBe(403);
  });
});
