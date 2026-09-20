import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';

const POSITION = {
  pctQ: 486700,
  spine: 7,
  page: 143,
  pages: 412,
  para: 96,
  anchor: 'ch08-sec2',
  xpath: '/body/DocFragment[8]/body/div[2]/p[4]/text()[1].96',
};

describe('v1 rich progress', () => {
  it('PUT /api/v1/progress stores position; GET returns per-device rows', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const put = await app.request('/api/v1/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        document: DOC,
        progress: POSITION.xpath,
        percentage: 0.4867,
        device: 'CrossPoint',
        device_id: 'aaaa',
        position: POSITION,
      }),
    });
    expect(put.status).toBe(200);
    const res = await app.request(`/api/v1/progress/${DOC}`, { headers });
    const body = await res.json();
    expect(body.document).toBe(DOC);
    expect(body.devices).toHaveLength(1);
    expect(body.devices[0].position).toEqual(POSITION);
    expect(body.devices[0].device_id).toBe('aaaa');
  });

  it('kosync PUT opportunistically captures a position superset body', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        document: DOC,
        progress: POSITION.xpath,
        percentage: 0.4867,
        device: 'CrossPoint',
        device_id: 'aaaa',
        position: POSITION,
      }),
    });
    const body = await (await app.request(`/api/v1/progress/${DOC}`, { headers })).json();
    expect(body.devices[0].position).toEqual(POSITION);
  });

  it('a plain kosync PUT (no position) keeps the previously stored position', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request('/api/v1/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        document: DOC,
        progress: 'x',
        percentage: 0.3,
        device_id: 'aaaa',
        position: POSITION,
      }),
    });
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: 'y', percentage: 0.4, device_id: 'aaaa' }),
    });
    const body = await (await app.request(`/api/v1/progress/${DOC}`, { headers })).json();
    expect(body.devices[0].progress).toBe('y');
    expect(body.devices[0].position).toEqual(POSITION);
  });

  it('invalid position objects are ignored, not fatal', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await app.request('/api/v1/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        document: DOC,
        progress: 'x',
        percentage: 0.3,
        device_id: 'aaaa',
        position: { pctQ: 'nope' },
      }),
    });
    expect(res.status).toBe(200);
    const body = await (await app.request(`/api/v1/progress/${DOC}`, { headers })).json();
    expect(body.devices[0].position).toBeNull();
  });

  it('returns devices newest-first', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    for (const [deviceId, pct] of [
      ['aaaa', 0.2],
      ['bbbb', 0.5],
    ] as const) {
      await app.request('/api/v1/progress', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ document: DOC, progress: 'p', percentage: pct, device_id: deviceId }),
      });
    }
    db.prepare('UPDATE progress SET updated_at = updated_at - 100 WHERE device_id = ?').run('aaaa');
    const body = await (await app.request(`/api/v1/progress/${DOC}`, { headers })).json();
    expect(body.devices.map((d: { device_id: string }) => d.device_id)).toEqual(['bbbb', 'aaaa']);
  });

  it('list endpoint breaks same-second timestamp ties deterministically by device_id', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    // Two devices write within the same second; second-granularity timestamps
    // collide, and the list endpoint must pick the same row every time (lowest
    // device_id, matching the per-document endpoints), not an arbitrary one.
    for (const [deviceId, pct, prog] of [
      ['bbbb', 0.01, 'chapter-start'],
      ['aaaa', 0.99, 'chapter-end'],
    ] as const) {
      await app.request('/api/v1/progress', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ document: DOC, progress: prog, percentage: pct, device_id: deviceId }),
      });
    }
    db.prepare('UPDATE progress SET updated_at = 1000').run();
    for (let i = 0; i < 5; i++) {
      const body = await (await app.request('/api/v1/progress', { headers })).json();
      expect(body.items).toHaveLength(1);
      expect(body.items[0].device_id).toBe('aaaa');
      expect(body.items[0].progress).toBe('chapter-end');
    }
  });
});

