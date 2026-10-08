import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, md5, registerUser } from './helpers.js';
import { upsertProgress } from '../src/routes/kosync.js';
import { migrate, openDatabase } from '../src/db/db.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DOC2 = md5('second book');
const DOC3 = md5('third book');
const ALIAS = 'ffeeddccbbaa99887766554433221100';

async function setup() {
  const { app, db } = makeTestApp();
  const { headers } = await registerUser(app);
  const userId = (db.prepare('SELECT id FROM users ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
  const push = (document: string, percentage: number, deviceId = 'phone', viaKosync = false) =>
    app.request(viaKosync ? '/syncs/progress' : '/api/v1/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document, progress: `/body/p[${Math.round(percentage * 100)}]`, percentage, device: deviceId, device_id: deviceId }),
    });
  const changes = async (query = '') => {
    const res = await app.request(`/api/v1/progress/changes${query}`, { headers });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      cursor: number;
      more: boolean;
      changes: { document: string; aliases: string[]; percentage: number; device_id: string; position: unknown }[];
    };
  };
  const logRows = (document = DOC) =>
    (db.prepare('SELECT COUNT(*) AS n FROM progress_log WHERE user_id = ? AND document = ?').get(userId, document) as {
      n: number;
    }).n;
  return { app, db, headers, userId, push, changes, logRows };
}

