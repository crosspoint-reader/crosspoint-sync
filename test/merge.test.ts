import { describe, expect, it } from 'vitest';
import { makeTestApp, registerUser } from './helpers.js';

const KOBO_DOC = '27593cefaf3a602cf410ecf5da4652e2';
const CP_DOC = '76166bb603f5121c19c308c64a8d5c73';

async function putProgress(
  app: Awaited<ReturnType<typeof makeTestApp>>['app'],
  headers: Record<string, string>,
  body: Record<string, unknown>
) {
  return app.request('/syncs/progress', { method: 'PUT', headers, body: JSON.stringify(body) });
}

function bookStats(document: string, seconds: number, pages: number) {
  return {
    document,
    v: 5,
    sessions: 2,
    seconds,
    pages,
    completed: false,
    avg_fwd: 10,
    pace_n: 5,
    eta: 0,
    start_manual: false,
    finish_manual: false,
    start_date: 1751000000,
    finished_date: 0,
    tod: [0, 0, 0, 0],
    dow: [0, 0, 0, 0, 0, 0, 0],
  };
}

/** Two devices with stats under different hashes, plus a same-device clash. */
async function statsSetup(stats?: boolean) {
  const { app, db } = makeTestApp();
  const { headers } = await registerUser(app);
  await putProgress(app, headers, { document: KOBO_DOC, progress: 'a', percentage: 0.1, device_id: 'kobo-1' });
  await putProgress(app, headers, { document: CP_DOC, progress: 'b', percentage: 0.2, device_id: 'cp-1' });
  const upload = (deviceId: string, items: unknown[]) =>
    app.request('/api/v1/stats/books', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: deviceId, items }),
    });
  await upload('cp-1', [bookStats(CP_DOC, 600, 30), bookStats(KOBO_DOC, 300, 15)]);
  await upload('kobo-1', [bookStats(KOBO_DOC, 900, 45)]);
  const merge = await app.request('/api/v1/documents/merge', {
    method: 'POST',
    headers,
    body: JSON.stringify({ document: KOBO_DOC, into: CP_DOC, ...(stats === undefined ? {} : { stats }) }),
  });
  expect(merge.status).toBe(200);
  const combined = async (doc = CP_DOC) => {
    const res = await app.request(`/api/v1/stats/books/${doc}`, { headers });
    return ((await res.json()) as { combined: { seconds: number; pages: number; sessions: number } }).combined;
  };
  return { app, db, headers, upload, combined };
}

async function setup() {
  const { app, db } = makeTestApp();
  const { headers } = await registerUser(app);
  // Same book, hashed differently by two devices; only CrossPoint sends metadata.
  await putProgress(app, headers, {
    document: KOBO_DOC,
    progress: '/body/DocFragment[5]/body/p[1]/text().0',
    percentage: 0.1,
    device: 'Kobo',
    device_id: 'kobo-1',
  });
  await putProgress(app, headers, {
    document: CP_DOC,
    progress: '/body/DocFragment[7]/body/p[8]/text().4',
    percentage: 0.2,
    device: 'CrossPoint',
    device_id: 'cp-1',
    metadata: { title: 'The Water Outlaws', authors: 'S. L. Huang', filename: 'The Water Outlaws - S. L. Huang.epub' },
  });
  const merge = await app.request('/api/v1/documents/merge', {
    method: 'POST',
    headers,
    body: JSON.stringify({ document: KOBO_DOC, into: CP_DOC }),
  });
  expect(merge.status).toBe(200);
  return { app, db, headers };
}

