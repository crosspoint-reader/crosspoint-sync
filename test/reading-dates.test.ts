import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { parseCalendarDate } from '../src/routes/v1/documents.js';

const day = (s: string) => Date.parse(`${s}T00:00:00Z`) / 1000;

describe('parseCalendarDate', () => {
  it('takes real YYYY-MM-DD dates up to tomorrow, null clears', () => {
    expect(parseCalendarDate('2026-08-11')).toBe(day('2026-08-11'));
    expect(parseCalendarDate(null)).toBeNull();
    for (const bad of ['2026-02-30', '2026-8-11', '08/11/2026', 1786406400, '2999-01-01', undefined]) {
      expect(parseCalendarDate(bad)).toBeUndefined();
    }
  });
});

describe('PUT /api/v1/documents/:document/dates', () => {
  async function setup() {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: 'p', percentage: 0.4, device_id: 'd1' }),
    });
    const dates = (body: unknown) =>
      app.request(`/api/v1/documents/${DOC}/dates`, { method: 'PUT', headers, body: JSON.stringify(body) });
    const activity = async () =>
      (await (await app.request('/api/v1/stats/activity?tz=240', { headers })).json()).books[0];
    const status = async () => (await (await app.request('/api/v1/progress', { headers })).json()).items[0].status;
    const grid = async () =>
      (await (await app.request('/api/v1/stats/activity?tz=240', { headers })).json()).reading_days;
    return { dates, activity, status, grid, app, headers };
  }

  it('sets manual dates that win in activity, and a finish date marks the book finished', async () => {
    const { dates, activity, status } = await setup();
    const res = await dates({ start_date: '2026-08-11', finished_date: '2026-08-16' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ start_date: day('2026-08-11'), finished_date: day('2026-08-16'), status: 'finished' });
    expect(await status()).toBe('finished');
    // Local noon in New York on each day.
    expect(await activity()).toMatchObject({
      started_at: day('2026-08-11') + 16 * 3600,
      finished_at: day('2026-08-16') + 16 * 3600,
      days_to_finish: 6,
      start_manual: true,
      finish_manual: true,
    });
  });

  it('leaves omitted fields alone and clears with null', async () => {
    const { dates, activity } = await setup();
    await dates({ start_date: '2026-08-11', finished_date: '2026-08-16' });
    await dates({ finished_date: null });
    expect(await activity()).toMatchObject({ start_manual: true, finish_manual: false, started_at: day('2026-08-11') + 16 * 3600 });
  });

  it('recalculates the grid after edits and clearing, without filling a date range', async () => {
    const { dates, grid, app, headers } = await setup();
    const syncedDays = await grid();
    const device = {
      document: DOC, v: 5, sessions: 1, seconds: 60, pages: 10, completed: true,
      avg_fwd: 0, pace_n: 0, eta: 0, start_manual: false, finish_manual: false,
      start_date: day('2026-08-01'), finished_date: day('2026-08-05'),
      tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0],
    };
    expect((await app.request('/api/v1/stats/books', {
      method: 'PUT', headers, body: JSON.stringify({ device_id: 'd1', items: [device] }),
    })).status).toBe(200);
    expect(await grid()).toEqual(['2026-08-01', '2026-08-05', ...syncedDays]);
    await dates({ start_date: '2026-08-11', finished_date: '2026-08-16' });
    expect(await grid()).toEqual(['2026-08-11', '2026-08-16', ...syncedDays]);
    await dates({ finished_date: '2026-08-18' });
    expect(await grid()).toEqual(['2026-08-11', '2026-08-18', ...syncedDays]);
    await dates({ start_date: null, finished_date: null });
    expect(await grid()).toEqual(['2026-08-01', '2026-08-05', ...syncedDays]);
  });

  it('rejects bad dates and a start after the finish', async () => {
    const { dates } = await setup();
    expect((await dates({ start_date: '2026-02-30' })).status).toBe(403);
    expect((await dates({ start_date: '2026-08-20', finished_date: '2026-08-16' })).status).toBe(400);
    await dates({ finished_date: '2026-08-16' });
    expect((await dates({ start_date: '2026-08-20' })).status).toBe(400);
  });
});
