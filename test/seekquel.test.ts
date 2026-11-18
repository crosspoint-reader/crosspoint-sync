import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import type { HttpTransport, OutboundEvent } from '../src/connectors/types.js';
import { drainQueue } from '../src/connectors/runner.js';
import { claimReady } from '../src/connectors/queue.js';
import { seekquelBase, seekquelConnector } from '../src/connectors/seekquel.js';
import { upsertAccount } from '../src/connectors/store.js';
import { upsertProgress } from '../src/routes/kosync.js';

function fakeTransport() {
  const calls: { url: string; method: string; headers?: Record<string, string>; body?: string }[] = [];
  const handlers: { match: string; status: number; body: unknown }[] = [];
  const t: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const h = [...handlers].reverse().find((x) => url.includes(x.match));
    const status = h?.status ?? 200;
    const body = h?.body ?? {};
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body };
  };
  return { transport: t, calls, on: (m: string, s: number, b: unknown) => handlers.push({ match: m, status: s, body: b }) };
}

const SERVER = 'https://api.seekquel.app/koreader';
const CRED = { server: SERVER, key: 'ABCD-EFGH-IJKL-MNOP' };
const MATCH = { externalId: DOC, confidence: 1, title: 'Piranesi', author: 'Susanna Clarke' };
const progressEvent = (over: Partial<OutboundEvent> = {}): OutboundEvent => ({
  kind: 'progress',
  document: DOC,
  percentage: 0.42,
  progress: '/body/DocFragment[8]/body/p[4]/text()[1].96',
  timestamp: 1_760_000_000,
  ...over,
});
const body = (call: { body?: string }) => JSON.parse(call.body ?? '{}');
const BOOK_STATS = {
  v: 5, sessions: 9, seconds: 8400, pages: 310, completed: false, avg_fwd: 12, pace_n: 250, eta: 5400,
  start_manual: false, finish_manual: false, start_date: 1751000000, finished_date: 0,
  tod: [0, 3000, 4000, 1400], dow: [0, 0, 1200, 0, 2000, 3000, 2200],
};

const KEY = { TOKEN_ENC_KEY: 'a'.repeat(64) };
beforeEach(() => { Object.assign(process.env, KEY); resetEncryptionKeyCache(); });
afterEach(() => { vi.useRealTimers(); delete process.env.TOKEN_ENC_KEY; delete process.env.SEEKQUEL_URL; resetEncryptionKeyCache(); });

