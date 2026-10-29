import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { pollConnector } from '../src/connectors/fanin.js';
import { bookorbitConnector } from '../src/connectors/bookorbit.js';
import { deleteAccount, saveMatch, setConnectorOptions, upsertAccount } from '../src/connectors/store.js';
import { scheduleMicroblogClippings } from '../src/connectors/microblog-clippings.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { upsertProgress } from '../src/routes/kosync.js';
import type { HttpTransport, InboundHighlight } from '../src/connectors/types.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY = 'c'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); vi.restoreAllMocks(); });

const REMOTE_TIME = 1792706881;
const highlight: InboundHighlight = { text: 'A highlighted passage.', note: null, chapter: 'Chapter 1',
  spine: 0, startOffset: 10, endOffset: 32, createdAt: REMOTE_TIME };

async function fixture() {
  const calls: string[] = [];
  const http: HttpTransport = async (url) => {
    calls.push(url);
    let body: unknown;
    if (url.endsWith('/auth/login')) body = { accessToken: 'token' };
    else if (url.endsWith('/auth/me')) body = { settings: { timezone: 'UTC' } };
    else if (url.includes('/sessions?')) body = { items: [], total: 0, page: 1, pageSize: 100 };
    else if (url.endsWith('/books/files/71/progress')) body = { percentage: 8.42,
      koreaderProgress: '/body/DocFragment[17]/body/p[2]', updatedAt: new Date(REMOTE_TIME * 1000).toISOString() };
    else if (url.endsWith('/annotations')) body = [];
    else throw new Error(`Unexpected request: ${url}`);
    return { status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const { app, db } = makeTestApp({}, { connectorTransport: http });
  const { username, headers } = await registerUser(app);
  const { id } = db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number };
  upsertAccount(db, id, 'bookorbit', { server: 'background.test', username, password: 'pw' }, null);
  saveMatch(db, id, 'bookorbit', DOC, { externalId: '12', externalEdition: '71', confidence: 1 }, 'manual');
  return { app, db, id, headers, http, calls };
}

it('imports progress and clippings on demand, exposing progress to bulk sync', async () => {
  const f = await fixture();
  vi.spyOn(bookorbitConnector, 'pullHighlights').mockResolvedValue([highlight]);
  expect(await pollConnector(f.db, f.id, 'bookorbit', f.http, { document: DOC })).toBe(1);
  const feed = await (await f.app.request('/api/v1/progress/changes?since=0&device=x4', { headers: f.headers })).json();
  expect(feed.changes).toHaveLength(1);
  expect(feed.changes[0]).toMatchObject({ document: DOC, percentage: 0.0842, device_id: 'bookorbit', timestamp: REMOTE_TIME });
  expect(f.db.prepare('SELECT text FROM clippings WHERE user_id=?').all(f.id)).toEqual([{ text: highlight.text }]);
  // Repeated polling must neither duplicate highlights nor echo back to BookOrbit.
  expect(await pollConnector(f.db, f.id, 'bookorbit', f.http, { document: DOC })).toBe(0);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM clippings').get()).toEqual({ n: 1 });
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM connector_queue WHERE connector_id='bookorbit'").get()).toEqual({ n: 0 });
  const next = await (await f.app.request(`/api/v1/progress/changes?since=${feed.cursor}`, { headers: f.headers })).json();
  expect(next.changes).toEqual([]);
});

it.each([
  { automatic: true, matched: true },
  { automatic: false, matched: true },
  { automatic: true, matched: false },
])('schedules imported clippings without a progress change (automatic: $automatic, matched: $matched)', async ({ automatic, matched }) => {
  const f = await fixture();
  vi.spyOn(bookorbitConnector, 'pullProgress').mockResolvedValue(null);
  vi.spyOn(bookorbitConnector, 'pullHighlights').mockResolvedValue([highlight]);
  upsertAccount(f.db, f.id, 'microblog', { token: 'token' }, null);
  setConnectorOptions(f.db, f.id, 'microblog', { sync_highlights: automatic });
  const match = () => saveMatch(f.db, f.id, 'microblog', DOC,
    { externalId: '123', externalEdition: '9781786487849', confidence: 1 }, 'manual');
  if (matched) match();
  expect(await pollConnector(f.db, f.id, 'bookorbit', f.http, { document: DOC })).toBe(0);
  expect(f.db.prepare('SELECT text FROM clippings').get()).toEqual({ text: highlight.text });
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM microblog_clipping_selections').get()).toEqual({ n: automatic ? 1 : 0 });
  const jobs = () => f.db.prepare("SELECT document,status FROM connector_queue WHERE kind='microblog:clippings'").all();
  expect(jobs()).toEqual(automatic && matched ? [{ document: DOC, status: 'pending' }] : []);
  if (automatic && !matched) {
    match();
    expect(scheduleMicroblogClippings(f.db, f.id, DOC)).toBe(1);
  }
  await pollConnector(f.db, f.id, 'bookorbit', f.http, { document: DOC });
  expect(jobs()).toHaveLength(automatic ? 1 : 0);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM clippings').get()).toEqual({ n: 1 });
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM connector_queue WHERE connector_id='bookorbit'").get()).toEqual({ n: 0 });
  f.db.close();
});

it('keeps imported clippings and other fanout when Micro.blog scheduling fails', async () => {
  const f = await fixture();
  vi.spyOn(bookorbitConnector, 'pullProgress').mockResolvedValue(null);
  vi.spyOn(bookorbitConnector, 'pullHighlights').mockResolvedValue([highlight]);
  upsertAccount(f.db, f.id, 'microblog', { token: 'token' }, null);
  setConnectorOptions(f.db, f.id, 'microblog', { sync_highlights: true });
  saveMatch(f.db, f.id, 'microblog', DOC, { externalId: '123', externalEdition: '9781786487849', confidence: 1 }, 'manual');
  upsertAccount(f.db, f.id, 'seekquel', { token: 'token' }, null);
  saveMatch(f.db, f.id, 'seekquel', DOC, { externalId: '456', confidence: 1 }, 'manual');
  f.db.exec(`CREATE TEMP TRIGGER fail_import_schedule BEFORE INSERT ON microblog_clipping_selections
    BEGIN SELECT RAISE(FAIL, 'simulated import scheduling failure'); END`);
  await expect(pollConnector(f.db, f.id, 'bookorbit', f.http, { document: DOC, throwOnError: true })).resolves.toBe(0);
  expect(f.db.prepare('SELECT text FROM clippings').get()).toEqual({ text: highlight.text });
  expect(f.db.prepare("SELECT kind FROM connector_queue WHERE connector_id='seekquel'").get()).toEqual({ kind: expect.stringMatching(/^highlight:/) });
  f.db.exec('DROP TRIGGER fail_import_schedule');
  expect(scheduleMicroblogClippings(f.db, f.id, DOC)).toBe(1);
  f.db.close();
});

it('manually syncs only the requested book and queues the pulled position, not the old local one', async () => {
  const f = await fixture();
  const other = '1234567890abcdef1234567890abcdef';
  for (const document of [DOC, other]) {
    upsertProgress(f.db, { userId: f.id, document, deviceId: 'x4', device: 'X4', percentage: 0.02,
      progress: '/body/old', position: null, metadata: null, updatedAt: REMOTE_TIME - 100 });
  }
  saveMatch(f.db, f.id, 'bookorbit', other, { externalId: '99', externalEdition: '98', confidence: 1 }, 'manual');
  const response = await f.app.request(`/api/v1/connectors/bookorbit/sync/${DOC}`, { method: 'POST', headers: f.headers });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ applied: 1, queued: 1, history_pending: false });
  const rows = f.db.prepare('SELECT document, payload FROM connector_queue').all();
  expect(rows).toHaveLength(1);
  expect(rows[0].document).toBe(DOC);
  expect(JSON.parse(String(rows[0].payload))).toMatchObject({ percentage: 0.0842, timestamp: REMOTE_TIME });
  expect(f.calls.some((url) => url.includes('/books/99'))).toBe(false);
  expect(f.calls.findIndex((url) => url.endsWith('/annotations'))).toBeLessThan(f.calls.findIndex((url) => url.includes('/sessions?')));
});

