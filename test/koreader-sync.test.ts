import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { HISTORY_DEVICE, importHistory, prepareHistory } from '../src/models/koinsight-import.js';
import { deleteKosyncUserData } from '../src/routes/account.js';
import { mergeDocuments } from '../src/models/merge.js';

const at = (date: string) => Date.parse(date) / 1000;
const first = { page: 10, total_pages: 100, start_time: at('2025-11-02T03:30:00Z'), duration: 30 };
const next = { page: 40, total_pages: 200, start_time: at('2025-11-02T07:30:00Z'), duration: 60 };
const payload = (pages = [first], md5 = DOC) => ({ version: 1, book: { md5, title: 'A book', authors: 'An author' }, timezone: 'America/New_York', pages });
async function fixture() {
  const s = makeTestApp();
  const user = await registerUser(s.app);
  const id = Number(s.db.prepare('SELECT id FROM users WHERE username = ?').get(user.username)!.id);
  const upload = (body: unknown) => s.app.request('/api/v1/stats/koreader', { method: 'POST', headers: user.headers, body: JSON.stringify(body) });
  const summary = async () => (await s.app.request('/api/v1/stats/global', { headers: user.headers })).json();
  const stored = () => JSON.parse(String(s.db.prepare('SELECT payload FROM stats_device_global WHERE user_id = ? AND device_id = ?').get(id, HISTORY_DEVICE)?.payload));
  return { ...s, ...user, id, upload, summary, stored };
}

