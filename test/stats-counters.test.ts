import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { exportAccountData, importAccountData } from '../src/models/account-data.js';
import { deleteDocumentData } from '../src/models/document.js';
import { migrate } from '../src/db/db.js';
import { LEGACY_COUNTER_ID } from '../src/models/stats.js';

const A = 'a'.repeat(32), B = 'b'.repeat(32);
const global = (seconds = 3600, extra: Record<string, unknown> = {}) => ({
  device_id: 'reader', device: 'CrossInk', v: 5, sessions: seconds ? 10 : 0, seconds,
  pages: seconds ? 200 : 0, completed: seconds ? 1 : 0,
  tod: [seconds, 0, 0, 0], dow: [seconds, 0, 0, 0, 0, 0, 0],
  anchor_day: 9800, history_b64: Buffer.from([7]).toString('base64'), streak: 3, ...extra,
});
const book = (seconds = 3600, extra: Record<string, unknown> = {}) => ({
  document: DOC, v: 5, sessions: seconds ? 10 : 0, seconds, pages: seconds ? 200 : 0,
  completed: !!seconds, avg_fwd: 12, pace_n: 10, eta: 0, start_manual: false, finish_manual: false,
  start_date: seconds ? 1609502400 : 0, finished_date: seconds ? 1609506000 : 0,
  tod: [seconds, 0, 0, 0], dow: [seconds, 0, 0, 0, 0, 0, 0], ...extra,
});
async function fixture() {
  const server = makeTestApp();
  const user = await registerUser(server.app);
  const id = server.db.prepare('SELECT id FROM users WHERE username = ?').get(user.username)!.id as number;
  const put = (path: string, body: unknown) => server.app.request(`/api/v1/stats/${path}`, {
    method: 'PUT', headers: user.headers, body: JSON.stringify(body),
  });
  const get = async (path: string) => (await server.app.request(`/api/v1/stats/${path}`, { headers: user.headers })).json();
  return { ...server, ...user, id, put, get };
}

