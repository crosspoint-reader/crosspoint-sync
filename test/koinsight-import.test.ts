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

  it('deduplicates KOInsight page turns before preview and keeps imported history and totals consistent', async () => {
    const when = at('2025-11-01T23:30:00Z');
    const bytes = database(db => {
      const turn = db.prepare('INSERT INTO page_stat VALUES (?, ?, ?, ?, ?)');
      turn.run(OLD, 1, 100, when, 20);
      turn.run(OLD, 1, 100, when, 45);
    });
    const history = await readHistoryFile(bytes);
    expect(history.source).toBe('KOInsight');
    expect(history.pages).toHaveLength(3);
    expect(history.pages.find(p => p.book_md5 === OLD && p.page === 1)).toMatchObject({
      duration: 45, start_time: when,
    });

    const s = await fixture();
    const preview = await s.upload(bytes);
    expect(preview.status).toBe(200);
    expect((await preview.json()).books).toEqual(expect.arrayContaining([
      expect.objectContaining({ document: OLD, records: 2 }),
      expect.objectContaining({ document: SECOND, records: 1 }),
    ]));
    expect(s.db.prepare('SELECT * FROM reader_history_pages').all()).toEqual([]);

    const finishes = { [OLD]: '2025-11-02', [SECOND]: null };
    const imported = await s.upload(bytes, finishes);
    expect(imported.status).toBe(200);
    const stored = () => s.db.prepare('SELECT COUNT(*) AS pages, SUM(duration) AS seconds FROM reader_history_pages').get();
    expect(stored()).toEqual({ pages: 3, seconds: 125 });
    expect(JSON.parse(String(s.db.prepare('SELECT payload FROM stats_device_global').get()!.payload))).toMatchObject({
      pages: 3, seconds: 125,
    });
    expect((await s.upload(bytes, finishes)).status).toBe(200);
    expect(stored()).toEqual({ pages: 3, seconds: 125 });
    expect(s.db.prepare('SELECT * FROM progress').all()).toEqual([]);
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

  it('skips incomplete native KOReader turns, reports them in preview, and imports only valid history', async () => {
    const bytes = database(db => db.exec(`
      ALTER TABLE book ADD COLUMN id INTEGER;
      UPDATE book SET id = CASE WHEN md5 = '${OLD}' THEN 1 ELSE 2 END;
      CREATE TABLE page_stat_data (id_book INTEGER, page INTEGER, total_pages INTEGER, start_time INTEGER, duration INTEGER);
      INSERT INTO page_stat_data SELECT b.id, p.page, p.total_pages, p.start_time, p.duration
        FROM page_stat p JOIN book b ON b.md5 = p.book_md5;
      INSERT INTO page_stat_data VALUES
        (1, 3, 100, ${at('2025-11-01T23:40:00Z')}, 0),
        (1, 4, 100, ${at('2025-11-01T23:50:00Z')}, -1),
        (2, 5, 0, ${at('2025-11-04T03:00:00Z')}, 25);
      DROP TABLE page_stat;
      CREATE VIEW page_stat AS SELECT * FROM never_execute_this_view;
    `));
    const history = await readHistoryFile(bytes);
    expect(history.source).toBe('KOReader');
    expect(history.skipped).toEqual({ nonpositive_duration: 2, unknown_page_count: 1 });
    expect(history.pages).toHaveLength(3);
    const s = await fixture();
    const preview = await s.upload(bytes);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({
      source: 'KOReader', skipped_records: 3,
      skipped_reasons: { nonpositive_duration: 2, unknown_page_count: 1 },
    });
    expect(s.db.prepare('SELECT * FROM documents').all()).toEqual([]);
    const imported = await s.upload(bytes, { [OLD]: '2025-11-02', [SECOND]: null });
    expect(imported.status).toBe(200);
    expect((await imported.json()).imported_history).toBe(2);
    expect(JSON.parse(String(s.db.prepare('SELECT payload FROM stats_device_global').get()!.payload)).seconds).toBe(110);
    expect(s.db.prepare('SELECT * FROM progress').all()).toEqual([]);
  });

  it('preserves KOReader history when saved pages exceed a stale total, without accepting implausible values', async () => {
    const t1 = at('2025-11-01T23:40:00Z');
    const t2 = at('2025-11-01T23:50:00Z');
    const t3 = at('2025-11-04T03:00:00Z');
    const bytes = database(db => db.exec(`
      ALTER TABLE book ADD COLUMN id INTEGER;
      UPDATE book SET id = CASE WHEN md5 = '${OLD}' THEN 1 ELSE 2 END;
      CREATE TABLE page_stat_data (id_book INTEGER, page INTEGER, total_pages INTEGER, start_time INTEGER, duration INTEGER);
      INSERT INTO page_stat_data SELECT b.id, p.page, p.total_pages, p.start_time, p.duration
        FROM page_stat p JOIN book b ON b.md5 = p.book_md5;
      INSERT INTO page_stat_data VALUES
        (1, 352, 351, ${t1}, 46),
        (1, 373, 351, ${t2}, 40),
        (2, 135, 113, ${t3}, 25);
      DROP TABLE page_stat;
      CREATE VIEW page_stat AS SELECT * FROM never_execute_this_view;
    `));
    const history = await readHistoryFile(bytes);
    expect(history).toMatchObject({ source: 'KOReader', adjusted_pages: 3, skipped: {
      nonpositive_duration: 0, unknown_page_count: 0,
    } });
    expect(history.pages).toHaveLength(6);
    expect(history.pages.find(p => p.start_time === t1)).toMatchObject({ page: 352, total_pages: 352, duration: 46 });
    expect(history.pages.find(p => p.start_time === t2)).toMatchObject({ page: 373, total_pages: 373, duration: 40 });
    expect(history.pages.find(p => p.start_time === t3)).toMatchObject({ page: 135, total_pages: 135, duration: 25 });
    const s = await fixture();
    const preview = await s.upload(bytes);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ source: 'KOReader', adjusted_records: 3, skipped_records: 0 });
    expect(s.db.prepare('SELECT * FROM documents').all()).toEqual([]);
    const imported = await s.upload(bytes, { [OLD]: '2025-11-02', [SECOND]: null });
    expect(imported.status).toBe(200);
    expect(JSON.parse(String(s.db.prepare('SELECT payload FROM stats_device_global').get()!.payload)).seconds).toBe(221);
    expect(s.db.prepare('SELECT * FROM progress').all()).toEqual([]);
  });

  it('retains distinct same-timestamp overruns and combines only true post-normalization collisions', async () => {
    const when = at('2025-11-01T23:40:00Z');
    const bytes = database(db => db.exec(`
      ALTER TABLE book ADD COLUMN id INTEGER;
      UPDATE book SET id = CASE WHEN md5 = '${OLD}' THEN 1 ELSE 2 END;
      CREATE TABLE page_stat_data (id_book INTEGER, page INTEGER, total_pages INTEGER, start_time INTEGER, duration INTEGER);
      INSERT INTO page_stat_data SELECT b.id, p.page, p.total_pages, p.start_time, p.duration
        FROM page_stat p JOIN book b ON b.md5 = p.book_md5;
      INSERT INTO page_stat_data VALUES
        (1, 352, 351, ${when}, 20),
        (1, 352, 351, ${when}, 5),
        (1, 353, 351, ${when}, 40),
        (1, 352, 352, ${when}, 30);
      DROP TABLE page_stat;
      CREATE VIEW page_stat AS SELECT * FROM never_execute_this_view;
    `));
    const history = await readHistoryFile(bytes);
    expect(history.source).toBe('KOReader');
    expect(history.adjusted_pages).toBe(2);
    expect(history.pages).toHaveLength(5);
    expect(history.pages.find(p => p.start_time === when && p.page === 352)).toMatchObject({
      page: 352, total_pages: 352, duration: 50,
    });
    expect(history.pages.find(p => p.start_time === when && p.page === 353)).toMatchObject({
      page: 353, total_pages: 353, duration: 40,
    });
    const s = await fixture();
    const preview = await s.upload(bytes);
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ source: 'KOReader', adjusted_records: 2, skipped_records: 0 });
    const finishes = { [OLD]: null, [SECOND]: null };
    const imported = await s.upload(bytes, finishes);
    expect(imported.status).toBe(200);
    const totals = () => s.db.prepare('SELECT COUNT(*) AS pages, SUM(duration) AS seconds FROM reader_history_pages').get();
    expect(totals()).toEqual({ pages: 5, seconds: 200 });
    expect(JSON.parse(String(s.db.prepare('SELECT payload FROM stats_device_global').get()!.payload))).toMatchObject({
      pages: 5, seconds: 200,
    });
    expect((await s.upload(bytes, finishes)).status).toBe(200);
    expect(totals()).toEqual({ pages: 5, seconds: 200 });
    expect(s.db.prepare('SELECT * FROM progress').all()).toEqual([]);
  });

  it('rejects page 4 of 3 rather than rounding the 25-percent threshold up', async () => {
    const bytes = database(db => db.exec(`
      ALTER TABLE book ADD COLUMN id INTEGER;
      UPDATE book SET id = CASE WHEN md5 = '${OLD}' THEN 1 ELSE 2 END;
      CREATE TABLE page_stat_data (id_book INTEGER, page INTEGER, total_pages INTEGER, start_time INTEGER, duration INTEGER);
      INSERT INTO page_stat_data SELECT b.id, p.page, p.total_pages, p.start_time, p.duration
        FROM page_stat p JOIN book b ON b.md5 = p.book_md5;
      INSERT INTO page_stat_data VALUES (1, 4, 3, ${at('2025-11-01T23:45:00Z')}, 20);
      DROP TABLE page_stat;
      CREATE VIEW page_stat AS SELECT * FROM never_execute_this_view;
    `));
    await expect(readHistoryFile(bytes)).rejects.toThrow('Invalid KOReader page history (1 malformed record)');
    const s = await fixture();
    const preview = await s.upload(bytes);
    expect(preview.status).toBe(400);
    expect(s.db.prepare('SELECT * FROM documents').all()).toEqual([]);
    expect(s.db.prepare('SELECT * FROM reader_history_pages').all()).toEqual([]);
  });

  it('rejects a native overrun above the persisted page-count ceiling before preview or import', async () => {
    const bytes = database(db => db.exec(`
      ALTER TABLE book ADD COLUMN id INTEGER;
      UPDATE book SET id = CASE WHEN md5 = '${OLD}' THEN 1 ELSE 2 END;
      CREATE TABLE page_stat_data (id_book INTEGER, page INTEGER, total_pages INTEGER, start_time INTEGER, duration INTEGER);
      INSERT INTO page_stat_data SELECT b.id, p.page, p.total_pages, p.start_time, p.duration
        FROM page_stat p JOIN book b ON b.md5 = p.book_md5;
      INSERT INTO page_stat_data VALUES (1, 1000001, 1000000, ${at('2025-11-01T23:45:00Z')}, 20);
      DROP TABLE page_stat;
      CREATE VIEW page_stat AS SELECT * FROM never_execute_this_view;
    `));
    await expect(readHistoryFile(bytes)).rejects.toThrow('Invalid KOReader page history (1 malformed record)');
    const s = await fixture();
    const preview = await s.upload(bytes);
    expect(preview.status).toBe(400);
    expect((await preview.json()).message).toContain('Invalid KOReader page history (1 malformed record)');
    const attemptedImport = await s.upload(bytes, { [OLD]: null, [SECOND]: null });
    expect(attemptedImport.status).toBe(400);
    expect((await attemptedImport.json()).message).toContain('Invalid KOReader page history (1 malformed record)');
    expect(s.db.prepare('SELECT * FROM documents').all()).toEqual([]);
    expect(s.db.prepare('SELECT * FROM reader_history_pages').all()).toEqual([]);
    expect(s.db.prepare('SELECT * FROM progress').all()).toEqual([]);
  });

  it('rejects malformed native KOReader positions with a source-specific error and no writes', async () => {
    const bytes = database(db => db.exec(`
      ALTER TABLE book ADD COLUMN id INTEGER;
      UPDATE book SET id = CASE WHEN md5 = '${OLD}' THEN 1 ELSE 2 END;
      CREATE TABLE page_stat_data (id_book INTEGER, page INTEGER, total_pages INTEGER, start_time INTEGER, duration INTEGER);
      INSERT INTO page_stat_data SELECT b.id, p.page, p.total_pages, p.start_time, p.duration
        FROM page_stat p JOIN book b ON b.md5 = p.book_md5;
      INSERT INTO page_stat_data VALUES (1, 1000, 100, ${at('2025-11-01T23:45:00Z')}, 15);
      DROP TABLE page_stat;
      CREATE VIEW page_stat AS SELECT * FROM never_execute_this_view;
    `));
    await expect(readHistoryFile(bytes)).rejects.toThrow('Invalid KOReader page history');
    const s = await fixture();
    const preview = await s.upload(bytes);
    expect(preview.status).toBe(400);
    expect((await preview.json()).message).toContain('Invalid KOReader page history (1 malformed record)');
    expect(s.db.prepare('SELECT * FROM documents').all()).toEqual([]);
    expect(s.db.prepare('SELECT * FROM progress').all()).toEqual([]);
  });

  it('rejects ambiguous archives and views instead of executing uploaded queries', async () => {
    await expect(readHistoryFile(buildZip([{ name: 'a.db', data: database() }, { name: 'b.db', data: database() }]))).rejects.toThrow('multiple');
    await expect(readHistoryFile(database(db => db.exec('DROP TABLE page_stat; CREATE VIEW page_stat AS SELECT * FROM book;')))).rejects.toThrow('ordinary');
  });
});
