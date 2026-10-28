import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTestApp, registerUser, DOC } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { upsertAccount } from '../src/connectors/store.js';
import { drainQueue } from '../src/connectors/runner.js';
import type { HttpTransport } from '../src/connectors/types.js';
import { deleteDocumentData } from '../src/models/document.js';
import { deleteKosyncUserData } from '../src/routes/account.js';
import { fanOutProgress } from '../src/connectors/fanout.js';
import { createProgressRefresh } from '../src/connectors/refresh.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY = 'a'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });
async function setup() {
  const posts: unknown[] = [];
  const http: HttpTransport = async (url, init) => {
    if (new URL(url).searchParams.get('q') === 'config') return { status: 200, json: async () => ({ destination: [{ uid: 'https://example.micro.blog/' }] }), text: async () => '' };
    if (new URL(url).pathname === '/micropub' && init.method === 'POST') posts.push(JSON.parse(init.body!));
    else if (!url.includes('/micropub?')) throw new Error(`Unexpected network request: ${url}`);
    return { status: 201, headers: { get: () => 'https://example.micro.blog/highlights.html' }, json: async () => ({}), text: async () => '' };
  };
  const { app, db } = makeTestApp({}, { connectorTransport: http });
  const { username, headers } = await registerUser(app);
  const uid = (db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number }).id;
  upsertAccount(db, uid, 'microblog', { token: 'token', microblogDestination: 'https://example.micro.blog/' }, null);
  const put = (path: string, body: unknown) => app.request(path, { method: 'PUT', headers, body: JSON.stringify(body) });
  await put('/api/v1/documents', { items: [{ document: DOC, title: 'Test book', author: 'Author' }] });
  const clipping = () => put(`/api/v1/clippings/${DOC}`, { items: [{ id: 'one', spine: 1, text: 'A passage', created_at: 1 }] });
  await clipping();
  const select = (id = 'one', auth = headers) => app.request(`/api/v1/connectors/microblog/clippings/${DOC}/${id}`, { method: 'POST', headers: auth });
  const match = () => put(`/api/v1/connectors/microblog/matches/${DOC}`, { external_id: '123', external_edition: '9781786487849' });
  return { app, db, uid, headers, posts, http, put, clipping, select, match };
}

async function schedulingFailure() {
  const s = await setup();
  s.db.prepare('UPDATE connector_accounts SET options=? WHERE user_id=? AND connector_id=?')
    .run(JSON.stringify({ sync_highlights: true }), s.uid, 'microblog');
  s.db.exec(`CREATE TEMP TRIGGER fail_microblog_selection BEFORE INSERT ON microblog_clipping_selections
    BEGIN SELECT RAISE(FAIL, 'simulated scheduling database failure'); END`);
  return s;
}

it('still fans out progress to other connectors when Micro.blog scheduling fails', async () => {
  const s = await schedulingFailure();
  upsertAccount(s.db, s.uid, 'kosync', { server: 'mirror.test', username: 'reader', password: 'test' }, null);
  expect(() => fanOutProgress(s.db, s.uid, DOC, 0.4, 100)).not.toThrow();
  expect(s.db.prepare("SELECT kind FROM connector_queue WHERE connector_id='kosync'").get()).toEqual({ kind: 'progress' });
  s.db.close();
});

it('does not reject progress refresh when Micro.blog scheduling fails', async () => {
  const s = await schedulingFailure();
  await expect(createProgressRefresh(s.db, s.http)(s.uid, DOC)).resolves.toBeUndefined();
  s.db.close();
});

it('still returns clippings when Micro.blog scheduling fails', async () => {
  const s = await schedulingFailure();
  const res = await s.app.request(`/api/v1/clippings/${DOC}`, { headers: s.headers });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ items: [{ id: 'one', text: 'A passage' }] });
  s.db.close();
});

it('acknowledges saved clippings and can schedule them on a later sync after a database failure', async () => {
  const s = await schedulingFailure();
  const res = await s.put(`/api/v1/clippings/${DOC}`, { items: [{ id: 'two', spine: 2, text: 'Another passage', created_at: 2 }] });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ accepted: 1 });
  expect(s.db.prepare('SELECT text FROM clippings WHERE user_id=? AND id=?').get(s.uid, 'two')).toEqual({ text: 'Another passage' });
  s.db.exec('DROP TRIGGER fail_microblog_selection');
  await s.match();
  expect((await s.app.request(`/api/v1/clippings/${DOC}`, { headers: s.headers })).status).toBe(200);
  await drainQueue(s.db, s.http);
  expect(s.posts).toHaveLength(1);
  expect(JSON.stringify(s.posts[0])).toContain('Another passage');
  s.db.close();
});

it('defaults automatic publication off and remembers a manually selected unmatched clipping', async () => {
  const s = await setup();
  expect(s.db.prepare("SELECT COUNT(*) n FROM connector_queue WHERE kind='microblog:clippings'").get()).toEqual({ n: 0 });
  const selected = await s.select();
  expect(selected.status).toBe(200);
  expect(await selected.json()).toEqual({ queued: false, waiting_for_match: true });
  expect(s.db.prepare('SELECT manual FROM microblog_clipping_selections').get()).toEqual({ manual: 1 });
  expect(s.posts).toHaveLength(0);
  s.db.close();
});

