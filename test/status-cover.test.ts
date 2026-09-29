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