it('does not queue pushes when a manual pull fails', async () => {
  const f = await fixture();
  vi.spyOn(bookorbitConnector, 'pullHighlights').mockRejectedValue(new Error('BookOrbit unavailable'));
  const response = await f.app.request(`/api/v1/connectors/bookorbit/sync/${DOC}`, { method: 'POST', headers: f.headers });
  expect(response.status).toBe(502);
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM connector_queue').get()).toEqual({ n: 0 });
  expect(f.calls.some((url) => url.includes('/sessions?'))).toBe(false);
});

it('isolates manual sync by account and rejects unknown books', async () => {
  const f = await fixture();
  const other = await registerUser(f.app);
  expect((await f.app.request(`/api/v1/connectors/bookorbit/sync/${DOC}`, { method: 'POST', headers: other.headers })).status).toBe(404);
  expect((await f.app.request('/api/v1/connectors/bookorbit/sync/not-a-hash', { method: 'POST', headers: f.headers })).status).toBe(404);
  expect(f.calls).toEqual([]);
});

it('skips disabled accounts and unmatched books', async () => {
  const f = await fixture();
  f.db.prepare('UPDATE connector_accounts SET enabled=0').run();
  expect(await pollConnector(f.db, f.id, 'bookorbit', f.http, { document: DOC })).toBe(0);
  expect(f.calls).toEqual([]);
  f.db.prepare('UPDATE connector_accounts SET enabled=1').run();
  f.db.prepare('DELETE FROM connector_matches').run();
  expect(await pollConnector(f.db, f.id, 'bookorbit', f.http, { document: DOC })).toBe(0);
  expect(f.calls).toEqual([]);
});

it('does not import highlights after an account is unlinked during the request', async () => {
  const f = await fixture();
  vi.spyOn(bookorbitConnector, 'pullHighlights').mockImplementation(async () => {
    deleteAccount(f.db, f.id, 'bookorbit');
    return [highlight];
  });
  await pollConnector(f.db, f.id, 'bookorbit', f.http, { document: DOC });
  expect(f.db.prepare('SELECT COUNT(*) AS n FROM clippings').get()).toEqual({ n: 0 });
});

it('does not replace a newer local position with a delayed percentage-only response', async () => {
  const f = await fixture();
  vi.spyOn(bookorbitConnector, 'pullProgress').mockImplementation(async () => {
    upsertProgress(f.db, { userId: f.id, document: DOC, deviceId: 'x4', device: 'X4', percentage: 0.1,
      progress: '/body/newer', position: null, metadata: null, updatedAt: REMOTE_TIME + 5 });
    return { externalId: '12', percentage: 0.0842, updatedAtMs: REMOTE_TIME * 1000 };
  });
  expect(await pollConnector(f.db, f.id, 'bookorbit', f.http, { document: DOC })).toBe(0);
  expect(f.db.prepare("SELECT COUNT(*) AS n FROM progress WHERE device_id='bookorbit'").get()).toEqual({ n: 0 });
});

