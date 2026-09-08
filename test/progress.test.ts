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
