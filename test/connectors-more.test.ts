import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import type { HttpTransport } from '../src/connectors/types.js';
import { drainQueue } from '../src/connectors/runner.js';
import { claimReady } from '../src/connectors/queue.js';
import { kosyncConnector, baseUrl } from '../src/connectors/kosync.js';
import { bookfusionConnector, extractBooks } from '../src/connectors/bookfusion.js';
import { hardcoverConnector } from '../src/connectors/hardcover.js';
import { audiobookshelfConnector, baseUrl as absBaseUrl } from '../src/connectors/audiobookshelf.js';
import { pollConnector } from '../src/connectors/fanin.js';
import { saveMatch } from '../src/connectors/store.js';

function fakeTransport() {
  const calls: { url: string; method: string; body?: string }[] = [];
  const handlers: { match: string; status: number; body: unknown }[] = [];
  const t: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const h = [...handlers].reverse().find((x) => url.includes(x.match) || (init.body ?? '').includes(x.match));
    const status = h?.status ?? 200;
    const body = h?.body ?? {};
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body };
  };
  return { transport: t, calls, on: (m: string, s: number, b: unknown) => handlers.push({ match: m, status: s, body: b }) };
}

const KEY = { TOKEN_ENC_KEY: 'a'.repeat(64) };
beforeEach(() => { Object.assign(process.env, KEY); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });

describe('kosync mirror connector (unit)', () => {
  it('normalizes server URLs', () => {
    expect(baseUrl('sync.koreader.rocks:443')).toBe('https://sync.koreader.rocks:443');
    expect(baseUrl('https://x.com/')).toBe('https://x.com');
  });

  it('matches by identity (no network, same document hash)', async () => {
    const fake = fakeTransport();
    const m = await kosyncConnector.match({ server: 's', username: 'u', password: 'p' }, { document: DOC, title: null, author: null, filename: null }, fake.transport);
    expect(m).toEqual({ externalId: DOC, confidence: 1 });
    expect(fake.calls).toHaveLength(0);
  });

  it('validate hits /users/auth with x-auth headers', async () => {
    const fake = fakeTransport();
    fake.on('/users/auth', 200, {});
    const v = await kosyncConnector.validate({ server: 'srv.test', username: 'u', password: 'p' }, fake.transport);
    expect(v.ok).toBe(true);
    expect(fake.calls[0].url).toContain('/users/auth');
  });

  it('push forwards progress string + position to the target', async () => {
    const fake = fakeTransport();
    fake.on('/syncs/progress', 200, {});
    const r = await kosyncConnector.push(
      { server: 'srv.test', username: 'u', password: 'p' },
      { externalId: DOC, confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.4, progress: '/body/p[1]', position: { pctQ: 400000 }, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    const body = JSON.parse(fake.calls[0].body!);
    expect(body).toMatchObject({ document: DOC, progress: '/body/p[1]', percentage: 0.4, position: { pctQ: 400000 } });
  });
});

describe('kosync mirror fan-out (end to end)', () => {
  it('a device progress push enqueues + delivers to the mirror', async () => {
    const fake = fakeTransport();
    fake.on('/users/auth', 200, {}); // validate on link
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    // Link an external kosync mirror.
    const link = await app.request('/api/v1/connectors/kosync', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { server: 'mirror.test', username: 'u', password: 'p' } }),
    });
    expect(link.status).toBe(200);
    // Device pushes progress.
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: '/body/p[2]', percentage: 0.5, device_id: 'd1' }),
    });
    expect(claimReady(db, 10).length).toBeGreaterThan(0);
    fake.on('/syncs/progress', 200, {});
    await drainQueue(db, fake.transport, 10);
    // A mirror PUT to the target server happened.
    expect(fake.calls.some((c) => c.url.includes('mirror.test') && c.url.includes('/syncs/progress') && c.method === 'PUT')).toBe(true);
    expect(claimReady(db, 10)).toHaveLength(0);
  });
});

