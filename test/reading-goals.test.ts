import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTestApp, registerUser, DOC } from './helpers.js';

afterEach(() => vi.useRealTimers());
async function fixture() {
  const s = makeTestApp();
  const u = await registerUser(s.app);
  const id = Number(s.db.prepare('SELECT id FROM users WHERE username=?').get(u.username)!.id);
  const get = async (tz = 0) => (await s.app.request(`/api/v1/account/reading-goals?tz=${tz}`, { headers: u.headers })).json();
  const put = (year: number | string, target: unknown) => s.app.request(`/api/v1/account/reading-goals/${year}`, { method: 'PUT', headers: u.headers, body: JSON.stringify({ target }) });
  return { ...s, ...u, id, get, put };
}

describe('optional yearly reading goals', () => {
  it('starts disabled, keeps years independent, and removes a goal without affecting reading data', async () => {
    const s = await fixture();
    expect((await s.get()).goals).toEqual([]);
    expect((await s.put(2026, 24)).status).toBe(200);
    await s.put(2027, 30);
    await s.put(2026, 12);
    expect((await s.get()).goals).toEqual([{ year: 2026, target: 12, completed: 0 }, { year: 2027, target: 30, completed: 0 }]);
    const other = await registerUser(s.app);
    expect((await (await s.app.request('/api/v1/account/reading-goals', { headers: other.headers })).json()).goals).toEqual([]);
    expect((await s.app.request('/api/v1/account/reading-goals')).status).toBe(401);
    await s.app.request('/api/v1/account/reading-goals/2026', { method: 'DELETE', headers: s.headers });
    expect((await s.get()).goals).toEqual([{ year: 2027, target: 30, completed: 0 }]);
    s.db.close();
  });

  it.each([0, -1, 1.5, '12', null, 10001])('rejects invalid target %s', async (target) => {
    const s = await fixture();
    expect((await s.put(2026, target)).status).toBe(400);
    expect((await s.get()).goals).toEqual([]);
    s.db.close();
  });

  it.each(['1999', '10000', '2026.5', '2e3', '2026abc'])('rejects invalid year %s', async (year) => {
    const s = await fixture();
    expect((await s.put(year, 12)).status).toBe(400);
    s.db.close();
  });

  it('counts canonical completions by local year, preserves chosen calendar dates and excludes future finishes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T02:00:00Z'));
    const s = await fixture();
    await s.put(2026, 1);
    await s.put(2027, 10);
    const log = s.db.prepare('INSERT INTO progress_log (user_id,document,device_id,percentage,at) VALUES (?,?,?,1,?)');
    log.run(s.id, DOC, 'reader', Date.parse('2027-01-01T01:00:00Z') / 1000);
    const alias = 'd'.repeat(32);
    s.db.prepare('INSERT INTO document_aliases (user_id,alias,document,created_at,merge_stats) VALUES (?,?,?,?,1)').run(s.id, alias, DOC, 0);
    log.run(s.id, alias, 'reader', Date.parse('2026-12-30T12:00:00Z') / 1000);
    const chosen = 'b'.repeat(32);
    log.run(s.id, chosen, 'reader', Date.parse('2026-12-30T12:00:00Z') / 1000);
    log.run(s.id, 'c'.repeat(32), 'reader', Date.parse('2026-12-30T12:00:00Z') / 1000);
    s.db.prepare('INSERT INTO documents (user_id,document,status,finished_date,updated_at) VALUES (?,?,?, ?,0)').run(s.id, chosen, 'finished', Date.parse('2027-01-01') / 1000);
    s.db.prepare('INSERT INTO documents (user_id,document,status,finished_date,updated_at) VALUES (?,?,?, ?,0)').run(s.id, 'c'.repeat(32), 'finished', Date.parse('2027-01-02') / 1000);
    expect((await s.get(300)).goals).toEqual([{ year: 2026, target: 1, completed: 1 }, { year: 2027, target: 10, completed: 0 }]);
    expect((await s.get(0)).goals).toEqual([{ year: 2026, target: 1, completed: 0 }, { year: 2027, target: 10, completed: 2 }]);
    s.db.close();
  });

  it('counts finish-dated stats-only books once across devices and progress history', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T02:00:00Z'));
    const s = await fixture();
    await s.put(2026, 12);
    await s.put(2027, 12);
    const finish = Date.parse('2026-12-31T00:00:00Z') / 1000;
    const snapshot = (document: string, extra = {}) => ({ document, v: 5, sessions: 1, seconds: 60, pages: 20, completed: true, avg_fwd: 0, pace_n: 0, eta: 0, start_manual: false, finish_manual: false, start_date: 0, finished_date: finish, tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0], ...extra });
    const synced = 'b'.repeat(32);
    const items = [snapshot(DOC), snapshot(synced), snapshot('future', { finished_date: Date.parse('2027-01-02') / 1000 }), snapshot('incomplete', { completed: false }), snapshot('undated', { finished_date: 0 }), snapshot('reopened')];
    for (const device_id of ['reader', 'other-reader']) {
      expect((await s.app.request('/api/v1/stats/books', { method: 'PUT', headers: s.headers, body: JSON.stringify({ device_id, items }) })).status).toBe(200);
    }
    s.db.prepare('INSERT INTO progress_log (user_id,document,device_id,percentage,at) VALUES (?,?,?,1,?)').run(s.id, synced, 'reader', finish);
    s.db.prepare("INSERT INTO documents (user_id,document,status,updated_at) VALUES (?,?,'reading',0)").run(s.id, 'reopened');
    expect(s.db.prepare('SELECT 1 FROM documents WHERE user_id=? AND document=?').get(s.id, DOC)).toBeUndefined();
    expect(s.db.prepare('SELECT 1 FROM progress_log WHERE user_id=? AND document=?').get(s.id, DOC)).toBeUndefined();
    expect((await s.get(300)).goals).toEqual([{ year: 2026, target: 12, completed: 2 }, { year: 2027, target: 12, completed: 0 }]);
    expect((await s.get(-600)).goals).toEqual([{ year: 2026, target: 12, completed: 2 }, { year: 2027, target: 12, completed: 0 }]);
    s.db.close();
  });

  it('counts a stats-only merged book by its canonical document and honors excluded stats aliases', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-05T12:00:00Z'));
    const s = await fixture();
    await s.put(2026, 12);
    const finish = Date.parse('2026-10-24') / 1000;
    const payload = JSON.stringify({ v: 5, sessions: 1, seconds: 60, pages: 20, completed: true, avg_fwd: 0, pace_n: 0, eta: 0, start_manual: false, finish_manual: false, start_date: 0, finished_date: finish, tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0] });
    const stats = s.db.prepare('INSERT INTO stats_device_book (user_id,device_id,document,payload,updated_at) VALUES (?,?,?,?,0)');
    stats.run(s.id, 'reader', 'alias', payload);
    stats.run(s.id, 'other-reader', 'canonical', payload);
    stats.run(s.id, 'reader', 'excluded-alias', payload);
    const alias = s.db.prepare('INSERT INTO document_aliases (user_id,alias,document,created_at,merge_stats) VALUES (?,?,?,?,?)');
    alias.run(s.id, 'alias', 'canonical', 0, 1);
    alias.run(s.id, 'excluded-alias', 'other-canonical', 0, 0);
    const result = await s.get();
    expect(result.goals).toEqual([{ year: 2026, target: 12, completed: 1 }]);
    expect(result.recent_finished).toEqual([{ document: 'canonical', title: 'Untitled book' }]);
    s.db.close();
  });

  it('exports targets, restores them, accepts older archives, and clears them with reading data', async () => {
    const s = await fixture();
    await s.put(2026, 12);
    const archive = await (await s.app.request('/api/v1/account/export', { headers: s.headers })).json();
    expect(archive.data.reading_goals).toEqual([{ year: 2026, target: 12 }]);
    const restore = (data: unknown) => s.app.request('/api/v1/account/import', { method: 'POST', headers: s.headers, body: JSON.stringify({ archive: data, mode: 'replace' }) });
    expect((await restore(archive)).status).toBe(200);
    expect((await s.get()).goals[0].target).toBe(12);
    archive.data.reading_goals[0].target = 0;
    expect((await restore(archive)).status).toBe(400);
    expect((await s.get()).goals[0].target).toBe(12);
    delete archive.data.reading_goals;
    expect((await restore(archive)).status).toBe(200);
    expect((await s.get()).goals).toEqual([]);
    await s.put(2026, 15);
    await s.app.request('/api/v1/account/data', { method: 'DELETE', headers: s.headers });
    expect((await s.get()).goals).toEqual([]);
    s.db.close();
  });
});