describe('progress change feed', () => {
  it('stamps increasing sequence numbers across kosync, v1, fan-in and merge writes', async () => {
    const { app, db, headers, userId, push } = await setup();
    const seqOf = (document: string) =>
      (db.prepare('SELECT MAX(change_seq) AS s FROM progress WHERE user_id = ? AND document = ?').get(userId, document) as {
        s: number;
      }).s;
    await push(DOC, 0.1, 'phone', true);
    const a = seqOf(DOC);
    await push(DOC2, 0.2);
    const b = seqOf(DOC2);
    upsertProgress(db, {
      userId, document: DOC3, deviceId: 'kindle', device: 'Kindle', percentage: 0.3,
      progress: 'kindle:300000', position: null, metadata: null, updatedAt: 1,
    });
    const c = seqOf(DOC3);
    const merged = await app.request('/api/v1/documents/merge', {
      method: 'POST', headers, body: JSON.stringify({ document: DOC3, into: DOC }),
    });
    expect(merged.status).toBe(200);
    const d = seqOf(DOC);
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(d).toBeGreaterThan(c);
  });

  it('returns everything for since=0 and only newer changes after the cursor', async () => {
    const { push, changes } = await setup();
    await push(DOC, 0.1);
    await push(DOC2, 0.2);
    const first = await changes('?since=0');
    expect(first.changes.map((ch) => ch.document)).toEqual([DOC, DOC2]);
    expect(first.more).toBe(false);
    expect((await changes(`?since=${first.cursor}`)).changes).toEqual([]);
    await push(DOC, 0.15);
    const next = await changes(`?since=${first.cursor}`);
    expect(next.changes.map((ch) => [ch.document, ch.percentage])).toEqual([[DOC, 0.15]]);
    expect(next.cursor).toBeGreaterThan(first.cursor);
  });

  it('reports a fan-in row with an old updated_at after the cursor', async () => {
    const { db, userId, push, changes } = await setup();
    await push(DOC, 0.1);
    const { cursor } = await changes();
    upsertProgress(db, {
      userId, document: DOC2, deviceId: 'kindle', device: 'Kindle', percentage: 0.4,
      progress: 'kindle:400000', position: null, metadata: null, updatedAt: 1000,
    });
    const page = await changes(`?since=${cursor}`);
    expect(page.changes).toMatchObject([{ document: DOC2, device_id: 'kindle', percentage: 0.4 }]);
  });

  it('ignores a change to an older row that is not the newest', async () => {
    const { db, userId, push, changes } = await setup();
    await push(DOC, 0.5);
    const { cursor } = await changes();
    upsertProgress(db, {
      userId, document: DOC, deviceId: 'kindle', device: 'Kindle', percentage: 0.4,
      progress: 'kindle:400000', position: null, metadata: null, updatedAt: 1000,
    });
    const page = await changes(`?since=${cursor}`);
    expect(page.changes).toEqual([]);
    expect(page.cursor).toBeGreaterThanOrEqual(cursor);
  });

  it('includes aliases and reports a merge to devices', async () => {
    const { app, headers, push, changes } = await setup();
    await push(DOC, 0.2);
    await push(ALIAS, 0.6, 'kobo');
    const { cursor } = await changes();
    await app.request('/api/v1/documents/merge', {
      method: 'POST', headers, body: JSON.stringify({ document: ALIAS, into: DOC }),
    });
    const page = await changes(`?since=${cursor}`);
    expect(page.changes).toMatchObject([{ document: DOC, aliases: [ALIAS], percentage: 0.6, device_id: 'kobo' }]);
  });

  it("leaves out documents whose newest row is the requesting device's own", async () => {
    const { push, changes } = await setup();
    await push(DOC, 0.5, 'phone');
    await push(DOC, 0.3, 'crossink-aabbccddeeff');
    await push(DOC2, 0.2, 'phone');
    const page = await changes('?device=crossink-aabbccddeeff');
    // No fallback to the phone's older row for DOC.
    expect(page.changes.map((ch) => ch.document)).toEqual([DOC2]);
    const all = await changes();
    expect(all.changes.map((ch) => [ch.document, ch.device_id])).toEqual([
      [DOC, 'crossink-aabbccddeeff'],
      [DOC2, 'phone'],
    ]);
  });

  it('advances the cursor past self-written changes even when nothing else changed', async () => {
    const { push, changes } = await setup();
    await push(DOC, 0.5, 'reader');
    const page = await changes('?device=reader');
    expect(page.changes).toEqual([]);
    expect(page.cursor).toBeGreaterThan(0);
    expect((await changes(`?since=${page.cursor}`)).changes).toEqual([]);
  });

  it('pages by limit with a resumable cursor', async () => {
    const { push, changes } = await setup();
    await push(DOC, 0.1);
    await push(DOC2, 0.2);
    await push(DOC3, 0.3);
    const p1 = await changes('?limit=2');
    expect(p1.changes.map((ch) => ch.document)).toEqual([DOC, DOC2]);
    expect(p1.more).toBe(true);
    const p2 = await changes(`?since=${p1.cursor}&limit=2`);
    expect(p2.changes.map((ch) => ch.document)).toEqual([DOC3]);
    expect(p2.more).toBe(false);
  });

  it('clamps limit to 50', async () => {
    const { db, userId, changes } = await setup();
    // Small rows, so the 8 KB cap does not end the page first.
    for (let i = 0; i < 60; i++) {
      upsertProgress(db, {
        userId, document: md5(`book ${i}`), deviceId: 'd', device: '', percentage: 0.5,
        progress: 'p', position: null, metadata: null, updatedAt: 1,
      });
    }
    const page = await changes('?limit=500');
    expect(page.changes).toHaveLength(50);
    expect(page.more).toBe(true);
  });

  it('treats an empty limit as the default page size', async () => {
    const { push, changes } = await setup();
    for (let i = 0; i < 25; i++) await push(md5(`book ${i}`), 0.5);
    expect((await changes('?limit=')).changes).toHaveLength(20);
  });

  it('keeps pages under 8 KB', async () => {
    const { app, headers, changes } = await setup();
    const longPath = '/body/' + 'div[1]/'.repeat(80) + 'p[1]';
    for (let i = 0; i < 60; i++) {
      await app.request('/api/v1/progress', {
        method: 'PUT', headers,
        body: JSON.stringify({ document: md5(`book ${i}`), progress: longPath, percentage: 0.5, device_id: 'phone' }),
      });
    }
    const res = await app.request('/api/v1/progress/changes?limit=500', { headers });
    const body = await res.text();
    const page = JSON.parse(body) as { more: boolean; changes: unknown[] };
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(8 * 1024);
    expect(page.changes.length).toBeGreaterThan(0);
    expect(page.changes.length).toBeLessThan(50);
    expect(page.more).toBe(true);
  });

  it('returns at least one change even when it alone exceeds 8 KB', async () => {
    const { db, userId, changes } = await setup();
    upsertProgress(db, {
      userId, document: DOC, deviceId: 'phone', device: 'Phone', percentage: 0.5,
      progress: '/body/' + 'x'.repeat(9000), position: null, metadata: null, updatedAt: 1,
    });
    const page = await changes();
    expect(page.changes).toHaveLength(1);
    expect(page.cursor).toBeGreaterThan(0);
  });

  it('limit=0 returns only the current cursor', async () => {
    const { push, changes } = await setup();
    expect(await changes('?limit=0')).toEqual({ cursor: 0, more: false, changes: [] });
    await push(DOC, 0.1);
    await push(DOC2, 0.2);
    const full = await changes();
    expect(await changes('?limit=0')).toEqual({ cursor: full.cursor, more: false, changes: [] });
  });

  it("does not leak another user's changes", async () => {
    const { app, push, changes } = await setup();
    const other = await registerUser(app);
    await app.request('/api/v1/progress', {
      method: 'PUT', headers: other.headers,
      body: JSON.stringify({ document: DOC2, progress: '/body/p[1]', percentage: 0.9, device_id: 'phone' }),
    });
    await push(DOC, 0.1);
    expect((await changes()).changes.map((ch) => ch.document)).toEqual([DOC]);
  });

  it('requires auth', async () => {
    const { app } = await setup();
    const res = await app.request('/api/v1/progress/changes');
    expect(res.status).toBe(401);
  });
});