describe('audiobookshelf connector', () => {
  const CRED = { server: 'abs.test', token: 'k' };

  it('normalizes server URLs', () => {
    expect(absBaseUrl('abs.test')).toBe('https://abs.test');
    expect(absBaseUrl('http://abs.test/')).toBe('http://abs.test');
  });

  it('validates via /api/me', async () => {
    const fake = fakeTransport();
    fake.on('/api/me', 200, { username: 'julia' });
    const v = await audiobookshelfConnector.validate(CRED, fake.transport);
    expect(v.ok).toBe(true);
    expect(v.accountLabel).toContain('julia');
  });

  it('matches a book by title/author across book libraries', async () => {
    const fake = fakeTransport();
    fake.on('/api/libraries', 200, { libraries: [{ id: 'lib1', mediaType: 'book' }, { id: 'pods', mediaType: 'podcast' }] });
    fake.on('/search', 200, {
      book: [{ libraryItem: { id: 'li_1', media: { duration: 36000, metadata: { title: 'Foundryside', authorName: 'Robert Jackson Bennett' } } } }],
    });
    const m = await audiobookshelfConnector.match(CRED, { document: 'd', title: 'Foundryside', author: 'Robert Jackson Bennett', filename: null }, fake.transport);
    expect(m?.externalId).toBe('li_1');
    expect(m?.externalEdition).toBe('36000'); // duration cached
    // Only the book library was searched, not the podcast one.
    expect(fake.calls.filter((c) => c.url.includes('/search'))).toHaveLength(1);
  });

  it('push maps percentage to currentTime = pct * duration', async () => {
    const fake = fakeTransport();
    fake.on('/api/me/progress/li_1', 200, {});
    const r = await audiobookshelfConnector.push(
      CRED,
      { externalId: 'li_1', externalEdition: '36000', confidence: 1 },
      { kind: 'progress', document: 'd', percentage: 0.5, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    const call = fake.calls.find((c) => c.url.includes('/api/me/progress/li_1'));
    expect(call?.method).toBe('PATCH');
    const body = JSON.parse(call!.body!);
    // In-progress: send progress + currentTime, and OMIT isFinished (ABS ignores
    // `progress` when isFinished:false is present).
    expect(body).toMatchObject({ progress: 0.5, currentTime: 18000, duration: 36000 });
    expect(body.isFinished).toBeUndefined();
  });

  it('fetches item duration when not cached on the match', async () => {
    const fake = fakeTransport();
    fake.on('/api/items/li_1', 200, { media: { duration: 1000 } });
    fake.on('/api/me/progress/li_1', 200, {});
    const r = await audiobookshelfConnector.push(
      CRED,
      { externalId: 'li_1', externalEdition: null, confidence: 1 },
      { kind: 'finished', document: 'd', percentage: 1, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    const body = JSON.parse(fake.calls.find((c) => c.url.includes('/api/me/progress/li_1'))!.body!);
    expect(body).toMatchObject({ currentTime: 1000, duration: 1000, isFinished: true });
  });

  it('still updates progress when no duration can be resolved', async () => {
    const fake = fakeTransport();
    // Item lookup returns no duration and no audio files.
    fake.on('/api/items/li_1', 200, { media: {} });
    fake.on('/api/me/progress/li_1', 200, {});
    const r = await audiobookshelfConnector.push(
      CRED,
      { externalId: 'li_1', externalEdition: null, confidence: 1 },
      { kind: 'progress', document: 'd', percentage: 0.42, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    const call = fake.calls.find((c) => c.url.includes('/api/me/progress/li_1'));
    expect(call?.method).toBe('PATCH');
    const body = JSON.parse(call!.body!);
    // Sends the progress fraction directly; omits currentTime/duration and
    // isFinished (ABS drops `progress` if isFinished:false is present).
    expect(body).toMatchObject({ progress: 0.42 });
    expect(body.duration).toBeUndefined();
    expect(body.currentTime).toBeUndefined();
    expect(body.isFinished).toBeUndefined();
  });

  it('resolveEdition fetches and stringifies the item duration', async () => {
    const fake = fakeTransport();
    fake.on('/api/items/li_1', 200, { media: { duration: 7200 } });
    const ed = await audiobookshelfConnector.resolveEdition!(CRED, 'li_1', fake.transport);
    expect(ed).toBe('7200');
  });

  it('sums audio file durations when media.duration is absent', async () => {
    const fake = fakeTransport();
    fake.on('/api/items/li_1', 200, { media: { audioFiles: [{ duration: 600 }, { duration: 400 }] } });
    fake.on('/api/me/progress/li_1', 200, {});
    const r = await audiobookshelfConnector.push(
      CRED,
      { externalId: 'li_1', externalEdition: null, confidence: 1 },
      { kind: 'progress', document: 'd', percentage: 0.5, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    const body = JSON.parse(fake.calls.find((c) => c.url.includes('/api/me/progress/li_1'))!.body!);
    expect(body).toMatchObject({ currentTime: 500, duration: 1000, progress: 0.5 });
  });
});

describe('audiobookshelf fan-in (audiobook -> ebook)', () => {
  const CRED = { server: 'abs.test', token: 'k' };

  it('pullChanges emits book progress updated since the cursor', async () => {
    const fake = fakeTransport();
    fake.on('/api/me', 200, {
      mediaProgress: [
        { libraryItemId: 'li_1', progress: 0.6, isFinished: false, lastUpdate: 2000, episodeId: null },
        { libraryItemId: 'li_old', progress: 0.2, isFinished: false, lastUpdate: 500, episodeId: null },
        { libraryItemId: 'ep_x', progress: 0.9, isFinished: false, lastUpdate: 3000, episodeId: 'ep_x' },
      ],
    });
    const changes = await audiobookshelfConnector.pullChanges!(CRED, fake.transport, 1000);
    // Only li_1 (newer than cursor, and a book not a podcast episode).
    expect(changes).toEqual([{ externalId: 'li_1', percentage: 0.6, finished: false, updatedAtMs: 2000 }]);
  });

  it('poller writes the audiobook position to canonical progress and fans out to others (not ABS)', async () => {
    const fake = fakeTransport();
    fake.on('/api/me', 200, { username: 'julia' });
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const userId = 1;
    // Link ABS and a second write connector (kosync mirror) to receive fan-out.
    await app.request('/api/v1/connectors/audiobookshelf', {
      method: 'PUT', headers, body: JSON.stringify({ credential: { server: 'abs.test', token: 'k' } }),
    });
    fake.on('/users/auth', 200, {});
    await app.request('/api/v1/connectors/kosync', {
      method: 'PUT', headers, body: JSON.stringify({ credential: { server: 'mirror.test', username: 'u', password: 'p' } }),
    });
    // Pre-seed the ABS match: our DOC <-> ABS library item li_1.
    saveMatch(db, userId, 'audiobookshelf', DOC, { externalId: 'li_1', confidence: 1 }, 'manual');
    // Device is at 20%; ABS (audiobook) advanced to 60%.
    await app.request('/syncs/progress', {
      method: 'PUT', headers,
      body: JSON.stringify({ document: DOC, progress: 'p', percentage: 0.2, device_id: 'reader' }),
    });
    fake.on('/api/me', 200, { mediaProgress: [{ libraryItemId: 'li_1', progress: 0.6, isFinished: false, lastUpdate: 5000, episodeId: null }] });
    // Clear whatever the device's own 0.2% sync queued, so we only observe fan-in.
    db.prepare('DELETE FROM connector_queue').run();

    const applied = await pollConnector(db, userId, 'audiobookshelf', fake.transport);
    expect(applied).toBe(1);

    // Canonical progress now reflects the audiobook position (newest wins).
    const got = await (await app.request(`/syncs/progress/${DOC}`, { headers })).json();
    expect(got.percentage).toBe(0.6);
    expect(got.device_id).toBe('audiobookshelf');

    // Fan-out queued to the OTHER connector (kosync mirror), not back to ABS.
    const queued = db.prepare('SELECT connector_id FROM connector_queue WHERE user_id = ?').all(userId) as { connector_id: string }[];
    const targets = queued.map((q) => q.connector_id);
    expect(targets).toContain('kosync');
    expect(targets).not.toContain('audiobookshelf');
  });

  it('maps a percentage-only fan-in to the nearest real device position (not a synthetic string)', async () => {
    const fake = fakeTransport();
    fake.on('/api/me', 200, { username: 'julia' });
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const userId = 1;
    await app.request('/api/v1/connectors/audiobookshelf', {
      method: 'PUT', headers, body: JSON.stringify({ credential: { server: 'abs.test', token: 'k' } }),
    });
    saveMatch(db, userId, 'audiobookshelf', DOC, { externalId: 'li_1', confidence: 1 }, 'manual');
    // A real KOReader device pushed an xpointer at ~38%; ABS advances to 62%.
    const XPOINTER = '/body/DocFragment[11]/body/div[1]/p[3]';
    await app.request('/syncs/progress', {
      method: 'PUT', headers,
      body: JSON.stringify({ document: DOC, progress: XPOINTER, percentage: 0.38, device_id: 'kindle' }),
    });
    fake.on('/api/me', 200, { mediaProgress: [{ libraryItemId: 'li_1', progress: 0.62, isFinished: false, lastUpdate: 8000, episodeId: null }] });
    db.prepare('DELETE FROM connector_queue').run();

    const applied = await pollConnector(db, userId, 'audiobookshelf', fake.transport);
    expect(applied).toBe(1);

    // The pulled progress carries the real xpointer (nearest sample), so stock
    // KOReader can seek to it, while percentage reflects the audiobook position.
    const got = await (await app.request(`/syncs/progress/${DOC}`, { headers })).json();
    expect(got.percentage).toBe(0.62);
    expect(got.progress).toBe(XPOINTER);
    expect(got.progress).not.toContain('audiobookshelf:');
  });

  it('epsilon-suppresses an echo of our own pushed value', async () => {
    const fake = fakeTransport();
    fake.on('/api/me', 200, { username: 'julia' });
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const userId = 1;
    await app.request('/api/v1/connectors/audiobookshelf', {
      method: 'PUT', headers, body: JSON.stringify({ credential: { server: 'abs.test', token: 'k' } }),
    });
    saveMatch(db, userId, 'audiobookshelf', DOC, { externalId: 'li_1', confidence: 1 }, 'manual');
    // Our stored progress is 0.40; ABS reports 0.401 (an echo of what we pushed).
    await app.request('/syncs/progress', {
      method: 'PUT', headers,
      body: JSON.stringify({ document: DOC, progress: 'p', percentage: 0.4, device_id: 'reader' }),
    });
    fake.on('/api/me', 200, { mediaProgress: [{ libraryItemId: 'li_1', progress: 0.401, isFinished: false, lastUpdate: 9000, episodeId: null }] });
    const applied = await pollConnector(db, userId, 'audiobookshelf', fake.transport);
    expect(applied).toBe(0); // within epsilon -> ignored
  });
});

describe('candidates-first matching + metadata backfill', () => {
  async function linkHardcover(app: ReturnType<typeof makeTestApp>['app'], headers: Record<string, string>, fake: ReturnType<typeof fakeTransport>) {
    fake.on('username', 200, { data: { me: [{ username: 'julia' }] } });
    const r = await app.request('/api/v1/connectors/hardcover', {
      method: 'PUT', headers, body: JSON.stringify({ credential: { token: 'hc' } }),
    });
    expect(r.status).toBe(200);
  }

  it('matches from the "currently reading" list before catalog search', async () => {
    const fake = fakeTransport();
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await linkHardcover(app, headers, fake);
    await app.request('/api/v1/documents', {
      method: 'PUT', headers,
      body: JSON.stringify({ items: [{ document: DOC, title: 'Foundryside', author: 'Robert Jackson Bennett' }] }),
    });
    // Currently-reading has the right book (id 99); search would return a wrong one.
    fake.on('CurrentlyReading', 200, { data: { me: [{ user_books: [{ book: { id: 99, title: 'Foundryside', contributions: [{ author: { name: 'Robert Jackson Bennett' } }] } }] }] } });
    fake.on('Search', 200, { data: { search: { results: [{ document: { id: 1, title: 'Something Else' } }] } } });

    const res = await app.request(`/api/v1/connectors/hardcover/rematch/${DOC}`, { method: 'POST', headers });
    expect(res.status).toBe(200);
    expect((await res.json()).match.externalId).toBe('99');
    // It resolved from currently-reading, so no Search call was made.
    expect(fake.calls.some((c) => c.body?.includes('query Search'))).toBe(false);
  });

  it('a manual match backfills the book title for a metadata-less document', async () => {
    const fake = fakeTransport();
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await linkHardcover(app, headers, fake);
    // Sync progress with NO metadata -> documents has no title.
    await app.request('/syncs/progress', {
      method: 'PUT', headers,
      body: JSON.stringify({ document: DOC, progress: 'p', percentage: 0.3, device_id: 'd1' }),
    });
    let docs = await (await app.request('/api/v1/documents', { headers })).json();
    expect(docs.items.find((d: { document: string }) => d.document === DOC)?.title ?? null).toBeNull();

    // Manually match to a Hardcover record with a title -> backfills metadata.
    const set = await app.request(`/api/v1/connectors/hardcover/matches/${DOC}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ external_id: '42', title: 'Foundryside', author: 'Robert Jackson Bennett' }),
    });
    expect(set.status).toBe(200);
    docs = await (await app.request('/api/v1/documents', { headers })).json();
    const row = docs.items.find((d: { document: string }) => d.document === DOC);
    expect(row.title).toBe('Foundryside');
    expect(row.author).toBe('Robert Jackson Bennett');
  });

  it('review endpoint lists synced books with match state', async () => {
    const fake = fakeTransport();
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await linkHardcover(app, headers, fake);
    await app.request('/syncs/progress', {
      method: 'PUT', headers,
      body: JSON.stringify({ document: DOC, progress: 'p', percentage: 0.3, device_id: 'd1', metadata: { title: 'Foundryside', authors: 'RJB' } }),
    });
    const review = await (await app.request('/api/v1/connectors/hardcover/review', { headers })).json();
    expect(review.books).toHaveLength(1);
    expect(review.books[0]).toMatchObject({ document: DOC, title: 'Foundryside', matched: false });
  });
});

describe('backfill / "Sync now"', () => {
  it('enqueues existing progress for a newly linked connector', async () => {
    const fake = fakeTransport();
    fake.on('/users/auth', 200, {});
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    for (const [doc, pct] of [
      ['a'.repeat(32), 0.4],
      ['b'.repeat(32), 0.99],
    ] as const) {
      await app.request('/syncs/progress', {
        method: 'PUT',
        headers,
        body: JSON.stringify({ document: doc, progress: 'p', percentage: pct, device_id: 'd1' }),
      });
    }
    await app.request('/api/v1/connectors/kosync', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { server: 'mirror.test', username: 'u', password: 'p' } }),
    });
    expect(claimReady(db, 10)).toHaveLength(0);
    const res = await app.request('/api/v1/connectors/kosync/sync', { method: 'POST', headers });
    expect(res.status).toBe(200);
    expect((await res.json()).queued).toBe(2);
    expect(claimReady(db, 10)).toHaveLength(2);
    fake.on('/syncs/progress', 200, {});
    await drainQueue(db, fake.transport, 10);
    expect(fake.calls.filter((c) => c.url.includes('mirror.test') && c.method === 'PUT')).toHaveLength(2);
  });

  it('sync on an unlinked connector is a 400', async () => {
    const fake = fakeTransport();
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const res = await app.request('/api/v1/connectors/kosync/sync', { method: 'POST', headers });
    expect(res.status).toBe(400);
  });
});

describe('hardcover progress push', () => {
  it('adds the book and starts a dated read when it is not on a shelf', async () => {
    const fake = fakeTransport();
    fake.on('Ctx', 200, {
      data: {
        me: [{ user_books: [] }],
        books_by_pk: { default_ebook_edition: { id: 5, pages: 400 }, default_physical_edition: null },
        editions: [],
      },
    });
    fake.on('SetStatus', 200, { data: { insert_user_book: { user_book: { id: 10 } } } });
    fake.on('InsRead', 200, {
      data: { insert_user_book_read: { error: null, user_book_read: { id: 99 } } },
    });

    const r = await hardcoverConnector.push(
      { token: 't' },
      { externalId: '42', confidence: 1 },
      { kind: 'progress', document: 'd', percentage: 0.5, timestamp: 1_754_000_000 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    const status = fake.calls.find((c) => c.body?.includes('SetStatus'));
    expect(status!.body).toContain('"statusId":2'); // Currently Reading
    const readCall = fake.calls.find((c) => c.body?.includes('InsRead'));
    expect(readCall!.body).toContain('"pages":200');
    expect(readCall!.body).toContain('"editionId":5');
    expect(readCall!.body).toContain('"startedAt":"2025-07-31"'); // dated read
  });

  it('does NOT re-mark status when the book is already Currently Reading', async () => {
    const fake = fakeTransport();
    fake.on('Ctx', 200, {
      data: {
        me: [{
          user_books: [{
            id: 10, status_id: 2, edition: { id: 5, pages: 300 },
            user_book_reads: [{ id: 77, started_at: '2026-08-08', finished_at: null, edition: { id: 5, pages: 300 } }],
          }],
        }],
        books_by_pk: {}, editions: [],
      },
    });
    fake.on('UpdRead', 200, { data: { update_user_book_read: { error: null, user_book_read: { id: 77 } } } });

    const r = await hardcoverConnector.push(
      { token: 't' },
      { externalId: '42', confidence: 1 },
      { kind: 'progress', document: 'd', percentage: 0.5, timestamp: 1_754_000_000 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    // The whole point: no status mutation of any kind when already reading.
    expect(fake.calls.some((c) => c.body?.includes('SetStatus'))).toBe(false);
    expect(fake.calls.some((c) => c.body?.includes('UpdStatus'))).toBe(false);
    // The existing read is updated in place, and its start date is passed back
    // unchanged (Hardcover's read mutation replaces the record, so omitting
    // started_at would wipe it).
    const upd = fake.calls.find((c) => c.body?.includes('UpdRead'));
    expect(upd!.body).toContain('"id":77');
    expect(upd!.body).toContain('"pages":150');
    expect(upd!.body).toContain('"startedAt":"2026-08-08"'); // preserved, not wiped
  });

  it('backfills a start date when the open read has none', async () => {
    const fake = fakeTransport();
    fake.on('Ctx', 200, {
      data: {
        me: [{
          user_books: [{
            id: 10, status_id: 2, edition: { id: 5, pages: 300 },
            user_book_reads: [{ id: 77, started_at: null, finished_at: null, edition: { id: 5, pages: 300 } }],
          }],
        }],
        books_by_pk: {}, editions: [],
      },
    });
    fake.on('UpdRead', 200, { data: { update_user_book_read: { error: null, user_book_read: { id: 77 } } } });

    const r = await hardcoverConnector.push(
      { token: 't' },
      { externalId: '42', confidence: 1 },
      { kind: 'progress', document: 'd', percentage: 0.5, timestamp: 1_754_000_000 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    const upd = fake.calls.find((c) => c.body?.includes('UpdRead'));
    expect(upd!.body).toContain('"id":77');
    expect(upd!.body).toContain('"startedAt":"2025-07-31"'); // backfilled
  });

  it('finishing a reading book advances status to Read and updates the read', async () => {
    const fake = fakeTransport();
    fake.on('Ctx', 200, {
      data: {
        me: [{
          user_books: [{
            id: 10, status_id: 2, edition: { id: 5, pages: 300 },
            user_book_reads: [{ id: 77, started_at: '2026-08-08', finished_at: null, edition: { id: 5, pages: 300 } }],
          }],
        }],
        books_by_pk: {}, editions: [],
      },
    });
    fake.on('UpdStatus', 200, { data: { update_user_book: { user_book: { id: 10 } } } });
    fake.on('UpdRead', 200, { data: { update_user_book_read: { error: null, user_book_read: { id: 77 } } } });

    const r = await hardcoverConnector.push(
      { token: 't' },
      { externalId: '42', confidence: 1 },
      { kind: 'progress', document: 'd', percentage: 1, timestamp: 1_754_000_000 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    const st = fake.calls.find((c) => c.body?.includes('UpdStatus'));
    expect(st!.body).toContain('"statusId":3'); // Read
    const upd = fake.calls.find((c) => c.body?.includes('UpdRead'));
    expect(upd!.body).toContain('"pages":300');
  });

  it('updates Hardcover\'s auto-created read after a status change instead of inserting a duplicate', async () => {
    const fake = fakeTransport();
    // Book is "want to read" (status 1) with no open read yet.
    fake.on('Ctx', 200, {
      data: {
        me: [{ user_books: [{ id: 10, status_id: 1, edition: { id: 5, pages: 300 }, user_book_reads: [] }] }],
        books_by_pk: {}, editions: [],
      },
    });
    fake.on('UpdStatus', 200, { data: { update_user_book: { user_book: { id: 10 } } } });
    // After we set it to reading, Hardcover auto-created read 555.
    fake.on('OpenRead', 200, {
      data: { me: [{ user_books: [{ user_book_reads: [{ id: 555, started_at: null, finished_at: null, edition: { id: 5, pages: 300 } }] }] }] },
    });
    fake.on('UpdRead', 200, { data: { update_user_book_read: { error: null, user_book_read: { id: 555 } } } });

    const r = await hardcoverConnector.push(
      { token: 't' },
      { externalId: '42', confidence: 1 },
      { kind: 'progress', document: 'd', percentage: 0.5, timestamp: 1_754_000_000 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    // We advance status and then UPDATE the auto-created read - never insert one.
    expect(fake.calls.some((c) => c.body?.includes('UpdStatus'))).toBe(true);
    expect(fake.calls.some((c) => c.body?.includes('InsRead'))).toBe(false);
    const upd = fake.calls.find((c) => c.body?.includes('UpdRead'));
    expect(upd!.body).toContain('"id":555');
    expect(upd!.body).toContain('"pages":150');
  });

  it('still succeeds (status only) when no edition has a page count', async () => {
    const fake = fakeTransport();
    fake.on('Ctx', 200, { data: { me: [{ user_books: [] }], books_by_pk: {}, editions: [] } });
    fake.on('SetStatus', 200, { data: { insert_user_book: { user_book: { id: 10 } } } });
    const r = await hardcoverConnector.push(
      { token: 't' },
      { externalId: '42', confidence: 1 },
      { kind: 'progress', document: 'd', percentage: 0.5, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    expect(r.ok && r.note).toMatch(/page count/);
    expect(
      fake.calls.some((c) => c.body?.includes('InsRead') || c.body?.includes('UpdRead'))
    ).toBe(false);
  });

  it('falls back to any book edition with a page count (not just the default)', async () => {
    const fake = fakeTransport();
    // No user edition, no default editions - but the book has a paged edition.
    fake.on('Ctx', 200, {
      data: {
        me: [{ user_books: [{ id: 10, status_id: 2, edition: null, user_book_reads: [{ id: 77, started_at: '2026-08-01', finished_at: null, edition: null }] }] }],
        books_by_pk: { default_ebook_edition: null, default_physical_edition: null },
        editions: [{ id: 900, pages: 500 }],
      },
    });
    fake.on('UpdRead', 200, { data: { update_user_book_read: { error: null, user_book_read: { id: 77 } } } });

    const r = await hardcoverConnector.push(
      { token: 't' },
      { externalId: '42', confidence: 1 },
      { kind: 'progress', document: 'd', percentage: 0.5, timestamp: 1_754_000_000 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    const upd = fake.calls.find((c) => c.body?.includes('UpdRead'));
    expect(upd!.body).toContain('"editionId":900');
    expect(upd!.body).toContain('"pages":250'); // 50% of 500
  });
});

describe('bookfusion connector', () => {
  it('extractBooks handles the search payload', () => {
    const hits = extractBooks({ books: [{ id: 7, title: 'Foundryside', authors: [{ name: 'Robert Jackson Bennett' }] }] });
    expect(hits).toEqual([{ externalId: '7', title: 'Foundryside', author: 'Robert Jackson Bennett' }]);
  });

  it('device-code begin + poll yields a credential', async () => {
    const fake = fakeTransport();
    fake.on('/api/user/auth/device', 200, { device_code: 'DC', user_code: 'WXYZ', verification_uri: 'https://bookfusion.com/link', interval: 1, expires_in: 900 });
    const start = await bookfusionConnector.beginLink!(fake.transport);
    expect(start).toMatchObject({ deviceCode: 'DC', userCode: 'WXYZ' });

    fake.on('/api/user/auth/token', 200, { error: 'authorization_pending' });
    expect((await bookfusionConnector.pollLink!('DC', fake.transport)).status).toBe('pending');
    fake.on('/api/user/auth/token', 200, { access_token: 'BF-TOKEN' });
    const done = await bookfusionConnector.pollLink!('DC', fake.transport);
    expect(done.status).toBe('ok');
    expect(done.credential).toEqual({ access_token: 'BF-TOKEN' });
  });

  it('link/begin + link/poll endpoints link the account', async () => {
    const fake = fakeTransport();
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    fake.on('/api/user/auth/device', 200, { device_code: 'DC', user_code: 'WXYZ', verification_uri: 'https://bookfusion.com/link' });
    const begin = await app.request('/api/v1/connectors/bookfusion/link/begin', { method: 'POST', headers });
    expect(begin.status).toBe(200);
    const { device_code } = await begin.json();

    fake.on('/api/user/auth/token', 200, { access_token: 'BF-TOKEN' });
    fake.on('/api/user/books/search', 200, {}); // validate
    const poll = await app.request('/api/v1/connectors/bookfusion/link/poll', {
      method: 'POST',
      headers,
      body: JSON.stringify({ device_code }),
    });
    expect(poll.status).toBe(200);
    expect((await poll.json()).linked).toBe(true);

    const list = await (await app.request('/api/v1/connectors', { headers })).json();
    expect(list.connectors.find((c: { id: string }) => c.id === 'bookfusion').linked).toBe(true);
  });

  it('rejects device-link begin over non-loopback HTTP', async () => {
    const fake = fakeTransport();
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    fake.on('/api/user/auth/device', 200, {
      device_code: 'DC', user_code: 'WXYZ', verification_uri: 'https://bookfusion.com/link',
    });

    const begin = await app.request(
      'http://sync.example.com/api/v1/connectors/bookfusion/link/begin',
      { method: 'POST', headers }
    );

    expect(begin.status).toBe(400);
    expect(await begin.json()).toMatchObject({ message: expect.stringContaining('HTTPS') });
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects device-link poll over non-loopback HTTP without storing the credential', async () => {
    const fake = fakeTransport();
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    fake.on('/api/user/auth/token', 200, { access_token: 'BF-TOKEN' });
    fake.on('/api/user/books/search', 200, {});

    const poll = await app.request(
      'http://sync.example.com/api/v1/connectors/bookfusion/link/poll',
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ device_code: 'DC' }),
      }
    );

    expect(poll.status).toBe(400);
    expect(await poll.json()).toMatchObject({ message: expect.stringContaining('HTTPS') });
    expect(fake.calls).toHaveLength(0);
    const list = await (await app.request('/api/v1/connectors', { headers })).json();
    expect(list.connectors.find((c: { id: string }) => c.id === 'bookfusion').linked).toBe(false);
  });

  it('push maps 0..1 to 0..100 reading_position', async () => {
    const fake = fakeTransport();
    fake.on('/reading_position', 200, {});
    const r = await bookfusionConnector.push(
      { access_token: 't' },
      { externalId: '7', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.25, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    expect(JSON.parse(fake.calls[0].body!).percentage).toBe(25);
  });
});

describe('hardcover connector (unit)', () => {
  it('validate fails when the API accepts the request but returns no account', async () => {
    const fake = fakeTransport();
    fake.on('me', 200, { data: { me: [] } });
    const r = await hardcoverConnector.validate({ token: 'looks-plausible' }, fake.transport);
    expect(r.ok).toBe(false);
  });

  it('push surfaces GraphQL errors from the context query instead of silently succeeding', async () => {
    const fake = fakeTransport();
    fake.on('Ctx', 200, { errors: [{ message: 'invalid token format' }] });
    const r = await hardcoverConnector.push(
      { token: 't' },
      { externalId: '42', confidence: 1 },
      { kind: 'progress', document: DOC, percentage: 0.5, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(false);
    expect(r.error).toBe('invalid token format');
  });
});