describe('document merge', () => {
  it('migrates progress and lists one book with the alias', async () => {
    const { app, headers } = await setup();
    const list = await app.request('/api/v1/progress?limit=500', { headers });
    const { items } = (await list.json()) as { items: Record<string, unknown>[] };
    expect(items).toHaveLength(1);
    expect(items[0].document).toBe(CP_DOC);
    expect(items[0].title).toBe('The Water Outlaws');
    expect(items[0].aliases).toEqual([KOBO_DOC]);
  });

  it('serves the merged progress when asked for the alias hash', async () => {
    const { app, headers } = await setup();
    const res = await app.request(`/syncs/progress/${KOBO_DOC}`, { headers });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.document).toBe(KOBO_DOC); // echoes what the client asked for
    expect(body.percentage).toBe(0.2); // CrossPoint's newer progress
  });

  it('serves the highest progress even when the other copy is newer', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    await putProgress(app, headers, { document: KOBO_DOC, progress: 'a', percentage: 0.8, device: 'Kobo', device_id: 'kobo-1' });
    await putProgress(app, headers, { document: CP_DOC, progress: 'b', percentage: 0.1, device: 'Kobo', device_id: 'kobo-1' });
    await putProgress(app, headers, { document: CP_DOC, progress: 'c', percentage: 0.3, device: 'CrossPoint', device_id: 'cp-1' });
    db.prepare('UPDATE progress SET updated_at = updated_at - 100 WHERE document = ?').run(KOBO_DOC);
    await app.request('/api/v1/documents/merge', {
      method: 'POST',
      headers,
      body: JSON.stringify({ document: KOBO_DOC, into: CP_DOC }),
    });
    const res = await app.request(`/syncs/progress/${CP_DOC}`, { headers });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.percentage).toBe(0.8);
    expect(body.progress).toBe('a');
  });

  it('stores pushes to the alias hash under the canonical document', async () => {
    const { app, headers } = await setup();
    await putProgress(app, headers, {
      document: KOBO_DOC,
      progress: '/body/DocFragment[9]/body/p[2]/text().0',
      percentage: 0.5,
      device: 'Kobo',
      device_id: 'kobo-1',
    });
    const res = await app.request(`/api/v1/progress/${CP_DOC}`, { headers });
    const body = (await res.json()) as { devices: { device_id: string; percentage: number }[] };
    const kobo = body.devices.find((d) => d.device_id === 'kobo-1');
    expect(kobo?.percentage).toBe(0.5);
  });

  it('keeps one row per device when both hashes had progress', async () => {
    const { db, headers, app } = await setup();
    void headers;
    void app;
    const rows = db
      .prepare('SELECT document, device_id FROM progress ORDER BY device_id')
      .all() as unknown as { document: string; device_id: string }[];
    expect(rows).toEqual([
      { document: CP_DOC, device_id: 'cp-1' },
      { document: CP_DOC, device_id: 'kobo-1' },
    ]);
  });

  it('rejects merging a document into itself (directly or via alias)', async () => {
    const { app, headers } = await setup();
    const res = await app.request('/api/v1/documents/merge', {
      method: 'POST',
      headers,
      body: JSON.stringify({ document: KOBO_DOC, into: CP_DOC }),
    });
    expect(res.status).toBe(403); // KOBO_DOC already resolves to CP_DOC
  });

  it('unmerge stops resolution but keeps migrated rows', async () => {
    const { app, headers } = await setup();
    const un = await app.request(`/api/v1/documents/merge/${KOBO_DOC}`, {
      method: 'DELETE',
      headers,
    });
    expect(un.status).toBe(200);
    // The alias hash is its own (empty) document again.
    const res = await app.request(`/syncs/progress/${KOBO_DOC}`, { headers });
    expect(await res.json()).toEqual({});
    // Canonical still has both devices' rows.
    const canon = await app.request(`/api/v1/progress/${CP_DOC}`, { headers });
    const body = (await canon.json()) as { devices: unknown[] };
    expect(body.devices).toHaveLength(2);
  });

  it('deleting the canonical book clears the alias mapping too', async () => {
    const { app, db, headers } = await setup();
    const del = await app.request(`/api/v1/progress/${CP_DOC}`, { method: 'DELETE', headers });
    expect(del.status).toBe(200);
    const aliases = db.prepare('SELECT * FROM document_aliases').all();
    expect(aliases).toHaveLength(0);
  });
});

describe('document merge stats', () => {
  it('combines stats from both hashes by default, including same-device clashes', async () => {
    const { combined } = await statsSetup();
    expect(await combined()).toMatchObject({ seconds: 1800, pages: 90, sessions: 6 });
    // Asking with the alias hash gives the same book.
    expect((await combined(KOBO_DOC)).seconds).toBe(1800);
  });

  it('keeps counting uploads that devices still send under the alias hash', async () => {
    const { upload, combined } = await statsSetup();
    await upload('kobo-1', [bookStats(KOBO_DOC, 1200, 60)]);
    expect((await combined()).seconds).toBe(2100);
  });

  it('leaves stats apart when merged with stats: false', async () => {
    const { combined } = await statsSetup(false);
    expect(await combined()).toMatchObject({ seconds: 600, pages: 30, sessions: 2 });
  });

  it('unmerge hands the alias its stats back', async () => {
    const { app, headers, combined } = await statsSetup();
    await app.request(`/api/v1/documents/merge/${KOBO_DOC}`, { method: 'DELETE', headers });
    expect((await combined()).seconds).toBe(600);
    expect((await combined(KOBO_DOC)).seconds).toBe(1200);
  });

  it('deleting the canonical book clears stats stored under its aliases', async () => {
    const { app, db, headers } = await statsSetup();
    await app.request(`/api/v1/progress/${CP_DOC}`, { method: 'DELETE', headers });
    expect(db.prepare('SELECT * FROM stats_device_book').all()).toHaveLength(0);
  });
});
