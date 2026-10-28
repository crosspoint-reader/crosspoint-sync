import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTestApp, registerUser, DOC } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { upsertAccount, saveMatch } from '../src/connectors/store.js';
import { selectMicroblogClipping, scheduleMicroblogClippings } from '../src/connectors/microblog-clippings.js';
import { drainQueue } from '../src/connectors/runner.js';
import type { HttpTransport } from '../src/connectors/types.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY = 'a'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });
const remoteUrl = 'https://example.micro.blog/2026/10/28/highlights.html';
async function setup() {
  const { app, db } = makeTestApp();
  const { username } = await registerUser(app);
  const uid = (db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number }).id;
  upsertAccount(db, uid, 'microblog', { token: 'token' }, null);
  db.prepare('INSERT INTO documents(user_id,document,title,author,updated_at) VALUES(?,?,?,?,0)').run(uid, DOC, 'Test book', 'Author');
  db.prepare('INSERT INTO clippings(user_id,document,id,text,spine_index,created_at,updated_at) VALUES(?,?,?,?,0,1,1)').run(uid, DOC, 'one', '<First passage>');
  selectMicroblogClipping(db, uid, DOC, 'one');
  saveMatch(db, uid, 'microblog', DOC, { externalId: '123', externalEdition: '9781786487849', confidence: 1 }, 'manual');
  scheduleMicroblogClippings(db, uid, DOC);
  return { db, uid };
}
function response(status: number, body: unknown = {}, location?: string) {
  return { status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: (key: string) => key.toLowerCase() === 'location' ? location ?? null : null } };
}

it('publishes one escaped collected post, skips unchanged content, then updates the saved URL', async () => {
  const { db, uid } = await setup();
  const writes: Record<string, unknown>[] = [];
  const http: HttpTransport = async (url, init) => {
    expect(url).toContain('https://micro.blog/micropub');
    if (init.method === 'GET') return response(200, { properties: { url: [remoteUrl] } });
    expect(init.headers?.['content-type']).toBe('application/json');
    const body = JSON.parse(init.body!); writes.push(body);
    return response(body.action ? 200 : 201, {}, body.action ? undefined : remoteUrl);
  };
  await drainQueue(db, http);
  expect(writes).toHaveLength(1);
  expect(JSON.stringify(writes[0])).toContain('&lt;First passage&gt;');
  expect(JSON.stringify(writes[0])).toContain('https://micro.blog/books/9781786487849');
  scheduleMicroblogClippings(db, uid, DOC);
  await drainQueue(db, http);
  expect(writes).toHaveLength(1);
  db.prepare('UPDATE clippings SET note=? WHERE user_id=?').run('A note', uid);
  scheduleMicroblogClippings(db, uid, DOC);
  await drainQueue(db, http);
  expect(writes).toHaveLength(2);
  expect(writes[1]).toMatchObject({ action: 'update', url: remoteUrl });
  expect(JSON.stringify(writes[1])).toContain('A note');
  db.close();
});

it('recovers an uncertain creation by source identity without creating a second post', async () => {
  const { db } = await setup();
  let creates = 0;
  let saved: unknown;
  const http: HttpTransport = async (url, init) => {
    expect(url).toContain('/micropub');
    if (init.method === 'GET') return response(200, { items: [{ properties: { ...(saved as any), url: [remoteUrl] } }] });
    const body = JSON.parse(init.body!);
    if (!body.action) { creates++; saved = body.properties; throw new Error('connection lost after acceptance'); }
    return response(200);
  };
  await drainQueue(db, http);
  db.prepare("UPDATE connector_queue SET next_try_at=0 WHERE connector_id='microblog'").run();
  await drainQueue(db, http);
  expect(creates).toBe(1);
  expect(db.prepare('SELECT url FROM microblog_clipping_posts').get()).toEqual({ url: remoteUrl });
  expect(db.prepare('SELECT status FROM connector_queue').get()).toEqual({ status: 'done' });
  db.close();
});

it.each([401, 403, 429, 500])('handles HTTP %s without marking an upload successful', async (status) => {
  const { db } = await setup();
  await drainQueue(db, async () => response(status));
  const row = db.prepare('SELECT status,last_error FROM connector_queue').get() as { status: string; last_error: string };
  expect(row.status).toBe(status < 429 ? 'dead' : 'pending');
  expect(row.last_error).toContain(String(status));
  expect(db.prepare('SELECT fingerprint FROM microblog_clipping_posts').get()).toEqual({ fingerprint: null });
  if (status === 401 || status === 403) expect(db.prepare('SELECT status FROM connector_accounts').get()).toEqual({ status: 'needs_reauth' });
  db.close();
});

