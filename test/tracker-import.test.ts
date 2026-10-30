import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { readTrackerCsv, parseCsv, normalizeIsbn } from '../src/models/tracker-import.js';
import { readingActivity } from '../src/models/activity.js';
import { exportAccountData, importAccountData } from '../src/models/account-data.js';
import { mergeDocuments } from '../src/models/merge.js';
import { makeTestApp, registerUser, DOC } from './helpers.js';

const fixtureFile = (name: string) => readFileSync(new URL(`./fixtures/imports/${name}.csv`, import.meta.url));
async function setup() {
  const s = makeTestApp({}, { connectorTransport: async () => new Response('{}', { status: 404 }) });
  const user = await registerUser(s.app);
  const id = Number(s.db.prepare('SELECT id FROM users WHERE username = ?').get(user.username)!.id);
  const upload = (bytes: Buffer, choices?: unknown) => {
    const body = new FormData(); body.append('file', new Blob([new Uint8Array(bytes)]), 'export.csv'); body.append('timezone', 'UTC');
    if (choices) body.append('choices', JSON.stringify(choices));
    return s.app.request(`/api/v1/account/import/history${choices ? '' : '?preview=1'}`, { method: 'POST', headers: { 'x-auth-user': user.username, 'x-auth-key': user.headers['x-auth-key'] }, body });
  };
  return { ...s, ...user, id, upload };
}
const selections = (preview: any) => Object.fromEntries(preview.books.map((b: any) => [b.source_id,
  { target: b.target, status: b.status, start_date: b.start_date, finished_date: b.finished_date }]));

describe('tracker CSV formats', () => {
  it('parses quoted multiline UTF-8 CSV and Goodreads ISBN wrappers', () => {
    const parsed = readTrackerCsv(Buffer.concat([Buffer.from('\uFEFF'), fixtureFile('goodreads')]));
    expect(parsed.source).toBe('Goodreads');
    expect(parsed.books).toHaveLength(3);
    expect(parsed.skipped).toBe(1);
    expect(parsed.books[0]).toMatchObject({ title: 'A Book, with "Quotes"', isbn: '9780306406157', user_rating: 4, status: 'finished', finished_date: '2020-03-10', start_date: null });
    expect(parsed.books[1]).toMatchObject({ status: 'finished', finished_date: null, start_date: null, user_rating: null });
    expect(normalizeIsbn('0306406152')).toBe('9780306406157');
    expect(normalizeIsbn('9780306406158')).toBeNull();
    expect(parseCsv('a,b\r\n"é,雪","a""b"\r\n')).toEqual([['a', 'b'], ['é,雪', 'a"b']]);
  });

  it('keeps the latest StoryGraph period, DNF status, fractional ratings and open starts', () => {
    const t = readTrackerCsv(fixtureFile('storygraph'));
    expect(t.books[0]).toMatchObject({ start_date: '2023-10-09', finished_date: '2023-11-02', user_rating: 4.25 });
    expect(t.books[1]).toMatchObject({ status: 'finished', finished_date: null });
    expect(t.books[2]).toMatchObject({ status: 'reading', start_date: '2024-01-02', finished_date: null });
    expect(t.books[3].status).toBe('dnf');
    expect(t.warnings).toEqual(expect.arrayContaining([expect.stringContaining('latest available reading period')]));
    expect(t.skipped).toBe(1);
  });

  it.each(['"unterminated', 'a"b,c', '"a"x,b'])('rejects malformed CSV %s', text => {
    expect(() => parseCsv(text)).toThrow();
  });

  it('rejects bad dates, duplicate rows, unsupported headers, invalid ratings and malformed row lengths', () => {
    const good = fixtureFile('goodreads').toString();
    for (const text of [good.replace('2020/03/10', '2020/02/30'), good.replace(',4,240,', ',9,240,'), good + good.split('\n')[3] + '\n', 'Title,Author\nA,B', good.replace('Undated Book,Another Author', 'Undated Book,Another,Author')]) {
      expect(() => readTrackerCsv(Buffer.from(text))).toThrow();
    }
  });
});

