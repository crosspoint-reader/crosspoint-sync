import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTestApp, registerUser, DOC } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { upsertAccount, saveMatch } from '../src/connectors/store.js';
import { drainQueue } from '../src/connectors/runner.js';
import { selectMicroblogClipping, scheduleMicroblogClippings } from '../src/connectors/microblog-clippings.js';
import type { HttpTransport } from '../src/connectors/types.js';
beforeEach(() => { process.env.TOKEN_ENC_KEY = 'a'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });
const a = 'https://first.micro.blog/'; const b = 'https://second.micro.blog/';
async function setup() {
  let blogs = [a, b]; let sourceStatus = 200;
  const writes: { destination: string | null; body: any }[] = [];
  const requests: string[] = [];
  let onCreate: (() => Promise<void>) | undefined;
  let onDiscover: (() => void) | undefined;
  const http: HttpTransport = async (url, init) => {
    const parsed = new URL(url);
    let status = 200; let body: unknown = {}; let location: string | null = null;
    if (parsed.searchParams.get('q') === 'config') { onDiscover?.(); body = { destination: blogs.map((uid, i) => ({ uid, name: uid, 'microblog-default': i === 0 })) }; }
    else {
      requests.push(url);
      const destination = parsed.searchParams.get('mp-destination');
      if (init.method === 'GET') { status = sourceStatus; body = { error: 'invalid_request', error_description: 'No post found for this URL.' }; }
      else {
        const data = JSON.parse(init.body!); writes.push({ destination, body: data });
        if (!data.action) { await onCreate?.(); status = 201; location = `${destination || a}post.html`; }
      }
    }
    return { status, headers: { get: () => location }, json: async () => body, text: async () => JSON.stringify(body) };
  };
  const { app, db } = makeTestApp({}, { connectorTransport: http });
  const { headers, username } = await registerUser(app);
  const uid = (db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number }).id;
  upsertAccount(db, uid, 'microblog', { token: 'token', microblogDestination: a }, null);
  db.prepare('INSERT INTO documents(user_id,document,title,updated_at) VALUES(?,?,?,0)').run(uid, DOC, 'Test book');
  db.prepare('INSERT INTO clippings(user_id,document,id,text,spine_index,created_at,updated_at) VALUES(?,?,?,?,0,1,1)').run(uid, DOC, 'one', 'First passage');
  saveMatch(db, uid, 'microblog', DOC, { externalId: '123', externalEdition: '9781786487849', confidence: 1 }, 'manual');
  selectMicroblogClipping(db, uid, DOC, 'one');
  const choose = (destination: string) => app.request('/api/v1/connectors/microblog/destination', { method: 'PUT', headers, body: JSON.stringify({ destination }) });
  const sync = async () => { scheduleMicroblogClippings(db, uid, DOC); await drainQueue(db, http); };
  const recreate = (target?: string) => app.request(`/api/v1/connectors/microblog/clipping-posts/${DOC}/recreate`, { method: 'POST', headers, ...(target ? { body: JSON.stringify({ target }) } : {}) });
  const status = async () => (await app.request('/api/v1/connectors/microblog/clipping-posts', { headers })).json();
  return { db, app, uid, headers, http, writes, requests, choose, sync, recreate, status,
    setBlogs: (value: string[]) => { blogs = value; }, missing: (code = 404) => { sourceStatus = code; },
    onCreate: (fn: () => Promise<void>) => { onCreate = fn; },
    onDiscover: (fn: () => void) => { onDiscover = fn; },
    change: () => db.prepare('UPDATE clippings SET note=? WHERE user_id=?').run('New annotation', uid) };
}