describe('reset-aware reading stats (#80)', () => {
  it('preserves a legacy baseline, adds fresh reading, and keeps retries/restored cards idempotent', async () => {
    const f = await fixture();
    const submit = async (counter: unknown) => expect((await f.put('counters/global', counter)).status).toBe(200);
    await submit(global()); // existing firmware, implicit legacy lifetime
    await submit(global(3600, { counter_id: LEGACY_COUNTER_ID })); // upgrade existing card
    expect((await f.get('summary')).seconds).toBe(3600);
    await submit(global(0, { counter_id: A, history_b64: '', streak: 0 })); // reset
    expect((await f.get('summary')).seconds).toBe(3600);
    for (let i = 0; i < 3; i++) await submit(global(60, { counter_id: A, sessions: 1, pages: 2, completed: 0 }));
    expect(await f.get('summary')).toMatchObject({ seconds: 3660, sessions: 11, pages: 202, completed: 1, streak: 3 });
    await submit(global(0, { counter_id: A })); // stale same-lifetime retry
    await submit(global(3600)); // old card restored
    expect((await f.get('summary')).seconds).toBe(3660);
    await submit(global(30, { counter_id: B, sessions: 1, pages: 1, completed: 0 })); // second reset
    expect((await f.get('summary')).seconds).toBe(3690);
    const devices = await f.get('global');
    expect(devices.devices).toHaveLength(1); // response remains one row per physical reader
    expect(devices.devices[0].device_id).toBe('reader');
    expect(devices.devices[0].stats.seconds).toBe(3690);
    await f.put('counters/global', global(120, { device_id: 'other-reader', counter_id: A }));
    expect((await f.get('summary')).seconds).toBe(3810);
    const otherUser = await registerUser(f.app);
    expect((await (await f.app.request('/api/v1/stats/summary', { headers: otherUser.headers })).json()).seconds).toBe(0);
  });

  it('protects legacy uploads and merges same-lifetime bitmap history at its correct anchor', async () => {
    const f = await fixture();
    await f.put('global', global());
    await f.put('global', global(0, { anchor_day: 9802, history_b64: Buffer.from([1]).toString('base64'), streak: 1 }));
    const s = await f.get('summary');
    expect(s).toMatchObject({ seconds: 3600, sessions: 10, pages: 200, completed: 1, anchor_day: 9802, streak: 3 });
    expect(Buffer.from(s.history_b64, 'base64')[0]).toBe(0b11101);
    expect(s.tod).toEqual([3600, 0, 0, 0]);
  });

  it('keeps book history across resets while allowing current completion and date edits', async () => {
    const f = await fixture();
    const put = (item: unknown) => f.put('counters/books', { device_id: 'reader', items: [item] });
    await put(book());
    await put(book(0)); // legacy reset must preserve old metadata
    expect((await f.get(`books/${DOC}`)).combined).toMatchObject({ seconds: 3600, completed: true, finished_date: 1609506000 });
    await put(book(3600, { counter_id: LEGACY_COUNTER_ID, completed: false, finished_date: 0, start_manual: true, start_date: 1609602400 }));
    expect((await f.get(`books/${DOC}`)).combined).toMatchObject({ seconds: 3600, completed: false, start_date: 1609602400, finished_date: 0 });
    await put(book(60, { counter_id: A, sessions: 1, pages: 2, completed: false, finished_date: 0 }));
    await put(book(60, { counter_id: A, sessions: 1, pages: 2, completed: false, finished_date: 0 }));
    const all = await f.get(`books/${DOC}`);
    expect(all.devices).toHaveLength(1);
    expect(all.combined).toMatchObject({ seconds: 3660, sessions: 11, pages: 202 });
    expect((await f.get('books?limit=1')).items).toHaveLength(1); // cursor contract stays intact
  });

  it('adds same-day fresh-card counters separately from snapshot resets', async () => {
    const f = await fixture();
    const day = (seconds: number, counter_id?: string) => ({ date: '2026-11-01', seconds, counter_id });
    await f.put('global', global(3600, { daily: [day(600)] }));
    for (const counter_id of [A, B]) { // two totals resets; original daily store survives
      await f.put('counters/global', global(0, { counter_id, daily: [day(600)] }));
      expect((await f.get('summary')).daily[0].seconds).toBe(600);
    }
    for (const seconds of [60, 60, 30, 90]) {
      await f.put('counters/global', global(90, { counter_id: B, daily: [day(seconds, A)] }));
    }
    expect((await f.get('summary')).daily[0].seconds).toBe(690);
    await f.put('counters/books', { device_id: 'reader', items: [book(3600, { daily: [day(600)] })] });
    await f.put('counters/books', { device_id: 'reader', items: [book(90, { counter_id: A, daily: [day(90, A)] })] });
    expect((await f.get(`books/${DOC}`)).combined.daily).toEqual([{ date: '2026-11-01', seconds: 690 }]);
    expect((await f.get('global')).devices[0].stats.daily).toEqual([{ date: '2026-11-01', seconds: 690 }]);
  });

  it('preserves completion-only legacy history on a blank reset and accepts explicit-ID edits', async () => {
    const f = await fixture();
    await f.put('global', global(0, { completed: 1 }));
    await f.put('books', { device_id: 'reader', items: [book(0, {
      completed: true, start_date: 1609502400, finished_date: 1609506000,
    })] });
    await f.put('global', global(0));
    await f.put('books', { device_id: 'reader', items: [book(0)] });
    expect((await f.get('summary')).completed).toBe(1);
    expect((await f.get(`books/${DOC}`)).combined).toMatchObject({
      seconds: 0, sessions: 0, pages: 0, completed: true, start_date: 1609502400, finished_date: 1609506000,
    });
    // It must still survive after new reading exceeds the original zero counters.
    await f.put('global', global(10, { sessions: 0, pages: 0, completed: 0 }));
    await f.put('books', { device_id: 'reader', items: [book(10, {
      sessions: 0, pages: 0, completed: false, start_date: 1609702400, finished_date: 0,
    })] });
    expect((await f.get('summary')).completed).toBe(1);
    expect((await f.get(`books/${DOC}`)).combined).toMatchObject({
      completed: true, start_date: 1609502400, finished_date: 1609506000,
    });
    await f.put('counters/global', global(10, { counter_id: LEGACY_COUNTER_ID, completed: 0 }));
    await f.put('counters/books', { device_id: 'reader', items: [book(10, {
      counter_id: LEGACY_COUNTER_ID, completed: false, start_date: 0, finished_date: 0,
    })] });
    expect((await f.get('summary')).completed).toBe(0);
    expect((await f.get(`books/${DOC}`)).combined).toMatchObject({ completed: false, start_date: 0, finished_date: 0 });
  });

  it('validates IDs atomically, including malformed book batch members', async () => {
    const f = await fixture();
    for (const counter_id of [null, '', 'A'.repeat(32), 'x'.repeat(32), 123, 'a'.repeat(33)]) {
      expect((await f.put('counters/global', global(60, { counter_id }))).status).toBe(403);
      expect((await f.put('counters/global', global(60, { daily: [{ date: '2026-11-01', seconds: 60, counter_id }] }))).status).toBe(403);
      expect((await f.put('counters/books', { device_id: 'reader', items: [book(), book(60, { counter_id })] })).status).toBe(403);
    }
    expect((await f.put('counters/books', { device_id: 'reader', items: [book(), null] })).status).toBe(403);
    for (const table of ['stats_counter_snapshots', 'stats_counter_days', 'stats_device_global', 'stats_device_book']) {
      expect(f.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n).toBe(0);
    }
  });

  it('migrates populated databases into the legacy lifetime without increasing totals', async () => {
    const f = await fixture();
    await f.put('global', global());
    await f.put('books', { device_id: 'reader', items: [book()] });
    f.db.exec('DROP TABLE stats_counter_snapshots; DROP TABLE stats_counter_days');
    f.db.prepare('DELETE FROM migrations WHERE name = ?').run('0049_stats_counter_ids.sql');
    migrate(f.db);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM stats_counter_snapshots').get()!.n).toBe(2);
    await f.put('counters/global', global(3600, { counter_id: LEGACY_COUNTER_ID }));
    expect((await f.get('summary')).seconds).toBe(3600);
    await f.put('counters/global', global(60, { counter_id: A }));
    expect((await f.get('summary')).seconds).toBe(3660);
  });

  it('round trips lifetime identities, accepts old archives, and clears histories on explicit deletion', async () => {
    const f = await fixture();
    await f.put('global', global());
    await f.put('counters/global', global(60, { counter_id: A, daily: [{ date: '2026-11-01', seconds: 60, counter_id: A }] }));
    await f.put('counters/books', { device_id: 'reader', items: [book(60, { counter_id: A })] });
    const archive = exportAccountData(f.db, f.id);
    const target = await fixture();
    importAccountData(target.db, target.id, archive, false);
    await target.put('counters/global', global(60, { counter_id: A }));
    expect((await target.get('summary')).seconds).toBe(3660);
    const oldArchive: any = exportAccountData(f.db, f.id);
    delete oldArchive.data.stats_counter_snapshots;
    delete oldArchive.data.stats_counter_days;
    const oldTarget = await fixture();
    importAccountData(oldTarget.db, oldTarget.id, oldArchive, false);
    await oldTarget.put('global', global(0));
    expect((await oldTarget.get('summary')).seconds).toBe(3660);
    deleteDocumentData(f.db, f.id, DOC);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM stats_counter_snapshots WHERE document = ?').get(DOC)!.n).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM stats_counter_snapshots WHERE document = ?').get('')!.n).toBe(2);
    expect((await f.app.request('/api/v1/account/data', { method: 'DELETE', headers: f.headers })).status).toBe(200);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM stats_counter_snapshots').get()!.n).toBe(0);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM stats_counter_days').get()!.n).toBe(0);
  });
});
