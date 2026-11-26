import { afterEach, beforeEach, expect, it } from 'vitest';
import { readwiseReaderConnector } from '../src/connectors/readwise-reader.js';
import { drainQueue } from '../src/connectors/runner.js';
import { saveMatch, setMatchSnapshot, upsertAccount } from '../src/connectors/store.js';
import { upsertProgress } from '../src/routes/kosync.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import type { HttpTransport } from '../src/connectors/types.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY = 'c'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });

const MATCH = { externalId: '01reader', confidence: 1 };
let tokens = 0;

/** A Reader document whose updated_at moves on every write, as Reader's does. */
function reader(progress: number, updatedAt: string) {
  const doc = { id: MATCH.externalId, title: 'Piranesi', author: 'Susanna Clarke', category: 'epub',
    reading_progress: progress, updated_at: updatedAt };
  const calls: { url: string; method: string; body?: string }[] = [];
  const http: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    let status = 200;
    let body: unknown = {};
    if (url.includes('/list/')) body = { results: [doc] };
    else if (url.endsWith('/save/')) { status = 201; doc.updated_at = new Date().toISOString(); }
    else if (url.endsWith('/bulk_update/')) {
      doc.reading_progress = JSON.parse(init.body!).updates[0].reading_progress;
      doc.updated_at = new Date().toISOString();
    } else throw new Error(`Unexpected request: ${init.method} ${url}`);
    return { status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { doc, http, calls, cred: { token: `rw-${++tokens}` } };
}

async function app(http: HttpTransport, token: string) {
  const { app, db } = makeTestApp({}, { connectorTransport: http });
  const { username, headers } = await registerUser(app);
  const { id } = db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number };
  upsertAccount(db, id, 'readwise-reader', { token }, null);
  saveMatch(db, id, 'readwise-reader', DOC, MATCH, 'manual');
  return { app, db, id, headers };
}

it('writes progress synced in the same sync as a highlight', async () => {
  const r = reader(0, '2026-11-01T00:00:00Z');
  const f = await app(r.http, r.cred.token);
  await f.app.request(`/api/v1/clippings/${DOC}`, {
    method: 'PUT', headers: f.headers,
    body: JSON.stringify({ items: [{ id: 'c0ffee0011223344', spine: 1, text: 'A clipping', created_at: 1764000000 }] }),
  });
  await f.app.request('/syncs/progress', {
    method: 'PUT', headers: f.headers,
    body: JSON.stringify({ document: DOC, progress: 'p', percentage: 0.5, device_id: 'd1' }),
  });
  await drainQueue(f.db, r.http, 10);
  expect(r.calls.some((c) => c.url.endsWith('/save/'))).toBe(true);
  expect(r.doc.reading_progress).toBe(0.5);
});

it('does not take a highlight write in Reader for newer reading there', async () => {
  const r = reader(0.3, new Date(Date.now() + 60_000).toISOString());
  const f = await app(r.http, r.cred.token);
  setMatchSnapshot(f.db, f.id, 'readwise-reader', MATCH.externalId, { progress: 0.3 });
  const ctx = { db: f.db, userId: f.id, document: DOC };
  const ev = { kind: 'progress' as const, document: DOC, percentage: 0.5, timestamp: Math.floor(Date.now() / 1000) };
  expect(await readwiseReaderConnector.push(r.cred, MATCH, ev, r.http, ctx)).toEqual({ ok: true });
  expect(r.doc.reading_progress).toBe(0.5);
  // Nor does a pull bring the old position back after the edit.
  expect(await readwiseReaderConnector.pullProgress!(r.cred, MATCH, r.http, 0, ctx)).toBeNull();
});

it('keeps a position read further in Reader', async () => {
  const r = reader(0.6, new Date(Date.now() + 60_000).toISOString());
  const f = await app(r.http, r.cred.token);
  setMatchSnapshot(f.db, f.id, 'readwise-reader', MATCH.externalId, { progress: 0.3 });
  const ctx = { db: f.db, userId: f.id, document: DOC };
  const ev = { kind: 'progress' as const, document: DOC, percentage: 0.5, timestamp: Math.floor(Date.now() / 1000) };
  expect(await readwiseReaderConnector.push(r.cred, MATCH, ev, r.http, ctx)).toMatchObject({ ok: true, note: expect.stringMatching(/Newer Reader/) });
  expect(r.doc.reading_progress).toBe(0.6);
  // The next pull still brings Reader's position down to the device.
  expect(await readwiseReaderConnector.pullProgress!(r.cred, MATCH, r.http, 0, ctx)).toMatchObject({ percentage: 0.6 });
});

it('returns a position read further in Reader when a device asks for progress', async () => {
  const r = reader(0.6, new Date().toISOString());
  const f = await app(r.http, r.cred.token);
  setMatchSnapshot(f.db, f.id, 'readwise-reader', MATCH.externalId, { progress: 0.52 });
  upsertProgress(f.db, { userId: f.id, document: DOC, deviceId: 'd1', device: 'X4', percentage: 0.52, progress: 'p',
    position: null, metadata: null, updatedAt: Math.floor(Date.now() / 1000) - 3600 });
  const got = await (await f.app.request(`/syncs/progress/${DOC}`, { headers: f.headers })).json();
  expect(got).toMatchObject({ percentage: 0.6, device_id: 'readwise-reader' });
  // Asking again doesn't echo the pulled position back to Reader.
  await f.app.request(`/syncs/progress/${DOC}`, { headers: f.headers });
  await drainQueue(f.db, r.http, 10);
  expect(r.calls.filter((c) => c.url.endsWith('/bulk_update/'))).toEqual([]);
  // Once pulled, a later edit that only moves updated_at (say, a highlight) doesn't bring 0.6 back.
  r.doc.updated_at = new Date(Date.now() + 120_000).toISOString();
  const ctx = { db: f.db, userId: f.id, document: DOC };
  expect(await readwiseReaderConnector.pullProgress!(r.cred, MATCH, r.http, 0, ctx)).toBeNull();
});