it('does not recreate a missing published post', async () => {
  const { db } = await setup();
  db.prepare('UPDATE microblog_clipping_posts SET url=?,attempted=1').run(remoteUrl);
  let creates = 0;
  await drainQueue(db, async (_url, init) => { if (init.method === 'POST' && !JSON.parse(init.body!).action) creates++; return response(404); });
  expect(creates).toBe(0);
  expect(db.prepare('SELECT status FROM connector_queue').get()).toEqual({ status: 'dead' });
  db.close();
});

it.each(['missing', 'ambiguous', 'malformed'])('requires attention after %s recovery instead of creating again', async (mode) => {
  const { db } = await setup();
  let creates = 0;
  let properties: any;
  const http: HttpTransport = async (_url, init) => {
    if (init.method === 'GET') {
      if (mode === 'malformed') return response(200, {});
      const item = { properties: { ...properties, url: [remoteUrl] } };
      return response(200, { items: mode === 'missing' ? [] : [item, { properties: { ...properties, url: ['https://example.micro.blog/duplicate.html'] } }] });
    }
    creates++; properties = JSON.parse(init.body!).properties;
    return response(201); // Accepted, but Location was lost.
  };
  await drainQueue(db, http);
  db.prepare('UPDATE connector_queue SET next_try_at=0').run();
  await drainQueue(db, http);
  expect(creates).toBe(1);
  const state = db.prepare('SELECT url,error FROM microblog_clipping_posts').get() as { url: string | null; error: string | null };
  expect(state.url).toBeNull();
  if (mode !== 'malformed') expect(state.error).toContain('could not be resolved');
  db.close();
});

it('recovers across source pagination', async () => {
  const { db } = await setup();
  let properties: any;
  let creates = 0;
  const pages: string[] = [];
  const http: HttpTransport = async (url, init) => {
    if (init.method === 'GET') {
      if (url.includes('url=')) return response(200, { properties });
      pages.push(url);
      return response(200, { items: url.includes('offset=0') ? Array.from({ length: 100 }, () => ({ properties: { content: ['Other post'] } }))
        : [{ properties: { ...properties, url: [remoteUrl] } }] });
    }
    const body = JSON.parse(init.body!);
    if (!body.action) { creates++; properties = body.properties; throw new Error('lost response'); }
    return response(200);
  };
  await drainQueue(db, http);
  db.prepare('UPDATE connector_queue SET next_try_at=0').run();
  await drainQueue(db, http);
  expect(creates).toBe(1);
  expect(pages.some((p) => p.includes('offset=100'))).toBe(true);
  expect(db.prepare('SELECT url FROM microblog_clipping_posts').get()).toEqual({ url: remoteUrl });
  db.close();
});

it('retains published automatic passages when automatic sync is disabled and another is selected', async () => {
  const { db, uid } = await setup();
  db.prepare("UPDATE microblog_clipping_selections SET manual=0").run();
  db.prepare("UPDATE connector_accounts SET options='{" + '"sync_highlights":true' + "}'").run();
  const posts: any[] = [];
  const http: HttpTransport = async (_url, init) => {
    if (init.method === 'GET') return response(200, {});
    const body = JSON.parse(init.body!); posts.push(body);
    return response(body.action ? 200 : 201, {}, remoteUrl);
  };
  await drainQueue(db, http);
  db.prepare("UPDATE connector_accounts SET options='{}'").run();
  db.prepare("UPDATE clippings SET deleted=1").run();
  db.prepare('INSERT INTO clippings(user_id,document,id,text,spine_index,created_at,updated_at) VALUES(?,?,?,?,1,2,2)').run(uid, DOC, 'two', 'Second passage');
  selectMicroblogClipping(db, uid, DOC, 'two');
  scheduleMicroblogClippings(db, uid, DOC);
  await drainQueue(db, http);
  expect(posts).toHaveLength(2);
  expect(JSON.stringify(posts[1])).toContain('&lt;First passage&gt;');
  expect(JSON.stringify(posts[1])).toContain('Second passage');
  db.close();
});
