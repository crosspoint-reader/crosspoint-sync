import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';

const OTHER = 'f'.repeat(32);
const DAY = 1609502400; // 2021-01-01 12:00 UTC

describe('GET /stats/sessions/export', () => {
  it('exports measured sessions and per-day time as a firmware log the reader can upload back', async () => {
    const { app, db } = makeTestApp();
    const user = await registerUser(app);
    const id = (db.prepare('SELECT id FROM users WHERE username=?').get(user.username) as any).id;
    db.prepare('INSERT INTO documents (user_id, document, title, updated_at) VALUES (?, ?, ?, 0)').run(id, DOC, 'Dune "Messiah" ' + 'é'.repeat(50));
    const put = (device: string, items: unknown[]) => app.request('/api/v1/stats/sessions', {
      method: 'PUT', headers: user.headers, body: JSON.stringify({ device_id: device, items }) });
    expect((await put('old-reader', [{ session_id: 'a', document: DOC, started_at: DAY, ended_at: DAY + 900, seconds: 600, utc_offset_minutes: -300 }])).status).toBe(200);
    // KOReader-style days: one covered by the measured session, one only known as a total.
    const day = db.prepare('INSERT INTO stats_device_book_day (user_id, device_id, document, date, seconds, updated_at) VALUES (?, ?, ?, ?, ?, 0)');
    day.run(id, 'ko', DOC, '2021-01-01', 1000);
    day.run(id, 'ko', OTHER, '2021-01-02', 1200);

    const res = await app.request('/api/v1/stats/sessions/export', { headers: user.headers });
    expect(res.headers.get('content-disposition')).toContain('reading_sessions.jsonl');
    const lines = (await res.text()).trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(lines).toEqual([
      { doc: DOC, start: DAY, secs: 600, tz: -300, from: 0, to: 0, title: expect.any(String) },
      // 2021-01-01 (local, -300) is only 600 of KOReader's 1000 seconds: the rest is seeded.
      { doc: DOC, start: DAY - 60, secs: 400, tz: 1, from: 0, to: 0, title: expect.any(String) },
      { doc: OTHER, start: DAY + 86400 - 60, secs: 1200, tz: 1, from: 0, to: 0, title: '' },
    ].sort((a, b) => a.start - b.start));
    expect(Buffer.byteLength(lines[0].title)).toBeLessThanOrEqual(80);
    expect(lines[0].title.startsWith('Dune "Messiah" é')).toBe(true);
    expect(lines[0].title).not.toContain('�');

    // The seeded reader uploads every line under its own IDs; nothing is stored twice.
    const before = db.prepare('SELECT COUNT(*) AS n FROM reading_sessions').get() as any;
    const back = await put('crosspoint', lines.map((l, i) => ({ session_id: `${l.start}-mac${i}`, document: l.doc,
      started_at: l.start, ended_at: l.start + l.secs, seconds: l.secs, utc_offset_minutes: l.tz })));
    expect((await back.json()).accepted_session_ids).toHaveLength(3);
    expect(db.prepare('SELECT COUNT(*) AS n FROM reading_sessions').get()).toEqual(before);
  });
});

describe('GET /stats/sessions/export-link', () => {
  it('signs a header-free download of the export and nothing else', async () => {
    const { app } = makeTestApp();
    const user = await registerUser(app);
    // Readers send the typed password as the key; the server hashes it like any kosync client's.
    const link = await app.request('/api/v1/stats/sessions/export-link', { headers: user.headers });
    const { path } = await link.json();
    expect(path).toMatch(/^\/api\/v1\/stats\/sessions\/export\?tz=0&export_token=[\w.-]+$/);
    expect((await app.request(path)).status).toBe(200);
    const token = path.split('export_token=')[1];
    for (const other of [`/api/v1/stats/summary?export_token=${token}`, `${path}x`, `/api/v1/stats/sessions/export?export_token=`]) {
      expect((await app.request(other)).status).toBe(401);
    }
  });
});

describe('progress-only history', () => {
  it('estimates time from print pages, with the day\'s real progress, and says so', async () => {
    const { app, db } = makeTestApp();
    const user = await registerUser(app);
    const id = (db.prepare('SELECT id FROM users WHERE username=?').get(user.username) as any).id;
    db.prepare('INSERT INTO documents (user_id, document, title, page_count, updated_at) VALUES (?, ?, ?, 300, 0)').run(id, DOC, 'Emma');
    const log = db.prepare('INSERT INTO progress_log (user_id, document, device_id, percentage, at) VALUES (?, ?, ?, ?, ?)');
    log.run(id, DOC, 'kosync', 0.1, DAY); log.run(id, DOC, 'kosync', 0.15, DAY + 3600); // 15 print pages on 2021-01-01

    const link = await (await app.request('/api/v1/stats/sessions/export-link', { headers: user.headers })).json();
    expect(link).toMatchObject({ sessions: 1, estimated: true });
    const [line, ...rest] = (await (await app.request(link.path)).text()).trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(rest).toEqual([]);
    expect(line).toMatchObject({ doc: DOC, start: DAY - 60, tz: 1, from: 1000, to: 1500, title: 'Emma' });
    expect(line.secs).toBeGreaterThan(10 * 60);
    expect(line.secs).toBeLessThan(30 * 60);

    // An account with nothing to import says so instead of handing out an empty download.
    const empty = await registerUser(app);
    expect(await (await app.request('/api/v1/stats/sessions/export-link', { headers: empty.headers })).json())
      .toMatchObject({ sessions: 0, estimated: false });
  });
});
