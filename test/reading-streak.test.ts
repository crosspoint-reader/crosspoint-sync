import { afterEach, describe, expect, it, vi } from 'vitest';
import { combineReadingStreak } from '../src/models/reading-streak.js';
import { HISTORY_BYTES, HISTORY_DAYS } from '../src/models/stats.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

const epoch = Date.UTC(2000, 0, 1);
const day = (date: string) => (Date.parse(`${date}T00:00:00Z`) - epoch) / 86400000;
const bitmap = (bits: number[]) => {
  const bytes = Buffer.alloc(HISTORY_BYTES);
  for (const bit of bits) bytes[bit >> 3] |= 1 << (bit & 7);
  return bytes.toString('base64');
};
const now = Date.parse('2026-10-30T12:00:00Z');
const snapshot = (anchor: string, bits: number[]) => ({
  v: 5, sessions: 1, seconds: 60, pages: 2, completed: 0,
  tod: [60, 0, 0, 0], dow: [60, 0, 0, 0, 0, 0, 0],
  anchor_day: day(anchor), history_b64: bitmap(bits), streak: 99,
});

afterEach(() => vi.useRealTimers());

describe('combined streak download', () => {
  it('fills gaps using other devices and calendar days, deduplicating overlaps', () => {
    const result = combineReadingStreak([
      snapshot('2026-10-30', [0, 2]), snapshot('2026-10-29', [0, 2]),
    ], ['2026-10-26', '2026-10-29', '2026-10-26'], 0, now);
    expect(result).toMatchObject({ v: 1, anchor_day: day('2026-10-30'), streak: 5, current_streak: 5 });
    expect(Buffer.from(result.history_b64, 'base64')[0]).toBe(31);
  });

  it('expires stale current streaks and allows today to remain unread', () => {
    expect(combineReadingStreak([snapshot('2026-10-20', [0, 1])], [], 0, now))
      .toMatchObject({ streak: 2, current_streak: 0 });
    expect(combineReadingStreak([], ['2026-10-28', '2026-10-29'], 0, now))
      .toMatchObject({ streak: 2, current_streak: 2 });
  });

  it('uses local today, ignores future dates and preserves real gaps across DST/year boundaries', () => {
    const midnight = Date.parse('2027-01-01T01:00:00Z');
    const days = ['2026-12-30', '2026-12-31', '2027-01-01'];
    expect(combineReadingStreak([], days, 300, midnight)).toMatchObject({ streak: 2, anchor_day: day('2026-12-31') });
    expect(combineReadingStreak([], days, -540, midnight)).toMatchObject({ streak: 3, anchor_day: day('2027-01-01') });
    expect(combineReadingStreak([snapshot('2026-11-03', [0, 2, 3])], [], 240,
      Date.parse('2026-11-03T16:00:00Z'))).toMatchObject({ streak: 2, current_streak: 1 });
    expect(combineReadingStreak([snapshot('2026-11-01', [0, 1, 2])], ['2026-11-01'], 0, now))
      .toMatchObject({ streak: 1, current_streak: 1 });
  });

  it('keeps the payload bounded while computing longest runs outside the bitmap window', () => {
    const dates = ['2020-01-01', '2020-01-02', '2020-01-03'];
    const result = combineReadingStreak([], dates, 0, now);
    expect(result).toMatchObject({ streak: 3, current_streak: 0 });
    expect(Buffer.from(result.history_b64, 'base64')).toEqual(Buffer.alloc(HISTORY_BYTES));
    expect(JSON.stringify(result).length).toBeLessThan(256);
    const edge = combineReadingStreak([snapshot('2026-10-30', [729, 730, 735])], [], 0, now);
    expect(edge.streak).toBe(1);
    expect(Buffer.from(edge.history_b64, 'base64')[91]).toBe(2);
    expect(HISTORY_DAYS).toBe(730);
  });

  it('authenticates and isolates users; reads device snapshots, daily time and the shared calendar', async () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const { app, db } = makeTestApp();
    const { headers, username } = await registerUser(app);
    const id = db.prepare('SELECT id FROM users WHERE username = ?').get(username)!.id;
    for (const [device_id, stats] of [['A', snapshot('2026-10-30', [0])], ['B', snapshot('2026-10-28', [0])]] as const) {
      expect((await app.request('/api/v1/stats/global', { method: 'PUT', headers,
        body: JSON.stringify({ device_id, ...stats, daily: [{ date: '2026-10-29', seconds: 60 }] }),
      })).status).toBe(200);
    }
    // Progress and manually chosen dates follow the exact same source as the web grid.
    db.prepare('INSERT INTO documents (user_id, document, start_date, updated_at) VALUES (?, ?, ?, ?)')
      .run(id, DOC, Date.parse('2026-10-26T00:00:00Z') / 1000, now / 1000);
    db.prepare('INSERT INTO progress_log (user_id, document, percentage, at, device_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, DOC, .1, Date.parse('2026-10-27T12:00:00Z') / 1000, 'C');
    const get = () => app.request('/api/v1/stats/streak?tz=240', { headers });
    expect(await (await get()).json()).toMatchObject({ streak: 5, current_streak: 5 });
    expect(await (await get()).json()).toEqual(await (await get()).json());
    // Editing a date replaces cached history on the next download, without filling a range.
    db.prepare('UPDATE documents SET start_date = NULL WHERE user_id = ?').run(id);
    expect(await (await get()).json()).toMatchObject({ streak: 4, current_streak: 4 });
    const other = await registerUser(app);
    expect(await (await app.request('/api/v1/stats/streak', { headers: other.headers })).json())
      .toMatchObject({ streak: 0, current_streak: 0 });
    expect((await app.request('/api/v1/stats/streak')).status).toBe(401);
    for (const tz of ['oops', '841', '-841', '1.5']) {
      expect((await app.request(`/api/v1/stats/streak?tz=${tz}`, { headers })).status).toBe(403);
    }
    db.close();
  });
});
