import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTestApp, registerUser } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { upsertAccount } from '../src/connectors/store.js';
import { destinationForPost } from '../src/connectors/microblog-destinations.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY = 'a'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });
const a = 'https://first.micro.blog/';
const b = 'https://second.micro.blog/';
async function setup(destinations: unknown[]) {
  const { app, db } = makeTestApp({}, { connectorTransport: async (url) => {
    expect(url).toBe('https://micro.blog/micropub?q=config');
    return { status: 200, json: async () => ({ destination: destinations }), text: async () => '' };
  } });
  const { headers, username } = await registerUser(app);
  const uid = (db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number }).id;
  upsertAccount(db, uid, 'microblog', { token: 'token' }, null);
  const get = () => app.request('/api/v1/connectors/microblog/destinations', { headers });
  const save = (destination: string) => app.request('/api/v1/connectors/microblog/destination', { method: 'PUT', headers, body: JSON.stringify({ destination }) });
  return { app, db, uid, headers, get, save };
}

it('requires a choice with multiple blogs, validates saves, and preserves it through automatic-sync option changes', async () => {
  const s = await setup([{ uid: a, name: 'First', 'microblog-default': true }, { uid: b, name: 'Second' }]);
  const res = await s.get(); expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ selected: null, items: [{ uid: a, name: 'First' }, { uid: b, name: 'Second' }] });
  expect((await s.save('https://unavailable.micro.blog/')).status).toBe(400);
  expect((await s.save(b)).status).toBe(200);
  expect(await (await s.get()).json()).toMatchObject({ selected: b });
  await s.app.request('/api/v1/connectors/microblog/options', { method: 'PUT', headers: s.headers, body: JSON.stringify({ sync_highlights: true }) });
  expect(await (await s.get()).json()).toMatchObject({ selected: b });
  s.db.close();
});

it('uses the sole valid blog and removes malformed or duplicate configuration entries', async () => {
  const s = await setup([null, { uid: 'javascript:alert(1)' }, { uid: a, name: 'First' }, { uid: a, name: 'Duplicate' }]);
  const res = await s.get(); expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ selected: a, items: [{ uid: a, name: 'First', isDefault: false }] });
  s.db.close();
});

it('does not expose another user’s token or choices and rejects unlinked accounts', async () => {
  const s = await setup([{ uid: a }]);
  const other = await registerUser(s.app);
  expect((await s.app.request('/api/v1/connectors/microblog/destinations', { headers: other.headers })).status).toBe(400);
  expect((await s.app.request('/api/v1/connectors/microblog/destinations')).status).toBe(401);
  s.db.close();
});

it('preserves original collections when a rotated token has a different default but access to both blogs', async () => {
  const s = await setup([{ uid: a }, { uid: b }]);
  upsertAccount(s.db, s.uid, 'microblog', { token: 'old', microblogDestination: a }, null);
  s.db.prepare('INSERT INTO microblog_clipping_posts(user_id,document,identity,url) VALUES(?,?,?,?)').run(s.uid, 'book', 'identity', `${a}post.html`);
  upsertAccount(s.db, s.uid, 'microblog', { token: 'new', microblogDestination: b, microblogDestinations: [{ uid: a }, { uid: b }] }, null);
  expect(s.db.prepare('SELECT identity,url FROM microblog_clipping_posts').get()).toEqual({ identity: 'identity', url: `${a}post.html` });
  s.db.close();
});
it('identifies URL path boundaries and the longest matching blog prefix', () => {
  const blogs = ['https://shared.test/blog/', 'https://shared.test/blog/reading/'].map((uid) => ({ uid, name: uid, isDefault: false }));
  expect(destinationForPost('https://shared.test/blog/reading/post.html', blogs)).toBe('https://shared.test/blog/reading/');
  expect(destinationForPost('https://shared.test/blogging/post.html', blogs)).toBeNull();
  expect(destinationForPost('https://shared.test.evil/blog/post.html', blogs)).toBeNull();
});
