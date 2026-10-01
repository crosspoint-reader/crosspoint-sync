import { expect, it } from 'vitest';
import { makeTestApp, registerUser } from './helpers.js';
it('routes merged-book progress/clippings while preserving stats under their original hash', async () => {
 const {app,db}=makeTestApp(); const {headers}=await registerUser(app);
 const alias='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', canonical='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
 db.prepare('INSERT INTO document_aliases(user_id,alias,document,created_at) SELECT id,?,?,1 FROM users').run(alias,canonical);
 const progress={document:alias,progress:'/body/DocFragment[1]/body/p[1].0',percentage:.4,device:'Synthetic',device_id:'crossink-diagnostic'};
 const book={document:alias,v:5,sessions:1,seconds:60,pages:10,completed:false,avg_fwd:0,pace_n:0,eta:0,start_manual:false,finish_manual:false,start_date:0,finished_date:0,tod:[0,0,0,0],dow:[0,0,0,0,0,0,0]};
 const clip={id:'0123456789abcdef',spine:0,text:'Synthetic quote',created_at:0};
 const statuses=[];
 for (const [url,body] of [['/syncs/progress',progress],['/api/v1/stats/books',{device_id:'crossink-diagnostic',items:[book]}],['/api/v1/clippings/'+alias,{items:[clip]}]] as const){
  statuses.push((await app.request(url,{method:'PUT',headers,body:JSON.stringify(body)})).status);
 }
 expect(statuses).toEqual([200,200,200]);
 const progressDoc=db.prepare('SELECT document FROM progress').get();
 const statsDoc=db.prepare('SELECT document FROM stats_device_book').get();
 const clippingDoc=db.prepare('SELECT document FROM clippings').get();

 expect(progressDoc?.document).toBe(canonical);
 expect(statsDoc?.document).toBe(alias);
 expect(clippingDoc?.document).toBe(canonical);
 const stats=await (await app.request('/api/v1/stats/books/'+canonical,{headers})).json();
 const clippings=await (await app.request('/api/v1/clippings/'+canonical,{headers})).json();
 expect(stats.devices).toHaveLength(1); expect(clippings.items).toHaveLength(1);
 db.close();
});

const ALIAS = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CANONICAL = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CLIP_ID = '0123456789abcdef';
const bookSnapshot = (seconds: number) => ({
  v: 5, sessions: 1, seconds, pages: 10, completed: false, avg_fwd: 0, pace_n: 0, eta: 0,
  start_manual: false, finish_manual: false, start_date: 0, finished_date: 0,
  tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0],
});

