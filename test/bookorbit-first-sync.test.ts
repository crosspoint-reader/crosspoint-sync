import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { bookorbitConnector } from '../src/connectors/bookorbit.js';
import { drainQueue } from '../src/connectors/runner.js';
import { upsertAccount } from '../src/connectors/store.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import type { HttpTransport } from '../src/connectors/types.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY = 'c'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); vi.restoreAllMocks(); });

// A position BookOrbit saved last month, before CrossPoint Sync knew the book.
const REMOTE_TIME = Date.parse('2026-10-20T12:00:00Z');
const XPATH = '/body/DocFragment[30]/body/p[4]';

async function fixture(remotePercentage: number) {
  const calls: { url: string; method: string }[] = [];
  const http: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method });
    let body: unknown;
    if (url.endsWith('/auth/login')) body = { accessToken: 'token' };
    else if (url.endsWith('/auth/me')) body = { settings: { timezone: 'UTC' } };
    else if (url.includes('/books/search?')) body = [{ id: 12, title: 'Piranesi', authors: ['Susanna Clarke'] }];
    else if (url.endsWith('/books/12')) body = { files: [{ id: 71, format: 'epub', role: 'primary' }] };
    else if (url.endsWith('/books/files/71/progress') && init.method === 'GET') {
      body = { percentage: remotePercentage, koreaderProgress: XPATH, updatedAt: new Date(REMOTE_TIME).toISOString() };
    } else if (url.endsWith('/books/files/71/progress') && init.method === 'POST') body = {};
    else if (url.endsWith('/books/12/annotations') && init.method === 'POST') body = { id: 5 };
    else throw new Error(`Unexpected request: ${init.method} ${url}`);
    return { status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const highlights = vi.spyOn(bookorbitConnector, 'pullHighlights').mockResolvedValue([]);
  const { app, db } = makeTestApp({}, { connectorTransport: http });
  const { username, headers } = await registerUser(app);
  const { id } = db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number };
  upsertAccount(db, id, 'bookorbit', { server: 'first-sync.test', username, password: 'pw' }, null);
  return { app, db, http, headers, calls, highlights };
}

async function firstSync(f: Awaited<ReturnType<typeof fixture>>, percentage: number) {
  const put = await f.app.request('/syncs/progress', {
    method: 'PUT', headers: f.headers,
    body: JSON.stringify({ document: DOC, progress: '/body/DocFragment[1]/body/p[1]', percentage, device: 'X4',
      device_id: 'crosspoint-x4', metadata: { title: 'Piranesi', authors: 'Susanna Clarke' } }),
  });
  expect(put.status).toBe(200);
  await drainQueue(f.db, f.http, 10);
}

it('keeps a further BookOrbit position on the first sync and moves the device to it', async () => {
  const f = await fixture(60);
  await firstSync(f, 0);
  expect(f.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/progress'))).toEqual([]);
  // Highlights are left for Sync now: a big read-along EPUB must not hold up the position.
  expect(f.highlights).not.toHaveBeenCalled();
  const got = await (await f.app.request(`/syncs/progress/${DOC}`, { headers: f.headers })).json();
  expect(got).toMatchObject({ percentage: 0.6, progress: XPATH, device_id: 'bookorbit' });
  expect(f.db.prepare("SELECT status FROM connector_queue WHERE connector_id='bookorbit'").all())
    .toEqual([{ status: 'done' }]);
});

it('still pushes the device position on the first sync when the device is further', async () => {
  const f = await fixture(10);
  await firstSync(f, 0.5);
  const posts = f.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/books/files/71/progress'));
  expect(posts).toHaveLength(1);
});

it('sends a highlight synced before the book was matched once the match exists', async () => {
  const f = await fixture(10);
  vi.spyOn(bookorbitConnector, 'push');
  const clip = await f.app.request(`/api/v1/clippings/${DOC}`, {
    method: 'PUT', headers: f.headers,
    body: JSON.stringify({ items: [{ id: 'c0ffee0011223344', spine: 2, start_page: 1, end_page: 1, pages: 20,
      start_word: 0, end_word: 6, words: 6, para: 3, chapter: 'Chapter 1', text: 'A quiet house of tides.',
      created_at: 1764000000 }] }),
  });
  expect(clip.status).toBe(200);
  await firstSync(f, 0.5);
  await drainQueue(f.db, f.http, 10);
  const pushed = vi.mocked(bookorbitConnector.push).mock.calls.map(([, , ev]) => ev.kind);
  expect(pushed).toContain('highlight');
});

it('keeps a further BookOrbit position when a progress request makes the first match', async () => {
  const f = await fixture(60);
  await f.app.request('/syncs/progress', {
    method: 'PUT', headers: f.headers,
    body: JSON.stringify({ document: DOC, progress: '/body/DocFragment[1]/body/p[1]', percentage: 0, device: 'X4',
      device_id: 'crosspoint-x4', metadata: { title: 'Piranesi', authors: 'Susanna Clarke' } }),
  });
  // The device asks again before the queue has run, so the request makes the match.
  const got = await (await f.app.request(`/syncs/progress/${DOC}`, { headers: f.headers })).json();
  expect(got).toMatchObject({ percentage: 0.6, device_id: 'bookorbit' });
  await drainQueue(f.db, f.http, 10);
  expect(f.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/progress'))).toEqual([]);
});
