import { describe, expect, it } from 'vitest';
import { makeTestApp, registerUser } from './helpers.js';

const A = 'a'.repeat(32);
const B = 'b'.repeat(32);
const UNKNOWN = 'c'.repeat(32);

const MAY_24 = 1779616800; // 2026-05-24T10:00:00Z
const JUL_01 = 1782900000; // 2026-07-01T10:00:00Z

const book = (document: string, over: Record<string, unknown> = {}) => ({
  document, v: 5, sessions: 2, seconds: 1200, pages: 0, completed: false, avg_fwd: 0, pace_n: 0, eta: 0,
  start_manual: false, finish_manual: false, start_date: 0, finished_date: 0, tod: [0, 0, 0, 0],
  dow: [0, 0, 0, 0, 0, 0, 0], ...over,
});

async function setup() {
  const { app } = makeTestApp();
  const { headers } = await registerUser(app);
  const progress = (document: string, percentage: number, device_id: string, timestamp: number) =>
    app.request('/api/v1/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document, progress: 'p', percentage, device: device_id, device_id, timestamp }),
    });
  const stats = (device_id: string, items: unknown[]) =>
    app.request('/api/v1/stats/books', { method: 'PUT', headers, body: JSON.stringify({ device_id, items }) });
  const get = async (path: string) => {
    const res = await app.request(path, { headers });
    return { status: res.status, body: (await res.json()) as any };
  };
  return { app, headers, progress, stats, get };
}