describe('history check for a device without its own row', () => {
  it("compares a per-reader CrossInk id against the legacy shared row", async () => {
    const { db, userId, push, logRows } = await setup();
    await push(DOC, 0.4, 'crossink-device');
    // A newer, lower position from another device: the newest row is now 0.2.
    upsertProgress(db, {
      userId, document: DOC, deviceId: 'phone', device: 'Phone', percentage: 0.2,
      progress: '/body/p[20]', position: null, metadata: null, updatedAt: Math.floor(Date.now() / 1000) + 60,
    });
    const before = logRows();
    await push(DOC, 0.4, 'crossink-aabbccddeeff');
    expect(logRows()).toBe(before);
    await push(DOC, 0.45, 'crossink-aabbccddeeff');
    expect(logRows()).toBe(before + 1);
  });

  it('compares a new id with no legacy row against the newest row', async () => {
    const { push, logRows } = await setup();
    await push(DOC, 0.4, 'phone');
    const before = logRows();
    await push(DOC, 0.4, 'kobo');
    expect(logRows()).toBe(before);
    await push(DOC2, 0.3, 'phone');
    const before2 = logRows(DOC2);
    await push(DOC2, 0.35, 'kobo');
    expect(logRows(DOC2)).toBe(before2 + 1);
  });

  it('still logs the first write of a brand-new document', async () => {
    const { push, logRows } = await setup();
    await push(DOC, 0.4, 'crossink-aabbccddeeff');
    expect(logRows()).toBe(1);
  });
});

describe('change_seq migration', () => {
  it('gives existing rows distinct non-zero sequence numbers', () => {
    const migrations = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seq-mig-'));
    for (const f of fs.readdirSync(migrations)) {
      if (f < '0024') fs.copyFileSync(path.join(migrations, f), path.join(dir, f));
    }
    const db = openDatabase(':memory:');
    migrate(db, dir);
    db.prepare("INSERT INTO users (username, key_hash, created_at) VALUES ('u', 'k', 0)").run();
    const insert = db.prepare(
      "INSERT INTO progress (user_id, document, device_id, device, percentage, progress, updated_at) VALUES (1, ?, 'd', '', 0.5, 'p', 1)"
    );
    insert.run(DOC);
    insert.run(DOC2);
    fs.copyFileSync(path.join(migrations, '0024_progress_change_seq.sql'), path.join(dir, '0024_progress_change_seq.sql'));
    migrate(db, dir);
    const seqs = (db.prepare('SELECT change_seq FROM progress ORDER BY change_seq').all() as { change_seq: number }[]).map(
      (r) => r.change_seq
    );
    expect(seqs[0]).toBeGreaterThan(0);
    expect(new Set(seqs).size).toBe(2);
    const counter = (db.prepare('SELECT value FROM change_seq').get() as { value: number }).value;
    expect(counter).toBe(seqs[1]);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
