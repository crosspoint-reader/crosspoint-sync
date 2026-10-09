import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, md5, registerUser } from './helpers.js';
import { MAX_PROGRESS_BATCH } from '../src/routes/v1/progress.js';

const DOC2 = md5('second book');
const ALIAS = 'ffeeddccbbaa99887766554433221100';

async function setup() {
  const { app, db } = makeTestApp();
  const { headers } = await registerUser(app);
  const userId = (db.prepare('SELECT id FROM users ORDER BY id DESC LIMIT 1').get() as { id: number }).id;
  const item = (document: string, percentage: number, extra: Record<string, unknown> = {}) => ({
    document,
    progress: `/body/DocFragment[1]/body/p[${Math.round(percentage * 100)}]`,
    percentage,
    device: 'X4',
    device_id: 'crossink-aabbccddeeff',
    ...extra,
  });
  const batch = (items: unknown, auth = true) =>
    app.request('/api/v1/progress/batch', {
      method: 'PUT',
      headers: auth ? headers : { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
  const rows = () =>
    db
      .prepare('SELECT document, device_id, percentage, position, change_seq FROM progress WHERE user_id = ? ORDER BY document')
      .all(userId) as { document: string; device_id: string; percentage: number; position: string | null; change_seq: number }[];
  return { app, db, headers, userId, item, batch, rows };
}

describe('progress batch PUT', () => {
  it('stores every item like the kosync PUT and echoes the client hashes', async () => {
    const { db, userId, item, batch, rows } = await setup();
    const res = await batch([
      item(DOC, 0.25, { position: { pctQ: 250000, spine: 2, page: 4, pages: 10, para: 7 } }),
      item(DOC2, 0.5, { metadata: { title: 'Second', authors: 'Writer', filename: 'second.epub' } }),
    ]);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { accepted: number; items: { document: string; timestamp: number }[] };
    expect(body.accepted).toBe(2);
    expect(body.items.map((i) => i.document)).toEqual([DOC, DOC2]);
    const stored = rows();
    expect(stored.map((r) => [r.document, r.device_id, r.percentage])).toEqual(
      [
        [DOC, 'crossink-aabbccddeeff', 0.25],
        [DOC2, 'crossink-aabbccddeeff', 0.5],
      ].sort((a, b) => String(a[0]).localeCompare(String(b[0])))
    );
    expect(JSON.parse(stored.find((r) => r.document === DOC)!.position!)).toMatchObject({ spine: 2, page: 4 });
    // Each write gets its own feed sequence number, so the change feed reports both.
    expect(new Set(stored.map((r) => r.change_seq)).size).toBe(2);
    const title = db.prepare('SELECT title FROM documents WHERE user_id = ? AND document = ?').get(userId, DOC2) as
      | { title: string }
      | undefined;
    expect(title?.title).toBe('Second');
    // Reading history and position samples follow the kosync PUT path.
    const logged = db.prepare('SELECT COUNT(*) AS n FROM progress_log WHERE user_id = ?').get(userId) as { n: number };
    expect(logged.n).toBe(2);
  });

  it('appears in the change feed for other devices', async () => {
    const { app, headers, item, batch } = await setup();
    await batch([item(DOC, 0.3), item(DOC2, 0.6)]);
    const res = await app.request('/api/v1/progress/changes?since=0&device=phone', { headers });
    const feed = (await res.json()) as { changes: { document: string }[] };
    expect(feed.changes.map((c) => c.document).sort()).toEqual([DOC, DOC2].sort());
  });

  it('stores a merged hash under its canonical document and echoes the alias', async () => {
    const { app, headers, item, batch, rows } = await setup();
    await batch([item(DOC, 0.1)]);
    await batch([item(ALIAS, 0.2)]);
    const merged = await app.request('/api/v1/documents/merge', {
      method: 'POST',
      headers,
      body: JSON.stringify({ document: ALIAS, into: DOC }),
    });
    expect(merged.status).toBe(200);
    const res = await batch([item(ALIAS, 0.9)]);
    const body = (await res.json()) as { items: { document: string }[] };
    expect(body.items[0].document).toBe(ALIAS);
    expect(rows().filter((r) => r.document === DOC).map((r) => r.percentage)).toEqual([0.9]);
  });

  it('rejects the whole batch when any item is invalid', async () => {
    const { item, batch, rows } = await setup();
    const res = await batch([item(DOC, 0.4), item(DOC2, 0.5, { progress: '' })]);
    expect(res.status).toBe(403);
    expect(rows()).toEqual([]);
    const outOfRange = await batch([item(DOC, 1.5)]);
    expect(outOfRange.status).toBe(403);
    expect(rows()).toEqual([]);
  });

  it('rejects empty, oversized and malformed batches', async () => {
    const { app, headers, item, batch } = await setup();
    expect((await batch([])).status).toBe(403);
    const tooMany = Array.from({ length: MAX_PROGRESS_BATCH + 1 }, (_, i) => item(md5(`book ${i}`), 0.1));
    expect((await batch(tooMany)).status).toBe(403);
    expect((await batch('nope')).status).toBe(403);
    const notJson = await app.request('/api/v1/progress/batch', { method: 'PUT', headers, body: '{' });
    expect(notJson.status).toBe(403);
    const full = Array.from({ length: MAX_PROGRESS_BATCH }, (_, i) => item(md5(`book ${i}`), 0.1));
    expect((await batch(full)).status).toBe(200);
  });

  it('rolls back earlier items and feed cursors when a later database write fails', async () => {
    const { db, item, batch, rows } = await setup();
    db.exec(`CREATE TRIGGER reject_second_book BEFORE INSERT ON progress
      WHEN NEW.document = '${DOC2}' BEGIN SELECT RAISE(ABORT, 'test write failure'); END`);
    const res = await batch([item(DOC, 0.4, { metadata: { title: 'First' } }), item(DOC2, 0.5)]);
    expect(res.status).toBe(500);
    expect(rows()).toEqual([]);
    for (const table of ['progress_log', 'progress_samples', 'documents']) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 0 });
    }
    expect(db.prepare('SELECT value FROM change_seq').get()).toEqual({ value: 0 });
    db.exec('DROP TRIGGER reject_second_book');
    expect((await batch([item(DOC, 0.4)])).status).toBe(200);
    expect(rows()).toHaveLength(1);
  });

  it('requires authentication', async () => {
    const { item, batch } = await setup();
    expect((await batch([item(DOC, 0.4)], false)).status).toBe(401);
  });
});