describe('GET /api/v1/stats/books/:document/activity', () => {
  it('combines a position-only device with every stats device into one history', async () => {
    const { progress, stats, get } = await setup();
    // A kosync reader that never sends stats: only positions.
    await progress(A, 0.05, 'boox', MAY_24);
    await progress(A, 0.3, 'boox', JUL_01);
    // Two stats readers, each with its own days for the book.
    await stats('x4', [book(A, { daily: [{ date: '2026-10-23', seconds: 600 }, { date: '2026-10-24', seconds: 300 }] })]);
    await stats('kobo', [book(A, { daily: [{ date: '2026-10-24', seconds: 120 }] })]);

    const { status, body } = await get(`/api/v1/stats/books/${A}/activity`);
    expect(status).toBe(200);
    expect(body.document).toBe(A);
    // Started at the first sync, as /stats/activity does.
    expect(body.started_at).toBe(MAY_24);
    expect(body.reading_days).toEqual(['2026-05-24', '2026-07-01', '2026-10-23', '2026-10-24']);
    expect(body.days).toEqual([
      expect.objectContaining({ day: '2026-05-24', syncs: 1, seconds: 0 }),
      expect.objectContaining({ day: '2026-07-01', syncs: 1, seconds: 0, to: 0.3 }),
      expect.objectContaining({ day: '2026-10-23', syncs: 0, seconds: 600 }),
      expect.objectContaining({ day: '2026-10-24', syncs: 0, seconds: 420 }),
    ]);
  });

  it('answers for any hash the book is known by, with merged copies folded in', async () => {
    const { app, headers, progress, stats, get } = await setup();
    await progress(A, 0.1, 'boox', MAY_24);
    await stats('x4', [book(B, { daily: [{ date: '2026-10-23', seconds: 600 }] })]);
    const merged = await app.request('/api/v1/documents/merge', {
      method: 'POST',
      headers,
      body: JSON.stringify({ document: B, into: A }),
    });
    expect(merged.status).toBe(200);

    const { body } = await get(`/api/v1/stats/books/${B}/activity`);
    expect(body.document).toBe(A);
    expect(body.reading_days).toEqual(['2026-05-24', '2026-10-23']);
  });

  it('dates a book known only from stats by its stats, else by its first recorded day', async () => {
    const { stats, get } = await setup();
    await stats('x4', [book(A, { daily: [{ date: '2026-10-23', seconds: 600 }] })]);
    const timed = (await get(`/api/v1/stats/books/${A}/activity`)).body;
    expect(timed.started_at).toBe(Date.parse('2026-10-23T12:00:00Z') / 1000);
    expect(timed.reading_days).toEqual(['2026-10-23']);

    const start = Date.parse('2026-10-01T00:00:00Z') / 1000;
    const finish = Date.parse('2026-10-24T00:00:00Z') / 1000;
    await stats('kobo', [book(B, { start_date: start, finished_date: finish, completed: true, daily: [{ date: '2026-10-23', seconds: 60 }] })]);
    const dated = (await get(`/api/v1/stats/books/${B}/activity`)).body;
    expect(dated.started_at).toBe(start + 12 * 3600);
    expect(dated.finished_at).toBe(finish + 12 * 3600);
    expect(dated.completed).toBe(true);
    expect(dated.days_to_finish).toBe(24);
  });

  it('counts reading sessions per day as the overview does: the larger of sessions and snapshots', async () => {
    const { app, headers, stats, get } = await setup();
    await stats('x4', [book(A, { daily: [{ date: '2026-10-23', seconds: 600 }] })]);
    const session = (session_id: string, started_at: number, seconds: number) => ({
      session_id, document: A, started_at, ended_at: started_at + seconds, seconds, utc_offset_minutes: 60,
    });
    const res = await app.request('/api/v1/stats/sessions', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        device_id: 'x4',
        items: [
          session('s1', Date.parse('2026-10-23T09:00:00Z') / 1000, 300), // less than the snapshot's 600
          session('s2', Date.parse('2026-10-25T09:00:00Z') / 1000, 900), // a day only sessions know
        ],
      }),
    });
    expect(res.status).toBe(200);
    const { body } = await get(`/api/v1/stats/books/${A}/activity`);
    expect(body.days).toEqual([
      expect.objectContaining({ day: '2026-10-23', seconds: 600 }),
      expect.objectContaining({ day: '2026-10-25', seconds: 900 }),
    ]);
    expect(body.reading_days).toEqual(['2026-10-23', '2026-10-25']);
  });

  it('buckets syncs in the client timezone', async () => {
    const { progress, get } = await setup();
    await progress(A, 0.1, 'boox', 1779663600); // 2026-05-24T23:00:00Z
    const { body } = await get(`/api/v1/stats/books/${A}/activity?tz=-120`); // UTC+2
    expect(body.reading_days).toEqual(['2026-05-25']);
  });

  it('is 404 for a book the server knows nothing about, and 403 for a malformed key', async () => {
    const { get } = await setup();
    expect((await get(`/api/v1/stats/books/${UNKNOWN}/activity`)).status).toBe(404);
    expect((await get('/api/v1/stats/books/bad!key/activity')).status).toBe(403);
  });
});

describe('GET /api/v1/stats/activity/books', () => {
  it('returns several books at once, naming the requested hashes each one answers', async () => {
    const { app, headers, progress, stats, get } = await setup();
    await progress(A, 0.1, 'boox', MAY_24);
    await stats('x4', [book(B, { daily: [{ date: '2026-10-23', seconds: 600 }] })]);
    await app.request('/api/v1/documents/merge', { method: 'POST', headers, body: JSON.stringify({ document: B, into: A }) });

    const { status, body } = await get(`/api/v1/stats/activity/books?documents=${A},${B},${UNKNOWN}`);
    expect(status).toBe(200);
    expect(body.books).toHaveLength(1);
    expect(body.books[0]).toMatchObject({ document: A, requested: [A, B] });
    expect(body.books[0].reading_days).toEqual(['2026-05-24', '2026-10-23']);
  });

  it('rejects an empty, oversized or malformed list', async () => {
    const { get } = await setup();
    expect((await get('/api/v1/stats/activity/books')).status).toBe(403);
    expect((await get(`/api/v1/stats/activity/books?documents=${Array(51).fill(0).map((_, i) => i.toString(16).padStart(32, '0')).join(',')}`)).status).toBe(403);
    expect((await get('/api/v1/stats/activity/books?documents=bad!key')).status).toBe(403);
  });
});