it('does not silently publish to the default when several blogs need a selection', async () => {
  const s = await setup(); await s.sync(); expect(s.writes).toHaveLength(0); s.db.close();
});
it('creates 📚 collections on the selected blog and keeps updates there after the selection changes', async () => {
  const s = await setup(); await s.choose(b); await s.sync();
  expect(s.writes[0]).toMatchObject({ destination: b, body: { properties: { name: ['📚 Clippings from Test book'] } } });
  await s.choose(a); s.change(); await s.sync();
  expect(s.writes).toHaveLength(2); expect(s.writes[1]).toMatchObject({ destination: b, body: { action: 'update', url: `${b}post.html` } });
  expect(s.requests.every((url) => new URL(url).searchParams.get('mp-destination') === b)).toBe(true);
  s.db.close();
});
it('pins creation before a concurrent change of the plugin-wide blog choice', async () => {
  const s = await setup(); await s.choose(b);
  s.onCreate(async () => { await s.choose(a); });
  await s.sync(); s.change(); await s.sync();
  expect(s.writes.every((w) => w.destination === b)).toBe(true); s.db.close();
});
it('uses the sole blog automatically and refuses revoked destinations', async () => {
  const s = await setup(); s.setBlogs([b]); await s.sync(); expect(s.writes[0]?.destination).toBe(b);
  s.setBlogs([a]); s.change(); await s.sync(); expect(s.writes).toHaveLength(1); s.db.close();
});
it('pauses a deleted post and explicitly recreates it on the original blog with saved and new clippings', async () => {
  const s = await setup(); await s.choose(b); await s.sync(); s.missing(400); s.change(); await s.sync();
  expect(await s.status()).toMatchObject({ items: [{ document: DOC, missing: true, destination: b }] });
  await s.choose(a);
  s.db.prepare('INSERT INTO clippings(user_id,document,id,text,spine_index,created_at,updated_at) VALUES(?,?,?,?,1,2,2)').run(s.uid, DOC, 'two', 'Second passage');
  selectMicroblogClipping(s.db, s.uid, DOC, 'two'); await s.sync(); expect(s.writes).toHaveLength(1);
  expect((await s.recreate()).status).toBe(200);
  await s.recreate(); // Cannot reset a replacement already awaiting publication.
  await drainQueue(s.db, s.http);
  expect(s.writes).toHaveLength(2);
  expect(s.writes[1]).toMatchObject({ destination: b, body: { properties: { name: ['📚 Clippings from Test book'] } } });
  expect(JSON.stringify(s.writes[1])).toContain('First passage'); expect(JSON.stringify(s.writes[1])).toContain('Second passage');
  s.db.close();
});
it.each([401, 403, 429, 500])('does not offer recreation for an unconfirmed deletion (%s)', async (code) => {
  const s = await setup(); await s.choose(b); await s.sync(); s.missing(code); s.change(); await s.sync();
  expect(await s.status()).toMatchObject({ items: [{ missing: false }] });
  expect((await s.recreate()).status).not.toBe(200); expect(s.writes).toHaveLength(1); s.db.close();
});
it('recreates on the current clippings blog when explicitly chosen and pins later updates there', async () => {
  const s = await setup(); await s.choose(b); await s.sync(); s.missing(); s.change(); await s.sync();
  await s.choose(a);
  expect((await s.recreate('current')).status).toBe(200);
  await drainQueue(s.db, s.http);
  expect(s.writes[1]).toMatchObject({ destination: a, body: { properties: { name: ['📚 Clippings from Test book'] } } });
  expect(JSON.stringify(s.writes[1])).toContain('First passage');
  await s.choose(b); s.missing(200);
  s.db.prepare('UPDATE clippings SET note=? WHERE user_id=?').run('Later annotation', s.uid);
  await s.sync();
  expect(s.writes[2]).toMatchObject({ destination: a, body: { action: 'update', url: `${a}post.html` } });
  s.db.close();
});
it('allows explicit recreation on the current blog after access to the previous blog is lost', async () => {
  const s = await setup(); await s.choose(b); await s.sync(); s.missing(); s.change(); await s.sync();
  await s.choose(a); s.setBlogs([a]);
  expect((await s.recreate('current')).status).toBe(200); await drainQueue(s.db, s.http);
  expect(s.writes[1]?.destination).toBe(a); s.db.close();
});
it('rejects an invalid recreation choice without changing the paused post', async () => {
  const s = await setup(); await s.choose(b); await s.sync(); s.missing(); s.change(); await s.sync();
  expect((await s.recreate('elsewhere')).status).toBe(400);
  expect(await s.status()).toMatchObject({ items: [{ missing: true, destination: b }] }); s.db.close();
});
it.each(['unselected', 'revoked'])('does not fall back to another blog when the current blog is %s', async (mode) => {
  const s = await setup(); await s.choose(b); await s.sync(); s.missing(); s.change(); await s.sync();
  if (mode === 'unselected') s.db.prepare("UPDATE connector_accounts SET options='{}' WHERE user_id=?").run(s.uid);
  else { await s.choose(a); s.setBlogs([b]); }
  expect((await s.recreate('current')).status).toBe(409);
  expect(await s.status()).toMatchObject({ items: [{ missing: true, destination: b }] });
  expect(s.writes).toHaveLength(1); s.db.close();
});
it('refuses to move a post that has been restored on the previous blog', async () => {
  const s = await setup(); await s.choose(b); await s.sync(); s.missing(); s.change(); await s.sync();
  await s.choose(a); s.missing(200);
  expect((await s.recreate('current')).status).toBe(409);
  expect(await s.status()).toMatchObject({ items: [{ missing: true, destination: b }] });
  expect(s.writes).toHaveLength(1); s.db.close();
});
it('resumes an original post that has been restored instead of creating a duplicate', async () => {
  const s = await setup(); await s.choose(b); await s.sync(); s.missing(); s.change(); await s.sync();
  s.missing(200); expect((await s.recreate()).status).toBe(200); await drainQueue(s.db, s.http);
  expect(s.writes.filter((w) => !w.body.action)).toHaveLength(1); s.db.close();
});

it('identifies a legacy post’s original blog rather than using the new plugin choice', async () => {
  const s = await setup(); await s.choose(b); await s.sync();
  s.db.prepare('UPDATE microblog_clipping_posts SET destination=NULL').run();
  await s.choose(a); s.change(); await s.sync();
  expect(s.writes[1]?.destination).toBe(b); s.db.close();
});
it('does not publish automatic additions switched off while discovering blogs', async () => {
  const s = await setup(); await s.choose(b);
  s.db.prepare('UPDATE microblog_clipping_selections SET manual=0').run();
  s.db.prepare('UPDATE connector_accounts SET options=?').run(JSON.stringify({ highlight_blog: b, sync_highlights: true }));
  s.onDiscover(() => { s.db.prepare('UPDATE connector_accounts SET options=?').run(JSON.stringify({ highlight_blog: b, sync_highlights: false })); });
  await s.sync(); expect(s.writes).toHaveLength(0); s.db.close();
});