async function mergedFixture() {
  const { app, db } = makeTestApp();
  const { headers } = await registerUser(app);
  const userId = db.prepare('SELECT id FROM users').get()!.id as number;
  db.prepare('INSERT INTO document_aliases (user_id, alias, document, created_at) VALUES (?, ?, ?, 1)')
    .run(userId, ALIAS, CANONICAL);
  function seedStats(document: string, device: string, seconds: number, at: number) {
    db.prepare('INSERT INTO stats_device_book (user_id, document, device_id, payload, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, document, device, JSON.stringify(bookSnapshot(seconds)), at);
  }
  function seedClip(document: string, revision: number, deleted = 0, note: string | null = null, color: string | null = null, id = CLIP_ID) {
    db.prepare(`INSERT INTO clippings (user_id, document, id, spine_index, text, note, color, created_at, deleted, updated_at, revision)
                VALUES (?, ?, ?, 0, ?, ?, ?, 1, ?, ?, ?)`)
      .run(userId, document, id, `synthetic-${revision}`, note, color, deleted, revision, revision);
    db.prepare('UPDATE clipping_sync_clock SET revision = MAX(revision, ?) WHERE id = 1').run(revision);
  }
  async function get(path: string) { return (await app.request(path, { headers })).json(); }
  async function putClip(document: string, extra: Record<string, unknown> = {}) {
    const res = await app.request(`/api/v1/clippings/${document}`, {
      method: 'PUT', headers, body: JSON.stringify({ items: [{ id: CLIP_ID, spine: 0, text: 'new synthetic quote', ...extra }] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).accepted).toBe(1);
  }
  return { app, db, headers, userId, seedStats, seedClip, get, putClip };
}

it('preserves additive and selective stats merge semantics for existing and future uploads', async () => {
  const f = await mergedFixture();
  f.seedStats(CANONICAL, 'reader1', 60, 10);
  f.seedStats(ALIAS, 'reader1', 90, 20);
  expect((await f.get(`/api/v1/stats/books/${CANONICAL}`)).combined.seconds).toBe(150);
  f.db.prepare('UPDATE document_aliases SET merge_stats = 0 WHERE user_id = ?').run(f.userId);
  expect((await f.get(`/api/v1/stats/books/${CANONICAL}`)).combined.seconds).toBe(60);
  const res = await f.app.request('/api/v1/stats/books', { method: 'PUT', headers: f.headers,
    body: JSON.stringify({device_id: 'reader1', items: [{document: ALIAS, ...bookSnapshot(120)}]}) });
  expect(res.status).toBe(200);
  expect((await f.get(`/api/v1/stats/books/${CANONICAL}`)).combined.seconds).toBe(60);
  expect(f.db.prepare('SELECT payload FROM stats_device_book WHERE document = ?').get(ALIAS)!.payload).toContain('"seconds":120');
  f.db.prepare('UPDATE document_aliases SET merge_stats = 1 WHERE user_id = ?').run(f.userId);
  expect((await f.get(`/api/v1/stats/books/${CANONICAL}`)).combined.seconds).toBe(180);
  f.db.prepare('DELETE FROM document_aliases WHERE user_id = ?').run(f.userId);
  expect((await f.get(`/api/v1/stats/books/${ALIAS}`)).combined.seconds).toBe(120);
  expect((await f.get(`/api/v1/stats/books/${CANONICAL}`)).combined.seconds).toBe(60);
  f.db.close();
});

it('makes historical alias clippings visible in canonical/alias reads and the hub without duplicate IDs', async () => {
  const f = await mergedFixture();
  f.seedClip(CANONICAL, 1, 0, 'keep canonical annotation', 'blue');
  f.seedClip(ALIAS, 2);
  const canonical = await f.get(`/api/v1/clippings/${CANONICAL}?cursor=0`);
  const alias = await f.get(`/api/v1/clippings/${ALIAS}?cursor=0`);
  expect(canonical.items).toHaveLength(1);
  expect(alias.document).toBe(ALIAS);
  expect(alias.items).toEqual(canonical.items);
  expect(canonical.items[0]).toMatchObject({ text: 'synthetic-2', note: 'keep canonical annotation', color: 'blue' });
  expect((await f.get('/api/v1/clippings')).items).toMatchObject([{ document: CANONICAL, id: CLIP_ID }]);
  await f.putClip(ALIAS);
  expect((await f.get(`/api/v1/clippings/${CANONICAL}`)).items[0]).toMatchObject({ text: 'new synthetic quote', note: 'keep canonical annotation', color: 'blue' });
  // Both old rows remain; only the canonical copy is updated.
  expect(f.db.prepare('SELECT text FROM clippings WHERE document = ?').get(ALIAS)!.text).toBe('synthetic-2');
  await f.putClip(CANONICAL, { note: null, color: null });
  expect((await f.get(`/api/v1/clippings/${ALIAS}`)).items[0]).toMatchObject({ note: null, color: null });
  f.db.close();
});

it.each([CANONICAL, ALIAS])('respects an old tombstone at %s after a newer live copy and future uploads', async (tombstoneDoc) => {
  const f = await mergedFixture();
  const liveDoc = tombstoneDoc === CANONICAL ? ALIAS : CANONICAL;
  f.seedClip(tombstoneDoc, 2, 1);
  f.seedClip(liveDoc, 9);
  const body = await f.get(`/api/v1/clippings/${CANONICAL}?cursor=0`);
  expect(body.items).toHaveLength(1);
  expect(body.items[0]).toMatchObject({ deleted: 1, revision: 9 });
  expect((await f.get('/api/v1/clippings')).items).toHaveLength(0);
  await f.putClip(ALIAS);
  await f.putClip(CANONICAL);
  expect((await f.get(`/api/v1/clippings/${ALIAS}?cursor=0`)).items[0].deleted).toBe(1);
  await f.putClip(ALIAS, { deleted: true });
  const delta = await f.get(`/api/v1/clippings/${CANONICAL}?cursor=9`);
  expect(delta.items).toHaveLength(1);
  expect(delta.items[0].deleted).toBe(1);
  f.db.close();
});

it('deduplicates before applying delta filters and paginates logical clipping records', async () => {
  const f = await mergedFixture();
  f.seedClip(ALIAS, 1);
  f.seedClip(CANONICAL, 4);
  f.seedClip(ALIAS, 8, 0, null, null, 'fedcba9876543210');
  const page1 = await f.get(`/api/v1/clippings/${ALIAS}?cursor=0&limit=1`);
  expect(page1.items).toHaveLength(1);
  expect(page1.more).toBe(true);
  expect(page1.cursor).toBe(4);
  const page2 = await f.get(`/api/v1/clippings/${CANONICAL}?cursor=${page1.cursor}&limit=1`);
  expect(page2.items).toHaveLength(1);
  expect(page2.cursor).toBe(8);
  expect(page2.more).toBe(false);
  expect((await f.get(`/api/v1/clippings/${ALIAS}?cursor=8`)).items).toHaveLength(0);
  expect((await f.get(`/api/v1/clippings/${ALIAS}?since=4`)).items).toHaveLength(1);
  f.db.close();
});

it('keeps merged side data isolated between users with identical document hashes', async () => {
  const f = await mergedFixture();
  f.seedStats(ALIAS, 'reader1', 60, 1);
  f.seedClip(ALIAS, 1);
  const other = await registerUser(f.app);
  for (const path of [`/api/v1/stats/books/${CANONICAL}`, `/api/v1/stats/books/${ALIAS}`]) {
    expect((await (await f.app.request(path, { headers: other.headers })).json()).devices).toHaveLength(0);
  }
  for (const path of ['/api/v1/clippings', `/api/v1/clippings/${ALIAS}`, `/api/v1/clippings/${CANONICAL}`]) {
    expect((await (await f.app.request(path, { headers: other.headers })).json()).items).toHaveLength(0);
  }
  f.db.close();
});