it.each(['legacy', 'v1', 'clippings', 'sync-now'])('catches up selected clippings after matching on %s sync', async (trigger) => {
  const s = await setup();
  await s.select();
  await s.match();
  if (trigger === 'legacy') await s.app.request(`/syncs/progress/${DOC}`, { headers: s.headers });
  if (trigger === 'v1') await s.app.request(`/api/v1/progress/${DOC}`, { headers: s.headers });
  if (trigger === 'clippings') await s.clipping();
  if (trigger === 'sync-now') await s.app.request('/api/v1/connectors/microblog/sync', { method: 'POST', headers: s.headers });
  await drainQueue(s.db, s.http);
  expect(s.posts).toHaveLength(1);
  expect(JSON.stringify(s.posts[0])).toContain('A passage');
  s.db.close();
});

it('enabling automatic publication backfills existing highlights and waits for matching', async () => {
  const s = await setup();
  const changed = await s.put('/api/v1/connectors/microblog/options', { sync_highlights: true });
  expect(changed.status).toBe(200);
  expect(s.db.prepare('SELECT manual FROM microblog_clipping_selections').get()).toEqual({ manual: 0 });
  expect(s.db.prepare("SELECT COUNT(*) n FROM connector_queue WHERE kind='microblog:clippings'").get()).toEqual({ n: 0 });
  await s.match(); await s.clipping(); await drainQueue(s.db, s.http);
  expect(s.posts).toHaveLength(1);
  s.db.close();
});

it('rejects missing, deleted, foreign, unlinked, disabled and unauthenticated selections', async () => {
  const s = await setup();
  expect((await s.select('missing')).status).toBe(404);
  const other = await registerUser(s.app);
  expect((await s.select('one', other.headers)).status).toBe(400);
  const otherId = (s.db.prepare('SELECT id FROM users WHERE username=?').get(other.username) as { id: number }).id;
  upsertAccount(s.db, otherId, 'microblog', { token: 'other' }, null);
  expect((await s.select('one', other.headers)).status).toBe(404);
  expect((await s.select('one', {})).status).toBe(401);
  s.db.prepare('UPDATE clippings SET deleted=1').run();
  expect((await s.select()).status).toBe(404);
  s.db.prepare('UPDATE clippings SET deleted=0').run();
  s.db.prepare('UPDATE connector_accounts SET enabled=0').run();
  expect((await s.select()).status).toBe(400);
  s.db.prepare('DELETE FROM connector_accounts').run();
  expect((await s.select()).status).toBe(400);
  s.db.close();
});

it('a replacement token preserves original post history while resetting inaccessible-account preferences', async () => {
  const s = await setup(); await s.match(); await s.select(); await drainQueue(s.db, s.http);
  s.db.prepare("UPDATE connector_accounts SET options='{" + '"sync_highlights":true' + "}' WHERE user_id=?").run(s.uid);
  upsertAccount(s.db, s.uid, 'microblog', { token: 'replacement', microblogDestination: 'https://replacement.micro.blog/' }, null);
  expect(s.db.prepare('SELECT url FROM microblog_clipping_posts').get()).toEqual({ url: 'https://example.micro.blog/highlights.html' });
  expect(s.db.prepare("SELECT options FROM connector_accounts WHERE user_id=?").get(s.uid)).toEqual({ options: '{}' });
  expect(s.db.prepare('SELECT COUNT(*) n FROM connector_matches WHERE user_id=?').get(s.uid)).toEqual({ n: 0 });
  s.db.close();
});

it.each(['book', 'account'])('clears local publication data on %s removal without deleting the remote post', async (scope) => {
  const s = await setup(); await s.match(); await s.select(); await drainQueue(s.db, s.http);
  if (scope === 'book') deleteDocumentData(s.db, s.uid, DOC);
  else deleteKosyncUserData(s.db, s.uid, s.headers['x-auth-user'], { keepUser: true });
  expect(s.db.prepare('SELECT COUNT(*) n FROM microblog_clipping_posts').get()).toEqual({ n: 0 });
  expect(s.db.prepare('SELECT COUNT(*) n FROM microblog_clipping_selections').get()).toEqual({ n: 0 });
  expect(s.posts).toHaveLength(1);
  s.db.close();
});

it('coalesces repeated selections and clears local publication state on unlink', async () => {
  const s = await setup(); await s.match();
  await s.select(); await s.select();
  expect(s.db.prepare("SELECT COUNT(*) n FROM connector_queue WHERE kind='microblog:clippings'").get()).toEqual({ n: 1 });
  await drainQueue(s.db, s.http);
  await s.app.request('/api/v1/connectors/microblog', { method: 'DELETE', headers: s.headers });
  expect(s.db.prepare('SELECT COUNT(*) n FROM microblog_clipping_posts').get()).toEqual({ n: 0 });
  expect(s.db.prepare('SELECT COUNT(*) n FROM microblog_clipping_selections').get()).toEqual({ n: 0 });
  expect(s.posts).toHaveLength(1);
  s.db.close();
});