describe('seekquel connector (unit)', () => {
  it('points at Seekquel unless SEEKQUEL_URL says otherwise', () => {
    expect(seekquelBase({})).toBe('https://api.seekquel.app');
    expect(seekquelBase({ SEEKQUEL_URL: 'http://localhost:8000/' })).toBe('http://localhost:8000');
  });

  it('starts a device-code link as the crosspoint-sync client', async () => {
    const fake = fakeTransport();
    fake.on('/koreader/pair/start', 201, {
      device_code: 'd'.repeat(64),
      user_code: 'WXYZ-2345',
      verification_uri_complete: 'https://seekquel.app/settings/integrations/crosspoint-sync?pair=WXYZ-2345',
      expires_in: 900,
      interval: 5,
    });
    const start = await seekquelConnector.beginLink!(fake.transport);
    expect(body(fake.calls[0])).toEqual({ device_name: 'CrossPoint Sync', client: 'crosspoint-sync' });
    expect(start.userCode).toBe('WXYZ-2345');
    expect(start.verificationUri).toBe('https://seekquel.app/settings/integrations/crosspoint-sync');
    expect(start.verificationUriComplete).toContain('?pair=WXYZ-2345');
  });

  it('says why when Seekquel refuses to start a link', async () => {
    const fake = fakeTransport();
    fake.on('/koreader/pair/start', 422, { message: 'The selected client is invalid.' });
    await expect(seekquelConnector.beginLink!(fake.transport)).rejects.toThrow('The selected client is invalid.');
  });

  it('maps each poll answer, and keeps the key once approved', async () => {
    const fake = fakeTransport();
    fake.on('/koreader/pair/poll', 400, { error: { type: 'authorization_pending' } });
    expect((await seekquelConnector.pollLink!('dc', fake.transport)).status).toBe('pending');
    fake.on('/koreader/pair/poll', 400, { error: { type: 'access_denied' } });
    expect((await seekquelConnector.pollLink!('dc', fake.transport)).status).toBe('denied');
    fake.on('/koreader/pair/poll', 400, { error: { type: 'expired_token' } });
    expect((await seekquelConnector.pollLink!('dc', fake.transport)).status).toBe('expired');
    fake.on('/koreader/pair/poll', 200, { key: CRED.key, sync_url: SERVER, device_id: '01J' });
    const ok = await seekquelConnector.pollLink!('dc', fake.transport);
    expect(ok).toMatchObject({ status: 'ok', credential: CRED });
  });

  it('validates the key against /users/auth', async () => {
    const fake = fakeTransport();
    fake.on('/users/auth', 200, { authorized: 'OK' });
    expect((await seekquelConnector.validate(CRED, fake.transport)).ok).toBe(true);
    expect(fake.calls[0].headers?.['x-auth-user']).toBe(CRED.key);
    fake.on('/users/auth', 401, {});
    expect((await seekquelConnector.validate(CRED, fake.transport)).ok).toBe(false);
  });

  it('keeps a just-approved link through a rate limit or server error on the check', async () => {
    const fake = fakeTransport();
    fake.on('/users/auth', 429, {});
    expect((await seekquelConnector.validate(CRED, fake.transport)).ok).toBe(true);
    fake.on('/users/auth', 503, {});
    expect((await seekquelConnector.validate(CRED, fake.transport)).ok).toBe(true);
  });

  it('matches by document id, with no network', async () => {
    const fake = fakeTransport();
    const m = await seekquelConnector.match(CRED, { document: DOC, title: 'Piranesi', author: 'Susanna Clarke', filename: null }, fake.transport);
    expect(m).toMatchObject({ externalId: DOC, confidence: 1, title: 'Piranesi' });
    expect(fake.calls).toHaveLength(0);
  });

  it('sends progress with the book metadata and the position, minus an xpath Seekquel cannot store', async () => {
    const fake = fakeTransport();
    const r = await seekquelConnector.push(
      CRED,
      MATCH,
      progressEvent({ position: { pctQ: 420000, spine: 7, page: 3, pages: 20, xpath: `/body/${'p'.repeat(200)}` } }),
      fake.transport
    );
    expect(r.ok).toBe(true);
    const call = fake.calls[0];
    expect(call.method).toBe('PUT');
    expect(call.url).toBe(`${SERVER}/syncs/progress`);
    expect(call.headers?.['x-auth-user']).toBe(CRED.key);
    expect(body(call)).toEqual({
      document: DOC,
      progress: '/body/DocFragment[8]/body/p[4]/text()[1].96',
      percentage: 0.42,
      device: 'CrossPoint Sync',
      device_id: 'crosspoint-sync',
      position: { pctQ: 420000, spine: 7, page: 3, pages: 20 },
      metadata: { title: 'Piranesi', authors: 'Susanna Clarke' },
    });
  });

  it('marks a finished book Read after sending its place', async () => {
    const fake = fakeTransport();
    const r = await seekquelConnector.push(CRED, MATCH, progressEvent({ kind: 'finished', percentage: 1 }), fake.transport);
    expect(r.ok).toBe(true);
    expect(fake.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `PUT ${SERVER}/syncs/progress`,
      `PUT ${SERVER}/documents/${DOC}/status`,
    ]);
    expect(body(fake.calls[1])).toEqual({ status: 'read' });
  });

  it('sends a highlight with an id that stays the same when it is sent again', async () => {
    const fake = fakeTransport();
    const ev: OutboundEvent = {
      kind: 'highlight',
      document: DOC,
      timestamp: 1_760_000_000,
      highlight: { text: 'The Beauty of the House is immeasurable', note: 'yes', chapter: 'Part 1', spine: 2, startOffset: 10, endOffset: 49, highlightedAt: 1_759_000_000 },
    };
    await seekquelConnector.push(CRED, MATCH, ev, fake.transport);
    await seekquelConnector.push(CRED, MATCH, { ...ev, highlight: { ...ev.highlight!, note: 'edited' } }, fake.transport);
    const [first, second] = fake.calls.map(body);
    expect(fake.calls[0].url).toBe(`${SERVER}/highlights`);
    expect(first.document).toBe(DOC);
    expect(first.highlights[0]).toMatchObject({
      text: 'The Beauty of the House is immeasurable',
      note: 'yes',
      chapter: 'Part 1',
      created_at: new Date(1_759_000_000 * 1000).toISOString(),
    });
    expect(second.highlights[0].external_id).toBe(first.highlights[0].external_id);
  });

  it('retries highlights and the finished mark while Seekquel is still placing the book', async () => {
    const fake = fakeTransport();
    fake.on('/highlights', 409, { error: { code: 'DOCUMENT_NOT_LINKED' } });
    fake.on('/status', 409, { error: { code: 'DOCUMENT_NOT_LINKED' } });
    const highlight = await seekquelConnector.push(
      CRED,
      MATCH,
      { kind: 'highlight', document: DOC, timestamp: 1, highlight: { text: 'quote' } },
      fake.transport
    );
    const finished = await seekquelConnector.push(CRED, MATCH, progressEvent({ kind: 'finished', percentage: 1 }), fake.transport);
    expect(highlight).toMatchObject({ ok: false, retryable: true, error: expect.stringContaining('Seekquel') });
    expect(finished).toMatchObject({ ok: false, retryable: true, error: expect.stringContaining('Seekquel') });
  });

  it('turns a place Seekquel has read further than the device into a forward-only percentage', async () => {
    const fake = fakeTransport();
    fake.on(`/syncs/progress/${DOC}`, 200, {
      document: DOC, progress: 'seekquel-linked-copy', percentage: 0.5, device: 'Seekquel', device_id: 'seekquel', timestamp: 1_760_000_000,
    });
    const change = await seekquelConnector.pullProgress!(CRED, MATCH, fake.transport, 0);
    expect(change).toEqual({
      externalId: DOC, percentage: 0.5, finished: false, updatedAtMs: 1_760_000_000_000, furthestReadOnly: true,
    });
    expect(fake.calls[0]).toMatchObject({ method: 'GET', url: `${SERVER}/syncs/progress/${DOC}` });
    expect(fake.calls[0].headers?.['x-auth-user']).toBe(CRED.key);
  });

  it('ignores our own push read back, a missing book and an unusable answer', async () => {
    const fake = fakeTransport();
    fake.on(`/syncs/progress/${DOC}`, 200, { document: DOC, progress: '/body/p[2]', percentage: 0.42, device: 'CrossPoint Sync', device_id: 'crosspoint-sync' });
    expect(await seekquelConnector.pullProgress!(CRED, MATCH, fake.transport, 0)).toBeNull();
    fake.on(`/syncs/progress/${DOC}`, 404, {});
    expect(await seekquelConnector.pullProgress!(CRED, MATCH, fake.transport, 0)).toBeNull();
    fake.on(`/syncs/progress/${DOC}`, 200, { progress: 'seekquel-linked-copy', percentage: 'half' });
    expect(await seekquelConnector.pullProgress!(CRED, MATCH, fake.transport, 0)).toBeNull();
  });

  it('asks to link again on 401 and retries a rate limit or server error when pulling', async () => {
    const fake = fakeTransport();
    fake.on(`/syncs/progress/${DOC}`, 401, {});
    await expect(seekquelConnector.pullProgress!(CRED, MATCH, fake.transport, 0)).rejects.toMatchObject({ needsReauth: true });
    fake.on(`/syncs/progress/${DOC}`, 503, {});
    await expect(seekquelConnector.pullProgress!(CRED, MATCH, fake.transport, 0)).rejects.toMatchObject({ retryable: true, needsReauth: false });
  });

  it('sends a device\'s book totals in the shape Seekquel reads, and treats a closed route as final', async () => {
    const fake = fakeTransport();
    const event: OutboundEvent = { kind: 'stats', document: DOC, timestamp: 1_760_000_000, stats: { deviceId: 'crossink-9F8E7D6C', device: 'CrossInk', book: BOOK_STATS } };
    expect(await seekquelConnector.push(CRED, MATCH, event, fake.transport)).toEqual({ ok: true });
    expect(fake.calls[0]).toMatchObject({ method: 'PUT', url: `${SERVER}/api/v1/stats/books` });
    expect(fake.calls[0].headers?.['x-auth-user']).toBe(CRED.key);
    expect(body(fake.calls[0])).toEqual({ device_id: 'crossink-9F8E7D6C', device: 'CrossInk', recorded_at: 1_760_000_000, baseline: false, items: [{ document: DOC, ...BOOK_STATS }] });

    const pageOnly: OutboundEvent = { ...event, stats: { ...event.stats!, baseline: { seconds: BOOK_STATS.seconds, pages: BOOK_STATS.pages - 1, at: 1_759_999_000 } } };
    const pagesBefore = fake.calls.length;
    expect(await seekquelConnector.push(CRED, MATCH, pageOnly, fake.transport)).toEqual({ ok: true });
    expect(fake.calls.slice(pagesBefore).map((c) => body(c).baseline)).toEqual([true, false]);

    const absurd: OutboundEvent = { ...event, stats: { ...event.stats!, book: { ...BOOK_STATS, seconds: 2 ** 40 } } };
    await seekquelConnector.push(CRED, MATCH, absurd, fake.transport);
    expect(body(fake.calls.at(-1)!).items[0].seconds).toBe(2147483647);

    fake.on('/api/v1/stats/books', 404, {});
    expect(await seekquelConnector.push(CRED, MATCH, event, fake.transport)).toEqual({ ok: true });
    fake.on('/api/v1/stats/books', 422, {});
    expect(await seekquelConnector.push(CRED, MATCH, event, fake.transport)).toMatchObject({ ok: false, retryable: false });
    fake.on('/api/v1/stats/books', 503, {});
    expect(await seekquelConnector.push(CRED, MATCH, event, fake.transport)).toMatchObject({ ok: false, retryable: true });
    expect(await seekquelConnector.push(CRED, MATCH, { kind: 'stats', document: DOC, timestamp: 1 }, fake.transport)).toMatchObject({ ok: false, retryable: false });
  });

  it('asks to link again on 401, gives up on 403 without asking, and retries on 429 and server errors', async () => {
    const fake = fakeTransport();
    fake.on('/syncs/progress', 401, {});
    expect(await seekquelConnector.push(CRED, MATCH, progressEvent(), fake.transport)).toMatchObject({ ok: false, needsReauth: true });
    fake.on('/syncs/progress', 403, {});
    const forbidden = await seekquelConnector.push(CRED, MATCH, progressEvent(), fake.transport);
    expect(forbidden).toMatchObject({ ok: false, retryable: false });
    expect(forbidden).not.toHaveProperty('needsReauth');
    fake.on('/syncs/progress', 429, {});
    expect(await seekquelConnector.push(CRED, MATCH, progressEvent(), fake.transport)).toMatchObject({ ok: false, retryable: true });
    fake.on('/syncs/progress', 503, {});
    expect(await seekquelConnector.push(CRED, MATCH, progressEvent(), fake.transport)).toMatchObject({ ok: false, retryable: true });
  });
});

