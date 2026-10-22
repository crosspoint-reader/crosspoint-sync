import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import type { HttpTransport, OutboundEvent } from '../src/connectors/types.js';
import { drainQueue } from '../src/connectors/runner.js';
import { claimReady } from '../src/connectors/queue.js';
import { seekquelBase, seekquelConnector } from '../src/connectors/seekquel.js';

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

const KEY = { TOKEN_ENC_KEY: 'a'.repeat(64) };
beforeEach(() => { Object.assign(process.env, KEY); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; delete process.env.SEEKQUEL_URL; resetEncryptionKeyCache(); });

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
    const sync = async (percentage: number) => {
      await app.request('/syncs/progress', {
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
    await sync(0.1);
    expect(statusCalls()).toBe(1);
    await sync(1);
    expect(statusCalls()).toBe(2);
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
