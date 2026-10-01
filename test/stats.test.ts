import { describe, expect, it } from 'vitest';
import {
  combineGlobalStats,
  combineHistory,
  currentStreak,
  longestStreak,
  HISTORY_BYTES,
  type GlobalStatsSnapshot,
} from '../src/models/stats.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

function historyFromDays(setBits: number[]): string {
  const buf = Buffer.alloc(HISTORY_BYTES);
  for (const bit of setBits) {
    buf[bit >> 3] |= 1 << (bit & 7);
  }
  return buf.toString('base64');
}

function snapshot(overrides: Partial<GlobalStatsSnapshot> = {}): GlobalStatsSnapshot {
  return {
    v: 5,
    sessions: 10,
    seconds: 3600,
    pages: 200,
    completed: 1,
    tod: [100, 200, 300, 400],
    dow: [1, 2, 3, 4, 5, 6, 7],
    anchor_day: 9650,
    history_b64: historyFromDays([0, 1, 2]),
    streak: 3,
    ...overrides,
  };
}

describe('stats bitmap model', () => {
  it('combines histories with re-anchoring (older device shifts)', () => {
    // Device A anchored at day 9650, read on days 9650, 9649, 9648 (bits 0,1,2).
    // Device B anchored at day 9648, read on day 9648 (bit 0) and 9645 (bit 3).
    const combined = combineHistory([
      { anchor_day: 9650, history_b64: historyFromDays([0, 1, 2]) },
      { anchor_day: 9648, history_b64: historyFromDays([0, 3]) },
    ]);
    expect(combined.anchorDay).toBe(9650);
    // Day 9648 from B lands on bit 2 (already set); day 9645 lands on bit 5.
    expect(longestStreak(combined.history)).toBe(3);
    expect(currentStreak(combined.history)).toBe(3);
    expect((combined.history[0] >> 5) & 1).toBe(1);
  });

  it('current streak skips an unset anchor day (today not read yet)', () => {
    const { history } = combineHistory([
      { anchor_day: 9650, history_b64: historyFromDays([1, 2, 3]) },
    ]);
    expect(currentStreak(history)).toBe(3);
  });

  it('longest streak found mid-window', () => {
    const { history } = combineHistory([
      { anchor_day: 9650, history_b64: historyFromDays([0, 10, 11, 12, 13, 20]) },
    ]);
    expect(longestStreak(history)).toBe(4);
  });

  it('sums scalars and buckets; streak is max of computed and device-reported', () => {
    const sum = combineGlobalStats([
      snapshot(),
      snapshot({ sessions: 5, seconds: 100, streak: 21 }),
    ]);
    expect(sum.sessions).toBe(15);
    expect(sum.seconds).toBe(3700);
    expect(sum.tod).toEqual([200, 400, 600, 800]);
    expect(sum.dow).toEqual([2, 4, 6, 8, 10, 12, 14]);
    expect(sum.streak).toBe(21); // device-reported all-time streak wins
  });

  it('handles empty snapshot list', () => {
    const sum = combineGlobalStats([]);
    expect(sum.sessions).toBe(0);
    expect(sum.anchor_day).toBe(0);
    expect(sum.streak).toBe(0);
  });
});

describe('v1 stats endpoints', () => {
  const globalBody = (deviceId: string, extra: Partial<GlobalStatsSnapshot> = {}) => ({
    device_id: deviceId,
    device: 'CrossInk',
    ...snapshot(extra),
  });

  it('stores per-device global snapshots and aggregates in /stats/summary', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    for (const [id, extra] of [
      ['aaaa', {}],
      ['bbbb', { sessions: 90, streak: 21 }],
    ] as const) {
      const res = await app.request('/api/v1/stats/global', {
        method: 'PUT',
        headers,
        body: JSON.stringify(globalBody(id, extra)),
      });
      expect(res.status).toBe(200);
    }
    const summary = await (await app.request('/api/v1/stats/summary', { headers })).json();
    expect(summary.sessions).toBe(100);
    expect(summary.streak).toBe(21);
    expect(summary.devices).toHaveLength(2);
  });

  it('re-uploading a snapshot replaces it (never accumulates)', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    for (let i = 0; i < 3; i++) {
      await app.request('/api/v1/stats/global', {
        method: 'PUT',
        headers,
        body: JSON.stringify(globalBody('aaaa')),
      });
    }
    const summary = await (await app.request('/api/v1/stats/summary', { headers })).json();
    expect(summary.sessions).toBe(10);
  });

  it('per-book stats: batch PUT, per-device GET with combined totals', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const bookItem = (over: Record<string, unknown> = {}) => ({
      document: DOC,
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
      ...over,
    });
    for (const [deviceId, over] of [
      ['aaaa', {}],
      ['bbbb', { sessions: 1, seconds: 600, completed: true, avg_fwd: 20, pace_n: 50 }],
    ] as const) {
      const res = await app.request('/api/v1/stats/books', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ device_id: deviceId, items: [bookItem(over)] }),
      });
      expect(res.status).toBe(200);
    }
    const body = await (await app.request(`/api/v1/stats/books/${DOC}`, { headers })).json();
    expect(body.devices).toHaveLength(2);
    expect(body.combined.sessions).toBe(10);
    expect(body.combined.seconds).toBe(9000);
    expect(body.combined.completed).toBe(true);
    // Weighted pace: (12*250 + 20*50) / 300 = 13.33 -> 13
    expect(body.combined.avg_fwd).toBe(13);
  });

  it('rejects malformed snapshots', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const res = await app.request('/api/v1/stats/global', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ device_id: 'aaaa', sessions: 'lots' }),
    });
    expect(res.status).toBe(403);
  });
});