async function linkSeekquel(fake: ReturnType<typeof fakeTransport>) {
  const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
  const { headers } = await registerUser(app);
  fake.on('/koreader/pair/start', 201, { device_code: 'd'.repeat(64), user_code: 'WXYZ-2345', verification_uri_complete: 'https://seekquel.app/settings/integrations/crosspoint-sync?pair=WXYZ-2345' });
  const begin = await app.request('/api/v1/connectors/seekquel/link/begin', { method: 'POST', headers });
  const { device_code } = await begin.json();
  fake.on('/koreader/pair/poll', 200, { key: CRED.key, sync_url: SERVER, device_id: '01J' });
  fake.on('/users/auth', 200, { authorized: 'OK' });
  const poll = await app.request('/api/v1/connectors/seekquel/link/poll', { method: 'POST', headers, body: JSON.stringify({ device_code }) });
  return { app, db, headers, linked: (await poll.json()).linked as boolean };
}

describe('seekquel connector (end to end)', () => {
  it('links by device code, then delivers a device sync with the title the device sent', async () => {
    const fake = fakeTransport();
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);

    fake.on('/koreader/pair/start', 201, { device_code: 'd'.repeat(64), user_code: 'WXYZ-2345', verification_uri_complete: 'https://seekquel.app/settings/integrations/crosspoint-sync?pair=WXYZ-2345' });
    const begin = await app.request('/api/v1/connectors/seekquel/link/begin', { method: 'POST', headers });
    expect(begin.status).toBe(200);
    const { device_code } = await begin.json();

    fake.on('/koreader/pair/poll', 200, { key: CRED.key, sync_url: SERVER, device_id: '01J' });
    fake.on('/users/auth', 200, { authorized: 'OK' });
    const poll = await app.request('/api/v1/connectors/seekquel/link/poll', { method: 'POST', headers, body: JSON.stringify({ device_code }) });
    expect((await poll.json()).linked).toBe(true);

    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        document: DOC,
        progress: '/body/p[2]',
        percentage: 0.5,
        device_id: 'd1',
        metadata: { title: 'Piranesi', authors: 'Susanna Clarke', filename: 'piranesi.epub' },
      }),
    });
    expect(claimReady(db, 10).length).toBeGreaterThan(0);
    await drainQueue(db, fake.transport, 10);

    const sent = fake.calls.find((c) => c.url === `${SERVER}/syncs/progress`);
    expect(sent?.method).toBe('PUT');
    expect(body(sent!)).toMatchObject({
      document: DOC,
      percentage: 0.5,
      device_id: 'crosspoint-sync',
      metadata: { title: 'Piranesi', authors: 'Susanna Clarke', filename: 'piranesi.epub' },
    });
  });

  it('marks a book Read once, and again only after the device has gone back below the end', async () => {
    const fake = fakeTransport();
    const { app, db, headers, linked } = await linkSeekquel(fake);
    expect(linked).toBe(true);
    // Devices only move forward; going back is an explicit PUT /api/v1/progress.
    const sync = async (percentage: number, path = '/syncs/progress') => {
      await app.request(path, {
        method: 'PUT',
        headers,
        body: JSON.stringify({ document: DOC, progress: '/body/p[9]', percentage, device_id: 'd1', metadata: { title: 'Piranesi', authors: 'Susanna Clarke' } }),
      });
      await drainQueue(db, fake.transport, 10);
    };
    const statusCalls = () => fake.calls.filter((c) => c.url.endsWith('/status')).length;

    await sync(1);
    expect(statusCalls()).toBe(1);
    await sync(1);
    expect(statusCalls()).toBe(1);
    await sync(0.1, '/api/v1/progress');
    expect(statusCalls()).toBe(1);
    await sync(1);
    expect(statusCalls()).toBe(2);
  });

  it('hands the device the place Seekquel has read to, and never moves it backwards', async () => {
    const fake = fakeTransport();
    const { app, db, headers, linked } = await linkSeekquel(fake);
    expect(linked).toBe(true);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: '/body/p[2]', percentage: 0.2, device: "El's X4 Pro", device_id: 'crosspoint-a1b2c3', metadata: { title: 'Piranesi', authors: 'Susanna Clarke' } }),
    });
    await drainQueue(db, fake.transport, 10);

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
    const read = async () => (await (await app.request(`/syncs/progress/${DOC}`, { headers })).json()) as { percentage: number };

    fake.on(`/syncs/progress/${DOC}`, 200, { document: DOC, progress: 'seekquel-linked-copy', percentage: 0.5, device: 'Seekquel', device_id: 'seekquel', timestamp: 1_760_000_000 });
    expect((await read()).percentage).toBe(0.5);

    fake.on(`/syncs/progress/${DOC}`, 200, { document: DOC, progress: 'seekquel-linked-copy', percentage: 0.3, device: 'Seekquel', device_id: 'seekquel', timestamp: 1_760_000_100 });
    expect((await read()).percentage).toBe(0.5);
  });

  it('hands a CrossInk reader the place too', async () => {
    const fake = fakeTransport();
    const { app, db, headers } = await linkSeekquel(fake);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: '/body/p[2]', percentage: 0.2, device: 'CrossInk X4', device_id: 'crossink-9f8e7d', metadata: { title: 'Piranesi', authors: 'Susanna Clarke' } }),
    });
    await drainQueue(db, fake.transport, 10);

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
    fake.on(`/syncs/progress/${DOC}`, 200, { document: DOC, progress: 'seekquel-linked-copy', percentage: 0.5, device: 'Seekquel', device_id: 'seekquel', timestamp: 1_760_000_000 });
    const got = (await (await app.request(`/syncs/progress/${DOC}`, { headers })).json()) as { percentage: number };
    expect(got.percentage).toBe(0.5);
  });

  it('never hands a bare percentage to a book a stock KOReader has synced', async () => {
    const fake = fakeTransport();
    const { app, db, headers, linked } = await linkSeekquel(fake);
    expect(linked).toBe(true);
    const put = (device: string, device_id: string, percentage: number) => app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: '/body/p[2]', percentage, device, device_id, metadata: { title: 'Piranesi', authors: 'Susanna Clarke' } }),
    });
    await put("El's X4 Pro", 'crosspoint-a1b2c3', 0.2);
    await put('CrossPoint', 'kindle-paperwhite-uuid', 0.2);
    await drainQueue(db, fake.transport, 10);

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
    fake.on(`/syncs/progress/${DOC}`, 200, { document: DOC, progress: 'seekquel-linked-copy', percentage: 0.5, device: 'Seekquel', device_id: 'seekquel', timestamp: 1_760_000_000 });
    const got = (await (await app.request(`/syncs/progress/${DOC}`, { headers })).json()) as { percentage: number };
    expect(got.percentage).toBe(0.2);
  });

  it('is not held back by a service that was linked once and has since been unlinked', async () => {
    const fake = fakeTransport();
    const { app, db, headers } = await linkSeekquel(fake);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: '/body/p[2]', percentage: 0.2, device: 'CrossPoint', device_id: 'crosspoint-a1b2c3', metadata: { title: 'Piranesi', authors: 'Susanna Clarke' } }),
    });
    const userId = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number }).id;
    upsertProgress(db, { userId, document: DOC, deviceId: 'spotify', device: 'Spotify', percentage: 0.1, progress: 'spotify:100000', position: null, metadata: null, updatedAt: 1_760_000_000 });
    await drainQueue(db, fake.transport, 10);

    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
    fake.on(`/syncs/progress/${DOC}`, 200, { document: DOC, progress: 'seekquel-linked-copy', percentage: 0.5, device: 'Seekquel', device_id: 'seekquel', timestamp: 1_760_000_000 });
    const got = (await (await app.request(`/syncs/progress/${DOC}`, { headers })).json()) as { percentage: number };
    expect(got.percentage).toBe(0.5);
  });

  it('checks the book under our own id, and again once Seekquel has answered', async () => {
    const fake = fakeTransport();
    const { db } = await linkSeekquel(fake);
    const userId = (db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number }).id;
    const OTHER = 'f'.repeat(32);
    const stock = (document: string) => upsertProgress(db, { userId, document, deviceId: 'kindle-paperwhite-uuid', device: 'Kindle', percentage: 0.2, progress: '/body/p[2]', position: null, metadata: null, updatedAt: 1_760_000_000 });
    fake.on(`/syncs/progress/${DOC}`, 200, { document: DOC, progress: 'seekquel-linked-copy', percentage: 0.5, device: 'Seekquel', device_id: 'seekquel', timestamp: 1_760_000_000 });

    const linkCalls = fake.calls.length;

    stock(OTHER);
    expect(await seekquelConnector.pullProgress!(CRED, MATCH, fake.transport, 0, { db, userId, document: OTHER })).toBeNull();
    expect(fake.calls).toHaveLength(linkCalls);

    const midRequest: HttpTransport = async (url, init) => {
      stock(DOC);
      return fake.transport(url, init);
    };
    expect(await seekquelConnector.pullProgress!(CRED, MATCH, midRequest, 0, { db, userId, document: DOC })).toBeNull();
    expect(fake.calls).toHaveLength(linkCalls + 1);
  });

  it('forwards a CrossInk reader\'s book totals once they are uploaded, one snapshot per device', async () => {
    const fake = fakeTransport();
    const { app, db, headers, linked } = await linkSeekquel(fake);
    expect(linked).toBe(true);
    const put = (device_id: string, device: string, seconds: number) => app.request('/api/v1/stats/books', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id, device, items: [{ document: DOC, ...BOOK_STATS, seconds }] }),
    });
    expect((await put('crossink-aaaa', 'CrossInk', 600)).status).toBe(200);
    expect((await put('crossink-aaaa', 'CrossInk', 900)).status).toBe(200);
    expect((await put('crossink-bbbb', 'CrossInk', 300)).status).toBe(200);
    await drainQueue(db, fake.transport, 10);

    const sent = fake.calls.filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    // The first reader's two uploads arrive as its first total, kept as the starting point, then the latest.
    const first = sent.filter((s) => s.device_id === 'crossink-aaaa');
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ device: 'CrossInk', baseline: true, items: [{ document: DOC, seconds: 600 }] });
    expect(first[1]).toMatchObject({ baseline: false, items: [{ document: DOC, seconds: 900 }] });
    expect(sent.filter((s) => s.device_id === 'crossink-bbbb')).toEqual([expect.objectContaining({ baseline: false, items: [expect.objectContaining({ document: DOC, seconds: 300 })] })]);
  });

  it('forwards the reading time a KOReader history sync adds, as one running total for that source', async () => {
    const fake = fakeTransport();
    const { app, db, headers, linked } = await linkSeekquel(fake);
    expect(linked).toBe(true);
    const startTime = Date.parse('2025-11-02T03:30:00Z') / 1000;
    const upload = (pages: { page: number; total_pages: number; start_time: number; duration: number }[]) =>
      app.request('/api/v1/stats/koreader', {
        method: 'POST',
        headers,
        body: JSON.stringify({ version: 1, book: { md5: DOC, title: 'Piranesi', authors: 'Susanna Clarke' }, timezone: 'Europe/London', pages }),
      });
    expect((await upload([{ page: 10, total_pages: 100, start_time: startTime, duration: 30 }])).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    expect((await upload([{ page: 11, total_pages: 100, start_time: startTime + 60, duration: 45 }])).status).toBe(200);
    await drainQueue(db, fake.transport, 10);

    const sent = fake.calls.filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ device_id: 'import:koinsight', device: 'KOReader', baseline: true, items: [{ document: DOC, seconds: 30, pages: 1 }] });
    expect(sent[1]).toMatchObject({ device_id: 'import:koinsight', baseline: true, items: [{ document: DOC, seconds: 75, pages: 2 }] });

    const recent = Math.floor(Date.now() / 1000) - 600;
    const again = [{ page: 10, total_pages: 100, start_time: startTime, duration: 30 }, { page: 11, total_pages: 100, start_time: startTime + 60, duration: 45 }];
    expect((await upload([...again, { page: 12, total_pages: 100, start_time: recent, duration: 120 }])).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    const latest = fake.calls.filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body).at(-1);
    expect(latest).toMatchObject({ baseline: false, items: [{ document: DOC, seconds: 195, pages: 3 }] });
  });

  it('credits the first session of a book KOReader has only just started', async () => {
    const fake = fakeTransport();
    const { app, db, headers } = await linkSeekquel(fake);
    const recent = Math.floor(Date.now() / 1000) - 900;
    const res = await app.request('/api/v1/stats/koreader', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1, book: { md5: DOC, title: 'Piranesi', authors: 'Susanna Clarke' }, timezone: 'Europe/London',
        pages: [{ page: 1, total_pages: 100, start_time: recent, duration: 120 }, { page: 2, total_pages: 100, start_time: recent + 130, duration: 90 }],
      }),
    });
    expect(res.status).toBe(200);
    await drainQueue(db, fake.transport, 10);

    const sent = fake.calls.filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ baseline: true, recorded_at: recent, items: [{ document: DOC, seconds: 0, pages: 0 }] });
    expect(sent[1]).toMatchObject({ baseline: false, items: [{ document: DOC, seconds: 210, pages: 2 }] });
  });

  it('sends an upload that mixes old and recent records as the history first, then the recent reading', async () => {
    const fake = fakeTransport();
    const { app, db, headers } = await linkSeekquel(fake);
    const old = Date.parse('2025-11-02T03:30:00Z') / 1000;
    const recent = Math.floor(Date.now() / 1000) - 900;
    const res = await app.request('/api/v1/stats/koreader', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1, book: { md5: DOC, title: 'Piranesi', authors: 'Susanna Clarke' }, timezone: 'Europe/London',
        pages: [{ page: 10, total_pages: 100, start_time: old, duration: 60 }, { page: 11, total_pages: 100, start_time: recent, duration: 120 }],
      }),
    });
    expect(res.status).toBe(200);
    await drainQueue(db, fake.transport, 10);

    const sent = fake.calls.filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ baseline: true, recorded_at: recent, items: [{ document: DOC, seconds: 60, pages: 1 }] });
    expect(sent[1]).toMatchObject({ baseline: false, items: [{ document: DOC, seconds: 180, pages: 2 }] });
    expect(sent[1].recorded_at).toBeGreaterThanOrEqual(recent + 120);
  });

  it('keeps history that is still waiting when a later upload replaces it in the queue', async () => {
    const fake = fakeTransport();
    const { app, db, headers } = await linkSeekquel(fake);
    const old = Date.parse('2025-11-02T03:30:00Z') / 1000;
    const recent = Math.floor(Date.now() / 1000) - 900;
    const upload = (pages: { page: number; total_pages: number; start_time: number; duration: number }[]) =>
      app.request('/api/v1/stats/koreader', {
        method: 'POST',
        headers,
        body: JSON.stringify({ version: 1, book: { md5: DOC, title: 'Piranesi', authors: 'Susanna Clarke' }, timezone: 'Europe/London', pages }),
      });
    const history = [{ page: 10, total_pages: 100, start_time: old, duration: 60 }];

    fake.on('/api/v1/stats/books', 503, {});
    expect((await upload(history)).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    // The same upload again adds nothing, and must not turn the waiting history into reading.
    expect((await upload(history)).status).toBe(200);
    expect((await upload([...history, { page: 11, total_pages: 100, start_time: recent, duration: 120 }])).status).toBe(200);

    const before = fake.calls.length;
    fake.on('/api/v1/stats/books', 200, {});
    db.prepare("UPDATE connector_queue SET next_try_at = 0 WHERE status = 'pending'").run();
    await drainQueue(db, fake.transport, 10);
    const sent = fake.calls.slice(before).filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ baseline: true, items: [{ document: DOC, seconds: 60 }] });
    expect(sent[1]).toMatchObject({ baseline: false, items: [{ document: DOC, seconds: 180 }] });
  });

  it('keeps recent reading that is still waiting when history arrives after it', async () => {
    const fake = fakeTransport();
    const { app, db, headers } = await linkSeekquel(fake);
    const old = Date.parse('2025-11-02T03:30:00Z') / 1000;
    const recent = Math.floor(Date.now() / 1000) - 1800;
    const upload = (pages: { page: number; total_pages: number; start_time: number; duration: number }[]) =>
      app.request('/api/v1/stats/koreader', {
        method: 'POST',
        headers,
        body: JSON.stringify({ version: 1, book: { md5: DOC, title: 'Piranesi', authors: 'Susanna Clarke' }, timezone: 'Europe/London', pages }),
      });
    const first = [{ page: 10, total_pages: 100, start_time: recent, duration: 100 }];
    expect((await upload(first)).status).toBe(200);
    await drainQueue(db, fake.transport, 10);

    fake.on('/api/v1/stats/books', 503, {});
    const second = [...first, { page: 11, total_pages: 100, start_time: recent + 200, duration: 120 }];
    expect((await upload(second)).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    expect((await upload([...second, { page: 5, total_pages: 100, start_time: old, duration: 60 }, { page: 12, total_pages: 100, start_time: recent + 400, duration: 30 }])).status).toBe(200);

    const before = fake.calls.length;
    fake.on('/api/v1/stats/books', 200, {});
    db.prepare("UPDATE connector_queue SET next_try_at = 0 WHERE status = 'pending'").run();
    await drainQueue(db, fake.transport, 10);
    const sent = fake.calls.slice(before).filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(sent).toHaveLength(2);
    // 100 already delivered plus the 60 of history; the 120 and the 30 are still new reading.
    expect(sent[0]).toMatchObject({ baseline: true, items: [{ document: DOC, seconds: 160 }] });
    expect(sent[1]).toMatchObject({ baseline: false, items: [{ document: DOC, seconds: 310 }] });
  });

  it('starts a book that had a zero total before the link from zero', async () => {
    const fake = fakeTransport();
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const put = (seconds: number, pages: number) => app.request('/api/v1/stats/books', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: 'crossink-aaaa', device: 'CrossInk', items: [{ document: DOC, ...BOOK_STATS, sessions: 0, seconds, pages }] }),
    });
    expect((await put(0, 0)).status).toBe(200);
    fake.on('/koreader/pair/start', 201, { device_code: 'd'.repeat(64), user_code: 'WXYZ-2345', verification_uri_complete: 'https://seekquel.app/settings/integrations/crosspoint-sync?pair=WXYZ-2345' });
    const { device_code } = await (await app.request('/api/v1/connectors/seekquel/link/begin', { method: 'POST', headers })).json();
    fake.on('/koreader/pair/poll', 200, { key: CRED.key, sync_url: SERVER, device_id: '01J' });
    fake.on('/users/auth', 200, { authorized: 'OK' });
    await app.request('/api/v1/connectors/seekquel/link/poll', { method: 'POST', headers, body: JSON.stringify({ device_code }) });

    expect((await put(300, 10)).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    const sent = fake.calls.filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ baseline: true, items: [{ document: DOC, seconds: 0 }] });
    expect(sent[1]).toMatchObject({ baseline: false, items: [{ document: DOC, seconds: 300 }] });
  });

  it('does not mark a newer total done when it replaced one that was being delivered', async () => {
    const fake = fakeTransport();
    const { app, db, headers } = await linkSeekquel(fake);
    const put = (seconds: number) => app.request('/api/v1/stats/books', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: 'crossink-aaaa', device: 'CrossInk', items: [{ document: DOC, ...BOOK_STATS, seconds }] }),
    });
    expect((await put(600)).status).toBe(200);
    let raced = false;
    const racing: HttpTransport = async (url, init) => {
      if (!raced && url.endsWith('/api/v1/stats/books')) {
        raced = true;
        expect((await put(900)).status).toBe(200);
      }
      return fake.transport(url, init);
    };
    await drainQueue(db, racing, 10);
    expect(db.prepare("SELECT status FROM connector_queue WHERE kind = 'stats:crossink-aaaa'").get()).toMatchObject({ status: 'pending' });
    await drainQueue(db, fake.transport, 10);
    const sent = fake.calls.filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(sent.at(-1)).toMatchObject({ items: [{ document: DOC, seconds: 900 }] });
    expect(db.prepare("SELECT status FROM connector_queue WHERE kind = 'stats:crossink-aaaa'").get()).toMatchObject({ status: 'done' });
  });

  it('sends a dead-lettered total again on Sync now, still crediting what it had not delivered', async () => {
    const fake = fakeTransport();
    const { app, db, headers } = await linkSeekquel(fake);
    const put = (seconds: number) => app.request('/api/v1/stats/books', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: 'crossink-aaaa', device: 'CrossInk', items: [{ document: DOC, ...BOOK_STATS, seconds }] }),
    });
    expect((await put(600)).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    fake.on('/api/v1/stats/books', 422, {});
    expect((await put(900)).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    expect(db.prepare("SELECT status FROM connector_queue WHERE kind = 'stats:crossink-aaaa'").get()).toMatchObject({ status: 'dead' });

    const before = fake.calls.length;
    fake.on('/api/v1/stats/books', 200, {});
    expect((await app.request('/api/v1/connectors/seekquel/sync', { method: 'POST', headers })).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    const sent = fake.calls.slice(before).filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ baseline: true, items: [{ document: DOC, seconds: 600 }] });
    expect(sent[1]).toMatchObject({ baseline: false, items: [{ document: DOC, seconds: 900 }] });
  });

  it('treats a copy merged in after the link as history, and sends both hashes of one book once', async () => {
    const fake = fakeTransport();
    const { app, db, headers } = await linkSeekquel(fake);
    const alias = 'b'.repeat(32);
    const userId = Number((db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number }).id);
    const put = (items: { document: string; seconds: number }[]) => app.request('/api/v1/stats/books', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: 'crossink-aaaa', device: 'CrossInk', items: items.map((i) => ({ ...BOOK_STATS, pages: 10, ...i })) }),
    });
    expect((await put([{ document: alias, seconds: 5000 }])).status).toBe(200);
    expect((await put([{ document: DOC, seconds: 600 }])).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    db.prepare("DELETE FROM connector_queue WHERE document = ?").run(alias);
    db.prepare('INSERT INTO document_aliases (user_id, alias, document, created_at, merge_stats) VALUES (?, ?, ?, ?, 1)')
      .run(userId, alias, DOC, 1);

    const before = fake.calls.length;
    expect((await put([{ document: DOC, seconds: 900 }, { document: alias, seconds: 5000 }])).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    const sent = fake.calls.slice(before).filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(sent).toHaveLength(2);
    // The merged copy's 5000 is history; only the 300 read since is new.
    expect(sent[0]).toMatchObject({ baseline: true, items: [{ document: DOC, seconds: 5600 }] });
    expect(sent[1]).toMatchObject({ baseline: false, items: [{ document: DOC, seconds: 5900 }] });
  });

  it('keeps a first total that is still waiting as the starting point for the next one', async () => {
    const fake = fakeTransport();
    const { app, db, headers } = await linkSeekquel(fake);
    const put = (seconds: number, pages: number) => app.request('/api/v1/stats/books', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: 'crossink-aaaa', device: 'CrossInk', items: [{ document: DOC, ...BOOK_STATS, seconds, pages }] }),
    });
    fake.on('/api/v1/stats/books', 503, {});
    expect((await put(600, 20)).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    expect((await put(900, 30)).status).toBe(200);

    const before = fake.calls.length;
    fake.on('/api/v1/stats/books', 200, {});
    db.prepare("UPDATE connector_queue SET next_try_at = 0 WHERE status = 'pending'").run();
    await drainQueue(db, fake.transport, 10);
    const sent = fake.calls.slice(before).filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ baseline: true, items: [{ document: DOC, seconds: 600, pages: 20 }] });
    expect(sent[1]).toMatchObject({ baseline: false, items: [{ document: DOC, seconds: 900, pages: 30 }] });
  });

  it('treats pages a merged copy adds as history even when the seconds did not change', async () => {
    const fake = fakeTransport();
    const { app, db, headers } = await linkSeekquel(fake);
    const alias = 'b'.repeat(32);
    const userId = Number((db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number }).id);
    const put = (document: string, seconds: number, pages: number) => app.request('/api/v1/stats/books', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: 'crossink-aaaa', device: 'CrossInk', items: [{ document, ...BOOK_STATS, seconds, pages }] }),
    });
    expect((await put(alias, 0, 50)).status).toBe(200);
    expect((await put(DOC, 600, 10)).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    db.prepare("DELETE FROM connector_queue WHERE document = ?").run(alias);
    db.prepare('INSERT INTO document_aliases (user_id, alias, document, created_at, merge_stats) VALUES (?, ?, ?, ?, 1)')
      .run(userId, alias, DOC, 1);

    const before = fake.calls.length;
    expect((await put(DOC, 600, 12)).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    const sent = fake.calls.slice(before).filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ baseline: true, items: [{ document: DOC, seconds: 600, pages: 60 }] });
    expect(sent[1]).toMatchObject({ baseline: false, items: [{ document: DOC, seconds: 600, pages: 62 }] });
  });

  it('sends history a merged copy adds while a total is waiting as history, not as reading', async () => {
    const fake = fakeTransport();
    const { app, db, headers } = await linkSeekquel(fake);
    const alias = 'b'.repeat(32);
    const userId = Number((db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number }).id);
    const put = (document: string, seconds: number, pages: number) => app.request('/api/v1/stats/books', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: 'crossink-aaaa', device: 'CrossInk', items: [{ document, ...BOOK_STATS, seconds, pages }] }),
    });
    expect((await put(alias, 5000, 10)).status).toBe(200);
    expect((await put(DOC, 600, 10)).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    db.prepare("DELETE FROM connector_queue WHERE document = ?").run(alias);

    fake.on('/api/v1/stats/books', 503, {});
    expect((await put(DOC, 900, 12)).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    db.prepare('INSERT INTO document_aliases (user_id, alias, document, created_at, merge_stats) VALUES (?, ?, ?, ?, 1)')
      .run(userId, alias, DOC, 1);
    expect((await put(DOC, 1000, 12)).status).toBe(200);

    const before = fake.calls.length;
    fake.on('/api/v1/stats/books', 200, {});
    db.prepare("UPDATE connector_queue SET next_try_at = 0 WHERE status = 'pending'").run();
    await drainQueue(db, fake.transport, 10);
    const sent = fake.calls.slice(before).filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatchObject({ baseline: true, items: [{ document: DOC, seconds: 5600 }] });
    expect(sent[1]).toMatchObject({ baseline: false, items: [{ document: DOC, seconds: 6000 }] });
  });

  it('forgets what it sent when the link is replaced by a different account, and keeps it for the same one', async () => {
    const fake = fakeTransport();
    const { app, db, headers } = await linkSeekquel(fake);
    const userId = Number((db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number }).id);
    expect((await app.request('/api/v1/stats/books', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: 'crossink-aaaa', device: 'CrossInk', items: [{ document: DOC, ...BOOK_STATS }] }),
    })).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    const stored = () => (db.prepare("SELECT COUNT(*) AS n FROM connector_queue WHERE connector_id = 'seekquel' AND kind LIKE 'stats:%'").get() as { n: number }).n;
    expect(stored()).toBe(1);

    upsertAccount(db, userId, 'seekquel', CRED, 'Seekquel');
    expect(stored()).toBe(1);

    upsertAccount(db, userId, 'seekquel', { server: SERVER, key: 'WXYZ-ABCD-EFGH-JKLM' }, 'Seekquel');
    expect(stored()).toBe(0);
  });

  it('sends a merged copy\'s totals under the book\'s own id, added to the rest', async () => {
    const fake = fakeTransport();
    const { app, db, headers } = await linkSeekquel(fake);
    const alias = 'b'.repeat(32);
    const userId = Number((db.prepare('SELECT id FROM users LIMIT 1').get() as { id: number }).id);
    const put = (document: string, seconds: number) => app.request('/api/v1/stats/books', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: 'crossink-aaaa', device: 'CrossInk', items: [{ document, ...BOOK_STATS, seconds, pages: 10 }] }),
    });
    expect((await put(DOC, 600)).status).toBe(200);
    db.prepare('INSERT INTO document_aliases (user_id, alias, document, created_at, merge_stats) VALUES (?, ?, ?, ?, 1)')
      .run(userId, alias, DOC, 1);
    expect((await put(alias, 300)).status).toBe(200);
    await drainQueue(db, fake.transport, 10);

    const sent = fake.calls.filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(sent.every((s) => s.items[0].document === DOC)).toBe(true);
    expect(sent.at(-1)).toMatchObject({ baseline: false, items: [{ document: DOC, seconds: 900, pages: 20 }] });
  });

  it('starts a source read on before the link from its earlier total, on Sync now and on its next upload', async () => {
    const fake = fakeTransport();
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const put = (document: string, seconds: number, pages: number) => app.request('/api/v1/stats/books', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: 'crossink-aaaa', device: 'CrossInk', items: [{ document, ...BOOK_STATS, seconds, pages }] }),
    });
    const other = 'c'.repeat(32);
    expect((await put(DOC, 600, 20)).status).toBe(200);
    expect((await put(other, 400, 10)).status).toBe(200);

    fake.on('/koreader/pair/start', 201, { device_code: 'd'.repeat(64), user_code: 'WXYZ-2345', verification_uri_complete: 'https://seekquel.app/settings/integrations/crosspoint-sync?pair=WXYZ-2345' });
    const { device_code } = await (await app.request('/api/v1/connectors/seekquel/link/begin', { method: 'POST', headers })).json();
    fake.on('/koreader/pair/poll', 200, { key: CRED.key, sync_url: SERVER, device_id: '01J' });
    fake.on('/users/auth', 200, { authorized: 'OK' });
    await app.request('/api/v1/connectors/seekquel/link/poll', { method: 'POST', headers, body: JSON.stringify({ device_code }) });

    // Reading straight after the link, with no Sync now: only what the upload adds is new.
    expect((await put(DOC, 900, 30)).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    const first = fake.calls.filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({ baseline: true, items: [{ document: DOC, seconds: 600 }] });
    expect(first[1]).toMatchObject({ baseline: false, items: [{ document: DOC, seconds: 900 }] });
    expect(first[0].recorded_at).toBeLessThanOrEqual(first[1].recorded_at);

    // Sync now sends the book that has not been sent yet as history, and leaves the other alone.
    const before = fake.calls.length;
    expect((await app.request('/api/v1/connectors/seekquel/sync', { method: 'POST', headers })).status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    const synced = fake.calls.slice(before).filter((c) => c.url.endsWith('/api/v1/stats/books')).map(body);
    expect(synced.filter((s) => s.items[0].document === other)).toEqual([expect.objectContaining({ baseline: true, items: [expect.objectContaining({ seconds: 400 })] })]);
    expect(synced.filter((s) => s.items[0].document === DOC && s.baseline === false)).toHaveLength(0);
  });

  it('hands its key back to Seekquel when the reader unlinks', async () => {
    const fake = fakeTransport();
    const { app, headers, linked } = await linkSeekquel(fake);
    expect(linked).toBe(true);
    fake.on('/device', 204, {});
    expect((await app.request('/api/v1/connectors/seekquel', { method: 'DELETE', headers })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    const handBack = fake.calls.find((c) => c.method === 'DELETE' && c.url === `${SERVER}/device`);
    expect(handBack?.headers?.['x-auth-user']).toBe(CRED.key);

    await expect(seekquelConnector.revoke!(CRED, fake.transport)).resolves.toBeUndefined();
    fake.on('/device', 401, {});
    await expect(seekquelConnector.revoke!(CRED, fake.transport)).resolves.toBeUndefined();
    fake.on('/device', 500, {});
    await expect(seekquelConnector.revoke!(CRED, fake.transport)).rejects.toThrow();
  });

  it('forwards nothing for a book whose upload Seekquel was never linked for', async () => {
    const fake = fakeTransport();
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const res = await app.request('/api/v1/stats/books', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: 'crossink-aaaa', device: 'CrossInk', items: [{ document: DOC, ...BOOK_STATS }] }),
    });
    expect(res.status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    expect(fake.calls).toHaveLength(0);
  });

  it('does not store a link whose key Seekquel refuses', async () => {
    const fake = fakeTransport();
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    fake.on('/koreader/pair/start', 201, { device_code: 'd'.repeat(64), user_code: 'WXYZ-2345' });
    const begin = await app.request('/api/v1/connectors/seekquel/link/begin', { method: 'POST', headers });
    const { device_code } = await begin.json();
    fake.on('/koreader/pair/poll', 200, { key: CRED.key });
    fake.on('/users/auth', 401, {});
    const poll = await app.request('/api/v1/connectors/seekquel/link/poll', { method: 'POST', headers, body: JSON.stringify({ device_code }) });
    expect(poll.status).toBe(400);
    expect((await poll.json()).status).toBe('error');
    const list = await (await app.request('/api/v1/connectors', { headers })).json();
    expect(list.connectors.find((c: { id: string }) => c.id === 'seekquel').linked).toBe(false);
  });
});