describe('removing a synced book', () => {
  const OTHER_DOC = 'ffeeddccbbaa99887766554433221100';

  const BOOK_STATS = {
    v: 5,
    sessions: 9,
    seconds: 8400,
    pages: 310,
    completed: false,
    avg_fwd: 12,
    pace_n: 250,
    eta: 5400,
    start_manual: false,
    finish_manual: false,
    start_date: 1751000000,
    finished_date: 0,
    tod: [0, 3000, 4000, 1400],
    dow: [0, 0, 1200, 0, 2000, 3000, 2200],
  };

  /**
   * Seeds one document the way a device would: kosync progress (which also
   * records a position sample), metadata, a bookmark, a clipping and per-book
   * reading stats - i.e. a row in every table a removal has to clear.
   */
  async function seedBook(
    { app, db }: ReturnType<typeof makeTestApp>,
    headers: Record<string, string>,
    document: string
  ) {
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        document,
        progress: POSITION.xpath,
        percentage: 0.4867,
        device: 'CrossPoint',
        device_id: 'aaaa',
        position: POSITION,
      }),
    });
    await app.request('/api/v1/documents', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [{ document, title: 'Foundryside', author: 'RJB' }] }),
    });
    await app.request(`/api/v1/bookmarks/${document}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        items: [{ id: '0123456789abcdef', xpath: '/body/p[1]', percentage: 0.1, summary: 'note' }],
      }),
    });
    await app.request(`/api/v1/clippings/${document}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [{ id: 'fedcba9876543210', spine: 3, text: 'a highlight' }] }),
    });
    await app.request('/api/v1/stats/books', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: 'aaaa', items: [{ document, ...BOOK_STATS }] }),
    });
    // Connector rows have no test-friendly HTTP path (linking needs a live
    // service), so seed the two document-keyed tables directly.
    const userId = (db.prepare('SELECT id FROM users WHERE username = ?').get(headers['x-auth-user']) as { id: number }).id;
    db.prepare(
      `INSERT INTO connector_matches (user_id, connector_id, document, external_id, confidence, source, updated_at)
       VALUES (?, 'hardcover', ?, '42', 1, 'auto', 1)`
    ).run(userId, document);
    db.prepare(
      `INSERT INTO connector_queue (user_id, connector_id, document, kind, payload, next_try_at, created_at, updated_at)
       VALUES (?, 'hardcover', ?, 'progress', '{}', 0, 1, 1)`
    ).run(userId, document);
  }

  it('DELETE clears the kosync progress and the rest of that book, leaving others alone', async () => {
    const server = makeTestApp();
    const { app, db } = server;
    const { headers } = await registerUser(app);
    await seedBook(server, headers, DOC);
    await seedBook(server, headers, OTHER_DOC);

    const res = await app.request(`/api/v1/progress/${DOC}`, { method: 'DELETE', headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ document: DOC, deleted: true });
    expect(body.rows).toBeGreaterThan(0);

    // The book is gone from the dashboard list and from kosync itself.
    const list = await (await app.request('/api/v1/progress', { headers })).json();
    expect(list.items.map((i: { document: string }) => i.document)).toEqual([OTHER_DOC]);
    const kosync = await app.request(`/syncs/progress/${DOC}`, { headers });
    expect(kosync.status).toBe(200);
    expect(await kosync.json()).toEqual({});
    const devices = await (await app.request(`/api/v1/progress/${DOC}`, { headers })).json();
    expect(devices.devices).toEqual([]);

    // ...along with its metadata, highlights, bookmarks, samples and stats.
    for (const table of [
      'documents',
      'bookmarks',
      'clippings',
      'progress',
      'progress_samples',
      'stats_device_book',
      'connector_matches',
      'connector_queue',
    ]) {
      const left = db
        .prepare(`SELECT document FROM ${table} WHERE document = ?`)
        .all(DOC) as unknown[];
      expect(left, `${table} still has rows for the removed book`).toEqual([]);
      const kept = db
        .prepare(`SELECT document FROM ${table} WHERE document = ?`)
        .all(OTHER_DOC) as unknown[];
      expect(kept.length, `${table} lost rows for the other book`).toBeGreaterThan(0);
    }

    // The other book still reads back intact.
    const other = await (await app.request(`/syncs/progress/${OTHER_DOC}`, { headers })).json();
    expect(other.document).toBe(OTHER_DOC);
  });

  it('DELETE only touches the caller, and 404s on a document with no data', async () => {
    const server = makeTestApp();
    const { app } = server;
    const a = await registerUser(app);
    const b = await registerUser(app);
    await seedBook(server, a.headers, DOC);
    await seedBook(server, b.headers, DOC);

    // Same document hash, different user: B's copy must survive A's removal.
    expect((await app.request(`/api/v1/progress/${DOC}`, { method: 'DELETE', headers: a.headers })).status).toBe(200);
    const bList = await (await app.request('/api/v1/progress', { headers: b.headers })).json();
    expect(bList.items).toHaveLength(1);

    // Already removed for A - nothing left to delete.
    const again = await app.request(`/api/v1/progress/${DOC}`, { method: 'DELETE', headers: a.headers });
    expect(again.status).toBe(404);
    expect((await again.json()).message).toBe('Unknown document');
  });

  it('DELETE rejects a malformed document id', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await app.request('/api/v1/progress/not%20a%20hash!', { method: 'DELETE', headers });
    expect(res.status).toBe(403);
  });
});