describe('KOReader stats sync', () => {
  it('deduplicates retrying, updated durations and overlapping device histories without changing positions', async () => {
    const s = await fixture();
    await s.app.request('/syncs/progress', { method: 'PUT', headers: s.headers,
      body: JSON.stringify({ document: DOC, device_id: 'reader', progress: '/body/p[2]', percentage: 0.1 }) });
    const position = s.db.prepare('SELECT * FROM progress').all();
    const clock = s.db.prepare('SELECT * FROM change_seq').all();
    expect((await s.upload(payload())).status).toBe(200);
    expect((await s.upload(payload())).status).toBe(200);
    expect(s.stored()).toMatchObject({ seconds: 30, pages: 1, sessions: 1, completed: 0 });
    expect((await s.upload(payload([{ ...first, duration: 40 }, next]))).status).toBe(200);
    // A stale copy on another reader cannot lower duration or erase the newer event.
    expect((await s.upload(payload())).status).toBe(200);
    expect(s.stored()).toMatchObject({ seconds: 100, pages: 2, sessions: 2 });
    expect(s.db.prepare('SELECT date, seconds FROM stats_device_day ORDER BY date').all()).toEqual([
      { date: '2025-11-01', seconds: 40 }, { date: '2025-11-02', seconds: 60 },
    ]);
    expect(s.db.prepare('SELECT percentage FROM progress_log WHERE device_id = ? ORDER BY at').all(HISTORY_DEVICE)).toEqual([{ percentage: 0.1 }, { percentage: 0.2 }]);
    expect(s.db.prepare('SELECT * FROM progress').all()).toEqual(position);
    expect(s.db.prepare('SELECT * FROM change_seq').all()).toEqual(clock);
    expect(s.db.prepare('SELECT * FROM connector_queue').all()).toEqual([]);
    expect((await s.upload(payload([next], 'b'.repeat(32)))).status).toBe(200);
    expect(s.stored().seconds).toBe(160);
    const other = await registerUser(s.app);
    expect((await (await s.app.request('/api/v1/stats/global', { headers: other.headers })).json()).devices).toEqual([]);
    expect((await s.app.request('/api/v1/stats/koreader', { method: 'POST', body: JSON.stringify(payload()) })).status).toBe(401);
  });

  it('uses imported source records once and adds KOReader time alongside independent firmware time', async () => {
    const s = await fixture();
    const history = { books: [{ ...payload().book, reference_pages: null }], pages: [{ ...first, book_md5: DOC }] };
    importHistory(s.db, s.id, prepareHistory(s.db, s.id, history, 'UTC'), { [DOC]: null });
    const firmware = { v: 5, sessions: 1, seconds: 50, pages: 2, completed: false, avg_fwd: 0, pace_n: 0, eta: 0,
      start_manual: false, finish_manual: false, start_date: 0, finished_date: 0, tod: [0, 0, 0, 50], dow: [50, 0, 0, 0, 0, 0, 0] };
    s.db.prepare('INSERT INTO stats_device_book VALUES (?, ?, ?, ?, ?)').run(s.id, 'crosspoint', DOC, JSON.stringify(firmware), 1);
    expect((await s.upload(payload([first, next]))).status).toBe(200);
    expect(s.stored().seconds).toBe(90);
    expect(JSON.parse(String(s.db.prepare('SELECT payload FROM stats_device_book WHERE device_id = ?').get('crosspoint')!.payload))).toEqual(firmware);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM reader_history_pages').get()!.n).toBe(2);
    // A pre-plugin import can be re-imported even after this reader added firmware stats.
    s.db.exec('DELETE FROM reader_history_pages');
    const prepared = prepareHistory(s.db, s.id, history, 'UTC');
    expect(prepared[0].existing_history).toBe(false);
    importHistory(s.db, s.id, prepared, { [DOC]: null });
    expect((await s.upload(payload([first, next]))).status).toBe(200);
    expect(s.stored().seconds).toBe(90);
  });

  it('refuses older aggregate-only imports instead of double-counting or losing their history', async () => {
    const s = await fixture();
    await s.upload(payload());
    s.db.exec('DELETE FROM reader_history_pages');
    const before = s.stored();
    const res = await s.upload(payload([next]));
    expect(res.status).toBe(409);
    expect((await res.json()).message).toContain('Re-import');
    expect(s.stored()).toEqual(before);
  });

  it('does not infer completion from a page jump, and preserves user-edited metadata', async () => {
    const s = await fixture();
    await s.upload(payload([{ ...first, page: 100 }]));
    expect(s.stored().completed).toBe(0);
    s.db.prepare("UPDATE documents SET title = 'My title', status = 'finished', finished_date = ?").run(at('2025-11-03T00:00:00Z'));
    await s.upload(payload([next]));
    expect(s.stored().completed).toBe(1);
    expect(s.db.prepare('SELECT title, status FROM documents').get()).toEqual({ title: 'My title', status: 'finished' });
  });

  it('deduplicates aliases and retains its event ledger through account restore and deletion', async () => {
    const s = await fixture();
    const alias = 'b'.repeat(32);
    await s.upload(payload());
    await s.upload(payload([first, next], alias));
    mergeDocuments(s.db, s.id, alias, DOC, true);
    expect((await s.upload(payload([next], alias))).status).toBe(200);
    expect(s.stored().seconds).toBe(90);
    const archive = await (await s.app.request('/api/v1/account/export', { headers: s.headers })).json();
    const target = await fixture();
    expect((await target.app.request('/api/v1/account/import', { method: 'POST', headers: target.headers, body: JSON.stringify({ archive, mode: 'empty' }) })).status).toBe(200);
    expect((await target.upload(payload([first, next]))).status).toBe(200);
    expect(target.stored().seconds).toBe(90);
    deleteKosyncUserData(target.db, target.id, target.username, { keepUser: true });
    expect(target.db.prepare('SELECT COUNT(*) AS n FROM reader_history_pages').get()!.n).toBe(0);
  });


  it('refuses an aggregate-only alias even when another merged book has source records', async () => {
    const s = await fixture();
    const alias = 'b'.repeat(32);
    await s.upload(payload());
    await s.upload(payload([next], alias));
    s.db.prepare('DELETE FROM reader_history_pages WHERE document = ?').run(alias);
    mergeDocuments(s.db, s.id, alias, DOC, true);
    const before = s.stored();
    expect((await s.upload(payload())).status).toBe(409);
    expect(s.stored()).toEqual(before);
  });

  it.each([
    { ...payload(), timezone: 'Not/AZone' },
    { ...payload(), pages: [{ ...first, duration: -1 }] },
    { ...payload(), pages: [{ ...first, page: 101 }] },
    { ...payload(), pages: [{ ...first, start_time: 99999999999 }] },
    { ...payload(), pages: Array(20_001).fill(first) },
    { ...payload(), book: { ...payload().book, md5: '../bad' } },
    { ...payload(), book: { ...payload().book, title: {} } },
    { ...payload(), version: 2 },
    null,
  ])('rejects invalid uploads atomically', async body => {
    const s = await fixture();
    expect((await s.upload(body)).status).toBe(400);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM documents').get()!.n).toBe(0);
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM reader_history_pages').get()!.n).toBe(0);
  });
});
