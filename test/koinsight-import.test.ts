import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip } from '../src/kindle-zip.js';
import { readHistoryFile } from '../src/models/koinsight-import.js';
import { readingActivity } from '../src/models/activity.js';
import { parseBookStats, parseGlobalStats } from '../src/models/stats.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

const OLD = 'b'.repeat(32);
const SECOND = 'c'.repeat(32);
const at = (s: string) => Date.parse(s) / 1000;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function database(edit?: (db: DatabaseSync) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'koinsight-test-')); dirs.push(dir);
  const path = join(dir, 'history.sqlite');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE book (md5 TEXT, title TEXT, authors TEXT, reference_pages INTEGER, soft_deleted INTEGER);
    CREATE TABLE page_stat (book_md5 TEXT, page INTEGER, total_pages INTEGER, start_time INTEGER, duration INTEGER);
    INSERT INTO book VALUES ('${OLD}', 'Old book', 'Author', 300, 0), ('${SECOND}', 'Another book', 'Author', 100, 0);`);
  const page = db.prepare('INSERT INTO page_stat VALUES (?, ?, 100, ?, ?)');
  page.run(OLD, 1, at('2025-11-01T23:30:00Z'), 30);
  page.run(OLD, 99, at('2025-11-03T02:00:00Z'), 60);
  page.run(SECOND, 5, at('2025-11-04T02:00:00Z'), 20);
  edit?.(db);
  db.close();
  return readFileSync(path);
}
async function fixture() {
  const server = makeTestApp();
  const user = await registerUser(server.app);
  const id = Number(server.db.prepare('SELECT id FROM users WHERE username = ?').get(user.username)!.id);
  const headers = { 'x-auth-user': user.headers['x-auth-user'], 'x-auth-key': user.headers['x-auth-key'] };
  const upload = (bytes: Buffer, finishes?: Record<string, unknown>, timezone = 'America/New_York') => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(bytes)]), 'history.zip');
    form.append('timezone', timezone);
    if (finishes) form.append('finishes', JSON.stringify(finishes));
    return server.app.request(`/api/v1/account/import/koinsight${finishes ? '' : '?preview=1'}`, { method: 'POST', headers, body: form });
  };
  return { ...server, ...user, id, upload };
}

describe('KOInsight file import', () => {
  it('previews a ZIP without writes, imports history and dates, and never changes reader sync state', async () => {
    const s = await fixture();
    await s.app.request('/syncs/progress', { method: 'PUT', headers: s.headers,
      body: JSON.stringify({ document: DOC, device_id: 'kindle', progress: '/body/p[14]', percentage: 0.42, metadata: { title: 'Current book' } }) });
    const progress = s.db.prepare('SELECT * FROM progress').all();
    const samples = s.db.prepare('SELECT * FROM progress_samples').all();
    const clock = s.db.prepare('SELECT * FROM change_seq').all();
    const bytes = buildZip([{ name: 'koinsight.sqlite', data: database() }, { name: 'crosspoint.sqlite', data: Buffer.from('ignored') }]);
    const preview = await s.upload(bytes);
    expect(preview.status).toBe(200);
    expect((await preview.json()).books[0]).toMatchObject({ document: OLD, completed: true, finished_date: '2025-11-02', start_date: '2025-11-01' });
    expect(s.db.prepare('SELECT COUNT(*) AS n FROM documents').get()!.n).toBe(1);
    const finishes = { [OLD]: '2025-11-02', [SECOND]: null };
    const imported = await s.upload(bytes, finishes);
    expect(imported.status).toBe(200);
    expect(await imported.json()).toEqual({ books: 2, imported_history: 2, preserved_history: 0 });
    expect(s.db.prepare('SELECT * FROM progress').all()).toEqual(progress);
    expect(s.db.prepare('SELECT * FROM progress_samples').all()).toEqual(samples);
    expect(s.db.prepare('SELECT * FROM change_seq').all()).toEqual(clock);
    expect(s.db.prepare('SELECT * FROM connector_queue').all()).toEqual([]);
    expect(await (await s.app.request(`/syncs/progress/${OLD}`, { headers: s.headers })).json()).toEqual({});
    expect((await (await s.app.request('/api/v1/progress', { headers: s.headers })).json()).items).toHaveLength(1);
    const listed = await (await s.app.request('/api/v1/progress?include_history=1', { headers: s.headers })).json();
    expect(listed.items).toHaveLength(3);
    expect(listed.items.find((b: any) => b.document === OLD)).toMatchObject({ history_only: true, percentage: null, progress: null, device_id: null, status: 'finished' });
    expect(listed.items.find((b: any) => b.document === SECOND).status).toBe('paused');
    const activity = readingActivity(s.db, s.id, 300);
    expect(activity.books.find(b => b.document === OLD)?.finished_at).toBe(at('2025-11-02T17:00:00Z'));
    expect(activity.days.some(d => d.day === '2025-11-02' && d.books.some(b => b.document === OLD))).toBe(true);
    const before = s.db.prepare('SELECT * FROM progress_log ORDER BY at').all();
    expect((await s.upload(bytes, finishes)).status).toBe(200);
    expect(s.db.prepare('SELECT * FROM progress_log ORDER BY at').all()).toEqual(before);
    const stats = JSON.parse(String(s.db.prepare('SELECT payload FROM stats_device_global').get()!.payload));
    expect(parseGlobalStats(stats)).not.toBeNull();
    expect(stats).toMatchObject({ seconds: 110, pages: 3, sessions: 3, completed: 1 });
    for (const r of s.db.prepare('SELECT payload FROM stats_device_book').all()) expect(parseBookStats(JSON.parse(String(r.payload)))).not.toBeNull();
    const other = await registerUser(s.app);
    expect((await (await s.app.request('/api/v1/progress?include_history=1', { headers: other.headers })).json()).items).toEqual([]);
  });

  it('preserves pre-existing stats and metadata, fills missing timeline, and paginates historical books', async () => {
    const s = await fixture();
    const bytes = database();
    await s.upload(bytes, { [OLD]: '2025-11-02', [SECOND]: null });
    s.db.exec("UPDATE stats_device_book SET device_id = 'previous-import'; DELETE FROM progress_log;");
    s.db.prepare("UPDATE documents SET title = 'My title', finished_date = ? WHERE document = ?").run(at('2025-11-03T00:00:00Z'), OLD);
    const before = s.db.prepare('SELECT * FROM stats_device_book').all();
    const preview = await (await s.upload(bytes)).json();
    expect(preview.books[0]).toMatchObject({ existing_history: true, finished_date: '2025-11-03' });
    expect(await (await s.upload(bytes, { [OLD]: '2025-11-03', [SECOND]: null })).json()).toMatchObject({ imported_history: 0, preserved_history: 2 });
    expect(s.db.prepare('SELECT * FROM stats_device_book').all()).toEqual(before);
    expect(readingActivity(s.db, s.id, 0).books).toHaveLength(2);
    const first = await (await s.app.request('/api/v1/progress?include_history=1&limit=1', { headers: s.headers })).json();
    const second = await (await s.app.request(`/api/v1/progress?include_history=1&limit=1&cursor=${encodeURIComponent(first.next)}`, { headers: s.headers })).json();
    expect(first.items[0].document).not.toBe(second.items[0].document);
    expect(second.next).toBeNull();
  });

  it('lets users reject inferred completion without a dummy position', async () => {
    const s = await fixture();
    expect((await s.upload(database(), { [OLD]: null, [SECOND]: null })).status).toBe(200);
    expect(readingActivity(s.db, s.id, 0).books.every(b => b.finished_at === null)).toBe(true);
  });

  it('preserves a real position for an imported book and lets later reader activity unpause it', async () => {
    const s = await fixture();
    await s.upload(database(), { [OLD]: null, [SECOND]: null });
    await s.app.request('/syncs/progress', { method: 'PUT', headers: s.headers,
      body: JSON.stringify({ document: OLD, device_id: 'kindle', progress: '/body/p[22]', percentage: 0.22 }) });
    const progress = s.db.prepare('SELECT * FROM progress').all();
    expect(s.db.prepare('SELECT status FROM documents WHERE document = ?').get(OLD)!.status).toBeNull();
    expect((await s.upload(database(), { [OLD]: '2025-11-02', [SECOND]: null })).status).toBe(200);
    expect(s.db.prepare('SELECT * FROM progress').all()).toEqual(progress);
    expect(await (await s.app.request(`/syncs/progress/${OLD}`, { headers: s.headers })).json()).toMatchObject({ progress: '/body/p[22]', percentage: 0.22 });
  });

  it('shows reviewed dates without inventing activity or positions for a book with no page records', async () => {
    const s = await fixture();
    const bytes = database(db => db.exec('DELETE FROM page_stat'));
    expect((await s.upload(bytes, { [OLD]: '2025-11-02', [SECOND]: null })).status).toBe(200);
    const activity = readingActivity(s.db, s.id, 0);
    expect(activity.books.find(b => b.document === OLD)).toMatchObject({ finished_at: at('2025-11-02T12:00:00Z'), days_to_finish: null });
    expect(activity.days[0]).toMatchObject({ day: '2025-11-02', syncs: 0, pages: 0 });
    expect(s.db.prepare('SELECT * FROM progress_log').all()).toEqual([]);
    expect(s.db.prepare('SELECT * FROM progress').all()).toEqual([]);
  });

  it('validates every selection before writing and rejects malformed uploads', async () => {
    const s = await fixture();
    for (const finishes of [{ [OLD]: '2025-02-30', [SECOND]: null }, { [OLD]: '2025-01-01', [SECOND]: null }, { [OLD]: null }]) {
      expect((await s.upload(database(), finishes)).status).toBe(400);
    }
    expect((await s.upload(database(), undefined, 'not-a-zone')).status).toBe(400);
    expect((await s.upload(Buffer.from('bad database'))).status).toBe(400);
    expect((await s.upload(database(db => db.exec('UPDATE page_stat SET duration = -1')))).status).toBe(400);
    expect(s.db.prepare('SELECT * FROM documents').all()).toEqual([]);
    expect((await s.app.request('/api/v1/account/import/koinsight', { method: 'POST' })).status).toBe(401);
  });

  it('reads KOReader raw page records without executing its page_stat view, and deduplicates copies', async () => {
    const bytes = database(db => db.exec(`
      ALTER TABLE book ADD COLUMN id INTEGER;
      UPDATE book SET id = CASE WHEN md5 = '${OLD}' THEN 1 ELSE 2 END;
      CREATE TABLE page_stat_data (id_book INTEGER, page INTEGER, total_pages INTEGER, start_time INTEGER, duration INTEGER);
      INSERT INTO page_stat_data SELECT b.id, p.page, p.total_pages, p.start_time, p.duration FROM page_stat p JOIN book b ON b.md5 = p.book_md5;
      INSERT INTO book SELECT md5, 'Changed title', authors, reference_pages, soft_deleted, 3 FROM book WHERE id = 1;
      INSERT INTO page_stat_data SELECT 3, page, total_pages, start_time, duration FROM page_stat_data WHERE id_book = 1;
      DROP TABLE page_stat;
      CREATE VIEW page_stat AS SELECT * FROM never_execute_this_view;
    `));
    const history = await readHistoryFile(bytes);
    expect(history.source).toBe('KOReader');
    expect(history.books).toHaveLength(2);
    expect(history.pages).toHaveLength(3);
    const s = await fixture();
    const preview = await (await s.upload(bytes)).json();
    expect(preview.source).toBe('KOReader');
    expect((await s.upload(bytes, { [OLD]: '2025-11-02', [SECOND]: null })).status).toBe(200);
    expect((await s.upload(database(), { [OLD]: '2025-11-02', [SECOND]: null })).status).toBe(200);
    expect(s.db.prepare('SELECT * FROM progress').all()).toEqual([]);
    expect(s.db.prepare('SELECT * FROM progress_log').all()).toHaveLength(3);
    expect(JSON.parse(String(s.db.prepare('SELECT payload FROM stats_device_global').get()!.payload)).seconds).toBe(110);
  });

  it('rejects ambiguous archives and views instead of executing uploaded queries', async () => {
    await expect(readHistoryFile(buildZip([{ name: 'a.db', data: database() }, { name: 'b.db', data: database() }]))).rejects.toThrow('multiple');
    await expect(readHistoryFile(database(db => db.exec('DROP TABLE page_stat; CREATE VIEW page_stat AS SELECT * FROM book;')))).rejects.toThrow('ordinary');
  });
});
