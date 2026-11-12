import { afterEach, beforeEach, expect, it } from 'vitest';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { bookorbitConnector } from '../src/connectors/bookorbit.js';
import { saveMatch, upsertAccount } from '../src/connectors/store.js';
import { upsertProgress } from '../src/routes/kosync.js';
import type { HttpTransport } from '../src/connectors/types.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY = 'c'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });

const WEB_TIME = Date.parse('2026-10-20T12:00:00Z');
const DEVICE_TIME = Date.parse('2026-10-21T12:00:00Z');
const PLUGIN_TIME = Date.parse('2026-10-22T12:00:00Z');
const MATCH = { externalId: '12', externalEdition: '71', confidence: 1 };
const XPATH = '/body/DocFragment[6]/body/p[1]';
let reader = 0;

function fixture(extra: object = {}) {
  const calls: { url: string; method: string }[] = [];
  const cred = { server: 'progress.test', username: `reader-${++reader}`, password: 'pw' };
  const http: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method });
    let body: unknown;
    if (url.endsWith('/auth/login')) body = { accessToken: 'token' };
    else if (url.endsWith('/auth/me')) body = { settings: { timezone: 'UTC' } };
    else if (url.includes('/sessions?')) body = { items: [], total: 0, page: 1, pageSize: 100 };
    else if (url.endsWith('/books/12')) body = { files: [{ id: 71, format: 'epub', role: 'primary' }] };
    else if (url.endsWith('/books/files/71/progress') && init.method === 'GET') {
      body = { percentage: 60, koreaderProgress: XPATH, updatedAt: new Date(WEB_TIME).toISOString(),
        textUpdatedAt: new Date(PLUGIN_TIME).toISOString(), ...extra };
    } else if (url.endsWith('/annotations')) body = [];
    else throw new Error(`Unexpected request: ${init.method} ${url}`);
    return { status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { cred, http, calls };
}

it('returns newer plugin progress to CrossPoint even when the web-reader timestamp is older', async () => {
  const f = fixture();
  const { app, db } = makeTestApp({}, { connectorTransport: f.http });
  const { username, headers } = await registerUser(app);
  const { id } = db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number };
  upsertAccount(db, id, 'bookorbit', f.cred, null);
  saveMatch(db, id, 'bookorbit', DOC, MATCH, 'manual');
  upsertProgress(db, { userId: id, document: DOC, deviceId: 'crosspoint', device: 'CrossPoint', percentage: 0.05,
    progress: '/body/DocFragment[1]/body/p[1]', position: null, metadata: null, updatedAt: DEVICE_TIME / 1000 });
  const response = await app.request(`/syncs/progress/${DOC}`, { headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ percentage: 0.6, progress: XPATH,
    device_id: 'bookorbit', timestamp: PLUGIN_TIME / 1000 });
  expect(db.prepare("SELECT COUNT(*) n FROM connector_queue WHERE connector_id='bookorbit'").get()).toEqual({ n: 0 });
});

it.each(['progress', 'finished'] as const)('protects newer plugin progress from a queued %s write', async (kind) => {
  const f = fixture();
  expect(await bookorbitConnector.push(f.cred, MATCH, { kind, document: DOC, percentage: kind === 'finished' ? 1 : 0.1,
    timestamp: DEVICE_TIME / 1000 }, f.http)).toEqual({ ok: true });
  expect(f.calls.filter((c) => !c.url.endsWith('/auth/login')).every((c) => c.method === 'GET')).toBe(true);
});

it('resolves the EPUB file before pulling when a saved match has no edition', async () => {
  const f = fixture();
  expect(await bookorbitConnector.pullProgress!(f.cred, { ...MATCH, externalEdition: null }, f.http, DEVICE_TIME))
    .toMatchObject({ percentage: 0.6, progress: XPATH, updatedAtMs: PLUGIN_TIME });
});

it.each([undefined, null, 'invalid'])('falls back to updatedAt for older servers: %s', async (textUpdatedAt) => {
  const f = fixture({ textUpdatedAt });
  expect(await bookorbitConnector.pullProgress!(f.cred, MATCH, f.http, WEB_TIME - 1000))
    .toMatchObject({ percentage: 0.6, updatedAtMs: WEB_TIME });
});

it('does not import an older text position because a newer non-text save changed updatedAt', async () => {
  const f = fixture({ textUpdatedAt: new Date(WEB_TIME).toISOString(), updatedAt: new Date(PLUGIN_TIME).toISOString() });
  expect(await bookorbitConnector.pullProgress!(f.cred, MATCH, f.http, DEVICE_TIME)).toBeNull();
});

it.each([null, [], {}, { percentage: '60' }])('does not push when file progress is malformed: %j', async (body) => {
  const f = fixture();
  const http: HttpTransport = (url, init) => url.endsWith('/progress')
    ? Promise.resolve({ status: 200, json: async () => body, text: async () => JSON.stringify(body) })
    : f.http(url, init);
  expect(await bookorbitConnector.push(f.cred, MATCH, { kind: 'progress', document: DOC, percentage: 0.1,
    timestamp: DEVICE_TIME / 1000 }, http)).toMatchObject({ ok: false, retryable: true });
});