describe('tracker import API', () => {
  it('imports undated completions without fictitious activity and repeats without duplicates', async () => {
    const s = await setup(); const csv = fixtureFile('goodreads');
    const res = await s.upload(csv); expect(res.status).toBe(200);
    const preview = await res.json(); expect(preview.kind).toBe('tracker');
    expect(s.db.prepare('SELECT * FROM documents').all()).toEqual([]);
    const choices = selections(preview);
    expect((await s.upload(csv, choices)).status).toBe(200);
    expect((await s.upload(csv, choices)).status).toBe(200);
    const undated = s.db.prepare('SELECT status, status_at, start_date, finished_date FROM documents WHERE document = ?').get('goodreads.102');
    expect(undated).toEqual({ status: 'finished', status_at: null, start_date: null, finished_date: null });
    for (const table of ['progress', 'progress_samples', 'progress_log', 'reading_sessions', 'stats_device_global', 'stats_device_book', 'stats_device_day', 'connector_queue']) {
      expect(s.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
    const activity = readingActivity(s.db, s.id, 0);
    expect(activity.books.find(b => b.document === 'goodreads.102')).toMatchObject({ completed: true, finished_at: null, started_at: 0, days_to_finish: null });
    expect(activity.days.map(d => d.day)).toEqual(['2020-03-10']);
    expect(activity.days[0]).toMatchObject({ syncs: 0, pages: 0 });
    const overview = await (await s.app.request('/api/v1/stats/overview', { headers: s.headers })).json();
    expect(overview).toMatchObject({ books_finished: 2, finished_this_year: 0, seconds: 0, sessions: 0 });
    const books = await (await s.app.request('/api/v1/progress?include_history=1', { headers: s.headers })).json();
    expect(books.items).toHaveLength(3);
    expect(books.items.find((b: any) => b.document === 'goodreads.101')).toMatchObject({ user_rating: 4, isbn: '9780306406157', progress: null, history_only: true });
  });

  it('requires title-match review, keeps real progress and personal ratings separate, and remembers the source match', async () => {
    const s = await setup();
    await s.app.request('/syncs/progress', { method: 'PUT', headers: s.headers, body: JSON.stringify({ document: DOC, device_id: 'kindle', progress: '/body/p[9]', percentage: 0.35, metadata: { title: 'A Book, with "Quotes"', authors: 'Example Author' } }) });
    s.db.prepare('UPDATE documents SET rating = 4.8 WHERE document = ?').run(DOC);
    const before = s.db.prepare('SELECT * FROM progress').all();
    const csv = fixtureFile('goodreads'); const preview = await (await s.upload(csv)).json();
    expect(preview.books[0].target).toBe('');
    const choices = selections(preview);
    expect((await s.upload(csv, choices)).status).toBe(400);
    choices['goodreads.101'].target = DOC;
    expect((await s.upload(csv, choices)).status).toBe(200);
    expect(s.db.prepare('SELECT * FROM progress').all()).toEqual(before);
    expect(s.db.prepare('SELECT rating, user_rating FROM documents WHERE document = ?').get(DOC)).toEqual({ rating: 4.8, user_rating: 4 });
    expect((await (await s.upload(csv)).json()).books[0]).toMatchObject({ locked: true, target: DOC });
    expect(s.db.prepare('SELECT * FROM connector_queue').all()).toEqual([]);
    const story = await (await s.upload(fixtureFile('storygraph'))).json();
    expect(story.books[0].target).toBe(DOC); // ISBN match across sources, not a title guess.
  });

  it('rejects cross-account targets and invalid reviews before any writes', async () => {
    const s = await setup(); const csv = fixtureFile('goodreads');
    const other = await registerUser(s.app);
    const otherId = s.db.prepare('SELECT id FROM users WHERE username = ?').get(other.username)!.id;
    s.db.prepare('INSERT INTO documents (user_id, document, title, updated_at) VALUES (?, ?, ?, 0)').run(otherId, DOC, 'Other account');
    const choices = selections(await (await s.upload(csv)).json());
    choices['goodreads.102'].target = DOC;
    expect((await s.upload(csv, choices)).status).toBe(400);
    expect(s.db.prepare('SELECT * FROM documents WHERE user_id = ?').all(s.id)).toEqual([]);
    choices['goodreads.102'].target = 'new'; choices['goodreads.102'].finished_date = '2000-02-30';
    expect((await s.upload(csv, choices)).status).toBe(400);
    expect((await s.app.request('/api/v1/account/import/history', { method: 'POST' })).status).toBe(401);
  });

  it('carries imported identity and ratings through merges and account archives', async () => {
    const s = await setup(); const csv = fixtureFile('goodreads');
    await s.upload(csv, selections(await (await s.upload(csv)).json()));
    s.db.prepare('INSERT INTO documents (user_id, document, title, updated_at) VALUES (?, ?, ?, 0)').run(s.id, DOC, 'Reader copy');
    mergeDocuments(s.db, s.id, 'goodreads.101', DOC, 100);
    expect(s.db.prepare('SELECT isbn, user_rating FROM documents WHERE document = ?').get(DOC)).toEqual({ isbn: '9780306406157', user_rating: 4 });
    const archive = exportAccountData(s.db, s.id);
    const target = await setup(); importAccountData(target.db, target.id, archive, false);
    expect(target.db.prepare('SELECT isbn, user_rating FROM documents WHERE document = ?').get(DOC)).toEqual({ isbn: '9780306406157', user_rating: 4 });
  });
});
