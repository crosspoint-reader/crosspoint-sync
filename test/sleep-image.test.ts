import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTestApp, registerUser, DOC } from './helpers.js';
import { parseSleepOptions, sleepMetrics, timezoneOffset } from '../src/models/sleep-image.js';

afterEach(() => vi.useRealTimers());

describe('sleep image data', () => {
  it('uses the account goal and canonical completion dates without writing progress', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T02:00:00Z'));
    const s = makeTestApp();
    try {
      const u = await registerUser(s.app);
      const id = Number(s.db.prepare('SELECT id FROM users WHERE username=?').get(u.username)!.id);
      s.db.prepare('INSERT INTO progress_log (user_id,document,device_id,percentage,at) VALUES (?,?,?,1,?)')
        .run(id, DOC, 'reader', Date.parse('2027-01-01T01:00:00Z') / 1000);
      const before = s.db.prepare('SELECT COUNT(*) AS n FROM progress_log').get()!.n;
      expect(sleepMetrics(s.db, id, 'America/New_York', '42')).toMatchObject({ year: 2026, finished: 1, target: null, currentPercent: 42, streak: 1 });
      s.db.prepare('INSERT INTO reading_goals (user_id,year,target) VALUES (?,?,?)').run(id, 2026, 1);
      expect(sleepMetrics(s.db, id, 'America/New_York', '100')).toMatchObject({ year: 2026, finished: 1, target: 1, currentPercent: 100 });
      expect(sleepMetrics(s.db, id, 'UTC', undefined)).toMatchObject({ year: 2027, finished: 1, target: null, currentPercent: null });
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM progress_log').get()!.n).toBe(before);
    } finally { s.db.close(); }
  });

  it.each([undefined, '', '{event.percent}', '-1', '101', 'NaN', 'Infinity', '4x'])('omits unavailable percentage %s', async value => {
    const s = makeTestApp();
    try {
      const u = await registerUser(s.app);
      const id = Number(s.db.prepare('SELECT id FROM users WHERE username=?').get(u.username)!.id);
      expect(sleepMetrics(s.db, id, 'UTC', value).currentPercent).toBeNull();
    } finally { s.db.close(); }
  });

  it('uses seasonal timezone offsets and rejects invalid zones', () => {
    expect(timezoneOffset('America/New_York', new Date('2026-07-01T12:00Z'))).toBe(240);
    expect(timezoneOffset('America/New_York', new Date('2026-12-01T12:00Z'))).toBe(300);
    expect(() => timezoneOffset('Imaginary/Place')).toThrow(/timezone/i);
  });

  it('bounds output and accepts all supported metric selections', () => {
    expect(parseSleepOptions({ width: '1200', height: '1600', mode: 'custom', metrics: 'books,goal,current,streak', placement: 'top', timezone: 'UTC' }))
      .toMatchObject({ width: 1200, height: 1600, mode: 'custom', placement: 'top' });
    for (const query of [{ width: '239' }, { width: '1601' }, { width: '1600', height: '1600' }, { height: 'NaN' }, { mode: 'cover' }, { metrics: 'secrets' }, { placement: 'middle' }, { timezone: 'bad' }]) {
      expect(() => parseSleepOptions(query)).toThrow();
    }
    expect(() => parseSleepOptions({ metrics: '' })).toThrow();
  });
});
