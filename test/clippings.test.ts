import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, openDatabase } from '../src/db/db.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

// Mirrors CrossInk's Clipping struct (src/ClippingStore.h)
const CLIP = {
  id: 'c0ffee0011223344',
  spine: 7,
  start_page: 12,
  end_page: 13,
  pages: 40,
  start_word: 5,
  end_word: 22,
  words: 30,
  para: 96,
  chapter: 'Chapter 8',
  text: 'So we beat on, boats against the current, borne back ceaselessly into the past.',
  created_at: 1752300000,
};

describe('v1 clippings sync', () => {
  it('round-trips a clipping with all CrossInk fields', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const put = await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [CLIP] }),
    });
    expect(put.status).toBe(200);
    const body = await (await app.request(`/api/v1/clippings/${DOC}`, { headers })).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ ...CLIP, deleted: 0, note: null, color: null });
  });

  it('para is optional (CrossInk uses UINT16_MAX for unavailable)', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const { para: _para, ...noPara } = CLIP;
    await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [noPara] }),
    });
    const body = await (await app.request(`/api/v1/clippings/${DOC}`, { headers })).json();
    expect(body.items[0].para).toBeNull();
  });

  it('supports notes and colors (server-side extension fields)', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [{ ...CLIP, note: 'my note', color: 'yellow' }] }),
    });
    const body = await (await app.request(`/api/v1/clippings/${DOC}`, { headers })).json();
    expect(body.items[0].note).toBe('my note');
    expect(body.items[0].color).toBe('yellow');
  });

  it('tombstones delete a clipping', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [CLIP] }),
    });
    await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [{ id: CLIP.id, deleted: 1 }] }),
    });
    const body = await (await app.request(`/api/v1/clippings/${DOC}`, { headers })).json();
    expect(body.items[0].deleted).toBe(1);
  });

  it('rejects oversized text', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [{ ...CLIP, text: 'x'.repeat(4097) }] }),
    });
    expect(res.status).toBe(403);
  });
});

describe('firmware clipping protocol', () => {
  it('round-trips full UTF-8 text and source anchors across devices without dropping same-second pages', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const clips = Array.from({ length: 3 }, (_, i) => ({
      ...CLIP, id: `device-a-${i}`, text: 'é'.repeat(2048), layout_signature: 123,
      start_offset: 50 + i * 100, end_offset: 90 + i * 100,
    }));
    const put = await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT', headers, body: JSON.stringify({ items: clips }),
    });
    expect(put.status).toBe(200);
    let cursor = 0;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const page = await (await app.request(`/api/v1/clippings/${DOC}?cursor=${cursor}&limit=1&format=reader`, { headers })).json();
      expect(page.sync_version).toBe(2);
      expect(page.items[0]).not.toHaveProperty('note');
      expect(page.items[0]).not.toHaveProperty('color');
      expect(page.items[0].revision).toBe(page.cursor);
      expect(page.more).toBe(i < 2);
      expect(page.items[0]).toMatchObject(clips[i]);
      expect(page.cursor).toBeGreaterThan(cursor);
      cursor = page.cursor;
      ids.push(page.items[0].id);
    }
    expect(ids).toEqual(clips.map(c => c.id));
    await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT', headers, body: JSON.stringify({ items: [{ id: clips[0].id, deleted: 1 }] }),
    });
    // An offline retry from device A cannot resurrect device B's deletion.
    await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT', headers, body: JSON.stringify({ items: [clips[0]] }),
    });
    const changes = await (await app.request(`/api/v1/clippings/${DOC}?cursor=${cursor}&limit=1&format=reader`, { headers })).json();
    expect(changes.items).toHaveLength(1);
    expect(changes.items[0]).toMatchObject({ id: clips[0].id, deleted: 1 });
    const { headers: otherUser } = await registerUser(app);
    const privateData = await (await app.request(`/api/v1/clippings/${DOC}?cursor=0`, { headers: otherUser })).json();
    expect(privateData.items).toHaveLength(0);
  });

  it('rejects malformed batches atomically and preserves annotations on firmware retries', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    for (const bad of [null, [], { ...CLIP, start_offset: 20, end_offset: 10 }]) {
      const res = await app.request(`/api/v1/clippings/${DOC}`, {
        method: 'PUT', headers, body: JSON.stringify({ items: [CLIP, bad] }),
      });
      expect(res.status).toBe(403);
    }
    const empty = await (await app.request(`/api/v1/clippings/${DOC}`, { headers })).json();
    expect(empty.items).toHaveLength(0);
    for (const clip of [{ ...CLIP, note: 'keep this' }, CLIP]) {
      expect((await app.request(`/api/v1/clippings/${DOC}`, {
        method: 'PUT', headers, body: JSON.stringify({ items: [clip] }),
      })).status).toBe(200);
    }
    const body = await (await app.request(`/api/v1/clippings/${DOC}`, { headers })).json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].note).toBe('keep this');
  });
});

it('upgrades existing clippings without losing data and resumes revisions after migration', () => {
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipping-migration-'));
  const db = openDatabase(':memory:');
  try {
    const migrationsDir = fileURLToPath(new URL('../migrations', import.meta.url));
    for (const name of fs.readdirSync(migrationsDir).filter(name => name.endsWith('.sql') && name < '0010')) {
      fs.copyFileSync(path.join(migrationsDir, name), path.join(legacyDir, name));
    }
    migrate(db, legacyDir);
    db.exec("INSERT INTO users (id, username, key_hash, created_at) VALUES (1, 'legacy', 'test', 1)");
    db.prepare('INSERT INTO clippings (user_id, document, id, text, note, updated_at) VALUES (1, ?, ?, ?, ?, 1)')
      .run(DOC, CLIP.id, CLIP.text, 'preserved note');
    migrate(db);
    migrate(db); // restarting the server must not reapply the migration
    const row = db.prepare('SELECT text, note, revision, start_offset, end_offset FROM clippings').get()!;
    expect(row).toMatchObject({ text: CLIP.text, note: 'preserved note', start_offset: null, end_offset: null });
    expect(row.revision).toBeGreaterThan(0);
    db.exec('UPDATE clipping_sync_clock SET revision = revision + 1 WHERE id = 1');
    expect(db.prepare('SELECT revision FROM clipping_sync_clock').get()!.revision).toBeGreaterThan(row.revision);
  } finally {
    db.close();
    fs.rmSync(legacyDir, { recursive: true, force: true });
  }
});
