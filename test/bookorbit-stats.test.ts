import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { importBookorbitStats, pollBookorbitStats } from '../src/connectors/bookorbit-stats.js';
import { readBookorbitStats } from '../src/models/bookorbit-stats.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { saveMatch, upsertAccount, deleteAccount } from '../src/connectors/store.js';
import { deleteDocumentData } from '../src/models/document.js';
import { mergeDocuments } from '../src/models/merge.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import type { HttpTransport } from '../src/connectors/types.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY = 'b'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); vi.restoreAllMocks(); });
const SECOND = '1234567890abcdef1234567890abcdef';
const session = (id: number, source: string | null = 'web', start = new Date(Date.parse('2021-01-01T12:00:00Z') + (id - 1) * 600_000).toISOString(), seconds = 600) => ({
  id, source, startedAt: start, endedAt: new Date(Date.parse(start) + seconds * 1000).toISOString(), durationSeconds: seconds,
});

async function fixture(initial = [session(1)]) {
  let items = initial;
  let status = 200;
  let corrupt = false;
  let timezone = 'UTC';
  const calls: URL[] = [];
  let beforeResponse: (() => void) | undefined;
  const http: HttpTransport = async (url) => {
    const u = new URL(url); calls.push(u);
    const response = (body: unknown, code = 200) => ({ status: code, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.pathname.endsWith('/auth/login')) return response({ accessToken: 'token' });
    if (u.pathname.endsWith('/auth/me')) return response({ settings: { timezone } });
    if (u.pathname.endsWith('/sessions')) {
      const page = Number(u.searchParams.get('page'));
      const body = { items: items.slice((page - 1) * 100, page * 100), total: items.length, page, pageSize: 100 };
      beforeResponse?.(); beforeResponse = undefined;
      return response(corrupt ? {} : body, status);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const { app, db } = makeTestApp({}, { connectorTransport: http });
  const { username, headers } = await registerUser(app);
  const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
  const cred = { server: 'orbit.test', username, password: 'pw' };
  upsertAccount(db, id, 'bookorbit', cred, null);
  saveMatch(db, id, 'bookorbit', DOC, { externalId: '42', confidence: 1 }, 'manual');
  const run = () => importBookorbitStats(db, id, http);
  const refresh = async () => { db.prepare('UPDATE bookorbit_stats_sync SET refreshed_at = 0').run(); await run(); };
  const summary = async () => (await app.request('/api/v1/stats/summary', { headers })).json();
  const book = async (document = DOC) => (await app.request(`/api/v1/stats/books/${document}`, { headers })).json();
  return { app, db, id, headers, http, cred, calls, run, refresh, summary, book,
    setItems: (next: typeof items) => { items = next; }, setStatus: (next: number) => { status = next; },
    setCorrupt: (next: boolean) => { corrupt = next; }, setTimezone: (next: string) => { timezone = next; },
    onResponse: (fn: () => void) => { beforeResponse = fn; } };
}

const globalSnapshot = (seconds = 600) => ({ device_id: 'crossink-reader', device: 'CrossInk', v: 5,
  seconds, sessions: 1, pages: 10, completed: 0, tod: [seconds, 0, 0, 0], dow: [seconds, 0, 0, 0, 0, 0, 0],
  anchor_day: 0, history_b64: '', streak: 0, daily: [{ date: '2021-01-01', seconds }] });
const bookSnapshot = () => ({ device_id: 'reader', items: [{ document: DOC, v: 5, sessions: 1, seconds: 600, pages: 10,
  completed: false, avg_fwd: 0, pace_n: 0, eta: 0, start_manual: false, finish_manual: false,
  start_date: 0, finished_date: 0, tod: [600, 0, 0, 0], dow: [600, 0, 0, 0, 0, 0, 0] }] });

describe('BookOrbit historical stats', () => {
  it('imports old sessions into global, per-book and calendar stats without inventing pages', async () => {
    const f = await fixture([session(1), session(2, 'koreader', '2021-01-02T12:00:00Z')]);
    await f.run();
    expect(await f.summary()).toMatchObject({ sessions: 2, seconds: 1200, pages: 0, completed: 0, streak: 2,
      daily: [{ date: '2021-01-01', seconds: 600 }, { date: '2021-01-02', seconds: 600 }], devices: [{ device: 'BookOrbit' }] });
    expect((await f.book()).combined).toMatchObject({ seconds: 1200, sessions: 2, pages: 0, start_date: Date.parse('2021-01-01') / 1000 });
    const global = await (await f.app.request('/api/v1/stats/global', { headers: f.headers })).json();
    expect(global.devices[0].stats.daily).toHaveLength(2);
    const activity = await (await f.app.request('/api/v1/stats/activity', { headers: f.headers })).json();
    expect(activity.reading_days).toEqual(['2021-01-01', '2021-01-02']);
    expect(activity.pages_total).toBe(0);
    expect(f.db.prepare('SELECT * FROM progress_log').all()).toHaveLength(0);
  });

  it('replaces repeated imports and reconciles edits/deletions, including an empty history', async () => {
    const f = await fixture([session(1), session(2)]);
    await f.run(); await f.refresh(); await f.refresh();
    expect((await f.summary()).seconds).toBe(1200);
    f.setItems([session(1, 'web', undefined, 300)]); await f.refresh();
    expect(await f.summary()).toMatchObject({ sessions: 1, seconds: 300 });
    f.setItems([]); await f.refresh();
    expect(await f.summary()).toMatchObject({ sessions: 0, seconds: 0, daily: [] });
  });

  it('resumes a paginated backfill without exposing partial totals', async () => {
    const f = await fixture(Array.from({ length: 601 }, (_, i) => session(i + 1)));
    await f.run();
    expect((await f.summary()).seconds).toBe(0);
    expect(f.db.prepare('SELECT next_page FROM bookorbit_stats_sync').get()).toMatchObject({ next_page: 6 });
    await f.run();
    expect((await f.summary()).seconds).toBe(601 * 600);
    expect(f.calls.filter((c) => c.pathname.endsWith('/sessions')).map((c) => c.searchParams.get('page')))
      .toEqual(['1', '2', '3', '4', '5', '6', '7']);
    const cutoffs = new Set(f.calls.filter((c) => c.pathname.endsWith('/sessions')).map((c) => c.searchParams.get('dateTo')));
    expect(cutoffs.size).toBe(1);
  });

  it('keeps published stats when a refresh fails or returns malformed data', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture(); await f.run();
    f.setStatus(503); await f.refresh();
    expect((await f.summary()).seconds).toBe(600);
    f.setStatus(200); f.setCorrupt(true); await f.refresh();
    expect((await f.summary()).seconds).toBe(600);
  });

  it('restarts unstable pagination and never adds duplicate session IDs', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture([session(1), session(1)]); await f.run();
    expect((await f.summary()).sessions).toBe(0);
    expect(f.db.prepare('SELECT next_page, cutoff FROM bookorbit_stats_sync').get()).toMatchObject({ next_page: 1, cutoff: null });
    f.setItems([session(1)]); await f.run();
    expect((await f.summary()).sessions).toBe(1);
  });

  it('counts duplicate and merged document matches once globally and per book', async () => {
    const f = await fixture();
    saveMatch(f.db, f.id, 'bookorbit', SECOND, { externalId: '42', confidence: 1 }, 'manual');
    await f.run();
    expect((await f.summary()).seconds).toBe(600);
    mergeDocuments(f.db, f.id, SECOND, DOC, Math.floor(Date.now() / 1000));
    expect((await f.book()).combined.seconds).toBe(600);
    expect((await f.summary()).seconds).toBe(600);
  });

  it('retains every BookOrbit source when direct stats arrive later', async () => {
    const f = await fixture(['web', 'ios', 'watchos', 'android', 'koreader', 'kobo', 'manual', null, 'future-source']
      .map((source, i) => session(i + 1, source)));
    await f.run();
    expect((await f.summary()).seconds).toBe(5400);
    await f.app.request('/api/v1/stats/global', { method: 'PUT', headers: f.headers, body: JSON.stringify(globalSnapshot()) });
    expect(await f.summary()).toMatchObject({ seconds: 6000, sessions: 10,
      bookorbit: { excluded_sessions: 0, excluded_seconds: 0 }, daily: [{ seconds: 6000 }] });
    expect((await f.book()).combined.seconds).toBe(5400);
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM bookorbit_stats_sessions').get()).toMatchObject({ n: 9 });
  });

  it('preserves BookOrbit time when only direct per-book counters exist', async () => {
    const f = await fixture([session(1, 'koreader'), session(2)]); await f.run();
    await f.app.request('/api/v1/stats/books', { method: 'PUT', headers: f.headers, body: JSON.stringify(bookSnapshot()) });
    expect((await f.summary()).seconds).toBe(1200);
    expect((await f.book()).combined).toMatchObject({ seconds: 1800, sessions: 3, pages: 10 });
  });

  it('splits local-midnight sessions and preserves exact seconds and histogram totals', async () => {
    const f = await fixture([session(1, 'web', '2021-01-02T04:55:00Z', 600)]);
    f.setTimezone('America/New_York'); await f.run();
    const result = await f.summary();
    expect(result.daily).toEqual([{ date: '2021-01-01', seconds: 300, minutes: 5 }, { date: '2021-01-02', seconds: 300, minutes: 5 }]);
    expect(result.tod.reduce((a: number, b: number) => a + b)).toBe(600);
    expect(result.dow.reduce((a: number, b: number) => a + b)).toBe(600);
    expect(result.streak).toBe(2);
  });

  it('keeps user data isolated and discards stale responses after unlink/relink', async () => {
    const f = await fixture(); await f.run();
    const other = await registerUser(f.app);
    expect(await (await f.app.request('/api/v1/stats/summary', { headers: other.headers })).json()).toMatchObject({ seconds: 0 });
    upsertAccount(f.db, f.id, 'bookorbit', { ...f.cred, username: 'different-account' }, null);
    expect((await f.summary()).seconds).toBe(0);
    expect(f.db.prepare("SELECT * FROM connector_matches WHERE connector_id = 'bookorbit'").all()).toHaveLength(0);
    saveMatch(f.db, f.id, 'bookorbit', DOC, { externalId: '42', confidence: 1 }, 'manual');
    f.onResponse(() => deleteAccount(f.db, f.id, 'bookorbit')); await f.run();
    expect(f.db.prepare('SELECT * FROM bookorbit_stats_sessions').all()).toHaveLength(0);
    expect((await f.summary()).seconds).toBe(0);
  });

  it.each(['orbit.test', 'https://orbit.test/'])('keeps matches when the same account switches from a password to an API key at %s', async (server) => {
    const f = await fixture();
    upsertAccount(f.db, f.id, 'bookorbit', { server, apiKey: 'bok_key', username: f.cred.username }, null);
    expect(f.db.prepare("SELECT * FROM connector_matches WHERE connector_id = 'bookorbit'").all()).toHaveLength(1);
  });

  it('removes sessions when the last matching document is deleted', async () => {
    const f = await fixture(); await f.run();
    deleteDocumentData(f.db, f.id, DOC);
    expect(f.db.prepare('SELECT * FROM bookorbit_stats_sessions').all()).toHaveLength(0);
    expect(readBookorbitStats(f.db, f.id).global.seconds).toBe(0);
  });

  it('runs in the background for enabled accounts and respects disabled accounts', async () => {
    const f = await fixture();
    expect(await pollBookorbitStats(f.db, f.http)).toBe(1);
    f.db.prepare('UPDATE connector_accounts SET enabled = 0 WHERE user_id = ?').run(f.id);
    expect(await pollBookorbitStats(f.db, f.http)).toBe(0);
  });
  it('keeps the last complete generation visible throughout a large refresh', async () => {
    const f = await fixture(); await f.run();
    f.setItems(Array.from({ length: 501 }, (_, i) => session(i + 1)));
    await f.refresh();
    expect((await f.summary()).seconds).toBe(600);
    await f.run();
    expect((await f.summary()).seconds).toBe(501 * 600);
  });

  it('retries from page one when history changes between backfill passes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = await fixture(Array.from({ length: 501 }, (_, i) => session(i + 1)));
    await f.run();
    f.setItems([session(1)]); await f.run();
    expect((await f.summary()).seconds).toBe(0);
    await f.run();
    expect((await f.summary()).seconds).toBe(600);
  });

  it('counts each BookOrbit and direct-device upload once when both repeat', async () => {
    const f = await fixture([session(1), session(2, 'koreader')]);
    for (let i = 0; i < 2; i++) {
      await f.app.request('/api/v1/stats/global', { method: 'PUT', headers: f.headers, body: JSON.stringify(globalSnapshot()) });
      await f.refresh();
    }
    expect(await f.summary()).toMatchObject({ seconds: 1800, sessions: 3, daily: [{ seconds: 1800 }] });
  });

  it('uses the same session identity across two provider books', async () => {
    const f = await fixture();
    saveMatch(f.db, f.id, 'bookorbit', SECOND, { externalId: '43', confidence: 1 }, 'manual');
    await f.run();
    expect((await f.summary()).seconds).toBe(600);
  });

  it('retains shared sessions when one of two matching documents is deleted', async () => {
    const f = await fixture();
    saveMatch(f.db, f.id, 'bookorbit', SECOND, { externalId: '42', confidence: 1 }, 'manual');
    await f.run(); deleteDocumentData(f.db, f.id, DOC);
    expect((await f.book(SECOND)).combined.seconds).toBe(600);
    expect((await f.summary()).seconds).toBe(600);
  });

  it('cleans up imported sessions when the sync account is reset', async () => {
    const f = await fixture(); await f.run();
    const response = await f.app.request('/api/v1/account/data', { method: 'DELETE', headers: f.headers });
    expect(response.status).toBe(200);
    expect(f.db.prepare('SELECT * FROM bookorbit_stats_sessions').all()).toHaveLength(0);
    expect(f.db.prepare('SELECT * FROM bookorbit_stats_sync').all()).toHaveLength(0);
  });

  it('discovers historical finished local books without requiring a progress GET', async () => {
    const f = await fixture();
    f.db.prepare('DELETE FROM connector_matches').run();
    f.db.prepare("INSERT INTO documents (user_id, document, title, author, status, updated_at) VALUES (?, ?, 'Old book', 'An Author', 'read', 1)")
      .run(f.id, DOC);
    const response = (body: unknown) => ({ status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    const discoveryHttp: HttpTransport = (url, init) => {
      if (url.includes('/books/search?')) return Promise.resolve(response([{ id: 42, title: 'Old book', authors: ['An Author'], formats: ['epub'] }]));
      if (url.endsWith('/books/42')) return Promise.resolve(response({ files: [{ id: 7, format: 'epub' }] }));
      return f.http(url, init);
    };
    await pollBookorbitStats(f.db, discoveryHttp);
    expect((await f.book()).combined.seconds).toBe(600);
  });

  it('conserves seconds across daylight-saving transitions and invalid timezone fallbacks', async () => {
    const f = await fixture([session(1, 'web', '2026-11-01T05:30:00Z', 7200)]);
    f.setTimezone('America/New_York'); await f.run();
    expect((await f.summary()).daily).toEqual([{ date: '2026-11-01', seconds: 7200, minutes: 120 }]);
    f.setTimezone('not-a-timezone'); await f.refresh();
    expect((await f.summary()).seconds).toBe(7200);
  });

  it('does not restore a stale match if BookOrbit is unlinked during historical matching', async () => {
    const f = await fixture();
    f.db.prepare('DELETE FROM connector_matches').run();
    f.db.prepare("INSERT INTO documents (user_id, document, title, updated_at) VALUES (?, ?, 'Old book', 1)").run(f.id, DOC);
    const http: HttpTransport = async (url, init) => {
      if (url.includes('/books/search?')) {
        deleteAccount(f.db, f.id, 'bookorbit');
        return { status: 200, json: async () => [], text: async () => '[]' };
      }
      return f.http(url, init);
    };
    await importBookorbitStats(f.db, f.id, http);
    expect(f.db.prepare('SELECT * FROM connector_matches').all()).toHaveLength(0);
    expect(f.db.prepare('SELECT * FROM bookorbit_stats_sessions').all()).toHaveLength(0);
  });

  it('preserves Kindle reading days and time alongside CrossInk counters on the same or other days', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-22T18:00:00Z'));
    try {
      const f = await fixture([
        session(1, 'koreader', '2026-10-20T15:00:00Z', 1200),
        session(2, 'koreader', '2026-10-21T15:00:00Z', 1800),
        session(3, 'koreader', '2026-10-22T15:00:00Z', 600),
      ]);
      // CrossInk read a different book today; it supplies no per-session identity.
      const direct = { ...globalSnapshot(900), daily: [{ date: '2026-10-22', seconds: 900 }] };
      await f.app.request('/api/v1/stats/global', { method: 'PUT', headers: f.headers, body: JSON.stringify(direct) });
      await f.run();
      expect(await f.summary()).toMatchObject({ seconds: 4500, sessions: 4, current_streak: 3, streak: 3,
        daily: [{ date: '2026-10-20', seconds: 1200 }, { date: '2026-10-21', seconds: 1800 }, { date: '2026-10-22', seconds: 1500 }],
        bookorbit: { excluded_sessions: 0 } });
      expect((await f.book()).combined).toMatchObject({ seconds: 3600, sessions: 3 });
      const activity = await (await f.app.request('/api/v1/stats/activity', { headers: f.headers })).json();
      expect(activity.reading_days).toEqual(['2026-10-20', '2026-10-21', '2026-10-22']);
    } finally { vi.useRealTimers(); }
  });

  it('counts exact same-book/source/time/duration duplicates once even with different provider IDs', async () => {
    const first = session(1, 'koreader');
    const f = await fixture([first, { ...first, id: 2 }]); await f.run();
    expect(await f.summary()).toMatchObject({ seconds: 600, sessions: 1,
      daily: [{ seconds: 600 }], bookorbit: { excluded_sessions: 1, excluded_seconds: 600 } });
    expect((await f.book()).combined).toMatchObject({ seconds: 600, sessions: 1 });
    // Deduplication changes the view, not the original provider history.
    expect(f.db.prepare('SELECT COUNT(*) AS n FROM bookorbit_stats_sessions').get()).toMatchObject({ n: 2 });
    await f.refresh();
    expect((await f.summary()).seconds).toBe(600);
  });

  it('does not guess duplicates from partial overlaps, equal durations, or different sources', async () => {
    const first = session(1, 'koreader', '2021-01-01T12:00:00Z');
    const f = await fixture([
      first,
      session(2, 'koreader', '2021-01-01T12:05:00Z'),
      session(3, 'koreader', '2021-01-01T14:00:00Z'),
      { ...first, id: 4, source: 'kobo' },
      { ...first, id: 5, durationSeconds: 300 },
    ]);
    await f.run();
    expect(await f.summary()).toMatchObject({ seconds: 2700, sessions: 5, bookorbit: { excluded_sessions: 0 } });
  });

  it('keeps matching time spans in different books separate', async () => {
    const first = session(1, 'koreader');
    const f = await fixture([first]);
    saveMatch(f.db, f.id, 'bookorbit', SECOND, { externalId: '43', confidence: 1 }, 'manual');
    const http: HttpTransport = (url, init) => {
      if (url.includes('/books/43/sessions?')) return Promise.resolve({ status: 200,
        json: async () => ({ items: [{ ...first, id: 2 }], total: 1, page: 1, pageSize: 100 }), text: async () => '' });
      return f.http(url, init);
    };
    await importBookorbitStats(f.db, f.id, http);
    expect(await f.summary()).toMatchObject({ seconds: 1200, sessions: 2, bookorbit: { excluded_sessions: 0 } });
    expect((await f.book()).combined.seconds).toBe(600);
    expect((await f.book(SECOND)).combined.seconds).toBe(600);
  });

  it('keeps manual entries without a measurable span rather than guessing duplicates', async () => {
    const first = session(1, 'manual'); first.endedAt = first.startedAt;
    const f = await fixture([first, { ...first, id: 2 }]); await f.run();
    expect(await f.summary()).toMatchObject({ seconds: 1200, sessions: 2, bookorbit: { excluded_sessions: 0 } });
  });

});