describe('daily reading counters', () => {
  const body = (device: string, daily?: unknown) => ({ device_id: device, ...snapshot(), ...(daily === undefined ? {} : { daily }) });
  it('keeps max per device/day across retries, old payloads, partial batches and reordered uploads', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const put = async (device: string, daily?: unknown) => {
      const r = await app.request('/api/v1/stats/global', { method: 'PUT', headers, body: JSON.stringify(body(device, daily)) });
      expect(r.status).toBe(200);
      return r.json();
    };
    expect((await put('A', [{ date: '2026-09-30', seconds: 61 }])).accepted_daily).toBe(1);
    await put('A', [{ date: '2026-09-30', seconds: 61 }]);
    await put('A', [{ date: '2026-10-01', seconds: 15 }]);
    await put('A', [{ date: '2026-09-30', seconds: 10 }]);
    await put('A');
    await put('B', [{ date: '2026-09-30', seconds: 29 }]);
    const sum = await (await app.request('/api/v1/stats/summary', { headers })).json();
    expect(sum.daily).toEqual([
      { date: '2026-09-30', seconds: 90, minutes: 1.5 },
      { date: '2026-10-01', seconds: 15, minutes: .25 },
    ]);
    expect(sum.seconds).toBe(7200); // legacy aggregates stay intact
    const devices = await (await app.request('/api/v1/stats/global', { headers })).json();
    expect(devices.devices.find((d: any) => d.device_id === 'A').stats.daily).toEqual([
      { date: '2026-09-30', seconds: 61 }, { date: '2026-10-01', seconds: 15 },
    ]);
    const secondUser = await registerUser(app);
    const other = await (await app.request('/api/v1/stats/summary', { headers: secondUser.headers })).json();
    expect(other.daily).toEqual([]);
  });
  it('rejects malformed/duplicate/oversized daily data atomically', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    for (const daily of [null, {}, [{ date: '2026-02-29', seconds: 1 }],
      [{ date: '1999-12-31', seconds: 1 }], [{ date: '2026-10-01', seconds: -1 }],
      [{ date: '2026-10-01', seconds: 1.5 }], [{ date: '2026-10-01', seconds: 4294967296 }],
      [{ date: '2026-10-01', seconds: '60' }], [null],
      [{ date: '2026-10-01', seconds: 1 }, { date: '2026-10-01', seconds: 2 }],
      Array.from({ length: 21 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, seconds: 1 })),
    ]) {
      const r = await app.request('/api/v1/stats/global', { method: 'PUT', headers, body: JSON.stringify(body('A', daily)) });
      expect(r.status).toBe(403);
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM stats_device_global').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM stats_device_day').get()).toEqual({ n: 0 });
  });
  it('accepts leap days, keeps local dates unchanged, and upgrades populated old databases', async () => {
    const { app, db } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request('/api/v1/stats/global', { method: 'PUT', headers, body: JSON.stringify(body('old')) });
    const before = db.prepare('SELECT payload FROM stats_device_global').get();
    db.exec('DROP TABLE stats_device_day');
    db.prepare('DELETE FROM migrations WHERE name = ?').run('0014_daily_reading.sql');
    const { migrate } = await import('../src/db/db.js');
    migrate(db);
    expect(db.prepare('SELECT payload FROM stats_device_global').get()).toEqual(before);
    const res = await app.request('/api/v1/stats/global', { method: 'PUT', headers,
      body: JSON.stringify(body('new', [{ date: '2028-02-29', seconds: 1 }])) });
    expect(res.status).toBe(200);
    const sum = await (await app.request('/api/v1/stats/summary?tz=840', { headers })).json();
    expect(sum.daily[0].date).toBe('2028-02-29');
  });
});

it('daily counters are independent of book merges and removed with account data', async () => {
 const {app,db}=makeTestApp(); const {headers,username}=await registerUser(app);
 await app.request('/api/v1/stats/global',{method:'PUT',headers,body:JSON.stringify({device_id:'A',...snapshot(),daily:[{date:'2026-10-01',seconds:61}]})});
 const before=db.prepare('SELECT * FROM stats_device_day').all();
 const id=(db.prepare('SELECT id FROM users WHERE username = ?').get(username) as {id:number}).id;
 const {mergeDocuments,unmergeDocument}=await import('../src/models/merge.js');
 mergeDocuments(db,id,'a'.repeat(32),'b'.repeat(32),1234,true);
 expect(db.prepare('SELECT * FROM stats_device_day').all()).toEqual(before);
 unmergeDocument(db,id,'a'.repeat(32));
 expect(db.prepare('SELECT * FROM stats_device_day').all()).toEqual(before);
 const {deleteKosyncUserData}=await import('../src/routes/account.js');
 deleteKosyncUserData(db,id,username,{keepUser:true});
 expect(db.prepare('SELECT * FROM stats_device_day').all()).toEqual([]);
});
