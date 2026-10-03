import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import type { HttpTransport } from '../src/connectors/types.js';
import { pollConnector, pollSpotify } from '../src/connectors/fanin.js';
import { decryptCredential, getAccount, revealConnector, saveMatch, upsertAccount } from '../src/connectors/store.js';
import {
  advance,
  MIN_ADVANCE_MS,
  resetSpotifyPause,
  positionFromChapters,
  spotifyConnector,
  spotifyPosition,
  spotifyResume,
  type SpotifyChapter,
} from '../src/connectors/spotify.js';

/** Fake Spotify: "METHOD path-prefix" -> [status, body]; later routes win. */
function fakeSpotify(routes: Record<string, [number, unknown]> = {}) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const transport: HttpTransport = async (url, init) => {
    calls.push({ method: init.method, url, body: init.body });
    const path = url.replace('https://api.spotify.com/v1', '').replace('https://accounts.spotify.com', '');
    const key = Object.keys(routes).reverse().find((k) => {
      const [m, p] = k.split(' ');
      return m === init.method && path.startsWith(p);
    });
    const [status, body] = key ? routes[key] : [404, { error: { status: 404 } }];
    return {
      status, text: async () => JSON.stringify(body), json: async () => body,
      headers: { get: (h: string) => (h === 'retry-after' ? '120' : null) },
    };
  };
  return { transport, calls, routes };
}

const fresh = () => ({ access_token: 'at', refresh_token: 'rt', expires_at: Math.floor(Date.now() / 1000) + 3600 });

const ch = (id: string, duration_ms: number, fully_played = false, resume_position_ms = 0): SpotifyChapter => ({
  id, uri: `spotify:episode:${id}`, name: `Chapter ${id}`, duration_ms, resume_point: { fully_played, resume_position_ms },
});
const CHAPTERS = [ch('c1', 1000, true), ch('c2', 2000, false, 500), ch('c3', 1000)];

const REDIRECT = 'http://localhost/connectors/spotify/callback';

/** Begin a server-run sign-in; returns the state and the authorize URL's params. */
async function begin(app: any, headers: Record<string, string>, client = 'web') {
  const res = await app.request('/api/v1/connectors/spotify/oauth/begin', { method: 'POST', headers, body: JSON.stringify({ client }) });
  const body = await res.json();
  const q = res.status === 200 ? new URL(body.authorize_url).searchParams : null;
  return { res, body, q, state: q?.get('state') ?? '' };
}
/** Spotify sending the browser back to the callback page. */
const callback = (app: any, state: string, extra = 'code=c') => app.request(`/connectors/spotify/callback?state=${state}&${extra}`);

const KEY = { TOKEN_ENC_KEY: 'a'.repeat(64), SPOTIFY_CLIENT_ID: 'client-123' };
beforeEach(() => { Object.assign(process.env, KEY); resetEncryptionKeyCache(); });
afterEach(() => {
  delete process.env.TOKEN_ENC_KEY; delete process.env.SPOTIFY_CLIENT_ID; resetEncryptionKeyCache();
  resetSpotifyPause(); vi.useRealTimers();
});

describe('positionFromChapters', () => {
  it('is the first chapter not fully played, at its resume point', () => {
    const p = positionFromChapters(CHAPTERS)!;
    expect(p).toMatchObject({ chapterId: 'c2', chapterIndex: 1, chapterCount: 3, positionMs: 500, finished: false, live: false });
    expect(p.percentage).toBeCloseTo(1500 / 4000);
  });

  it('a live player on one of the chapters wins over resume points', () => {
    const p = positionFromChapters(CHAPTERS, { is_playing: true, progress_ms: 250, item: { id: 'c3' } })!;
    expect(p).toMatchObject({ chapterId: 'c3', positionMs: 250, live: true });
    expect(p.percentage).toBeCloseTo(3250 / 4000);
  });

  it('ignores a player on something else, and reports a fully played book as finished', () => {
    const done = [ch('c1', 1000, true), ch('c2', 1000, true)];
    expect(positionFromChapters(done, { is_playing: true, item: { id: 'song' } })).toMatchObject({
      chapterId: 'c2', positionMs: 1000, percentage: 1, finished: true, live: false,
    });
  });

  it('is null with no chapters (e.g. audiobooks not offered in this market)', () => {
    expect(positionFromChapters([])).toBeNull();
  });
});

describe('spotify connector', () => {
  it('offers PKCE sign-in only when a client id is set', () => {
    expect(spotifyConnector.oauth!()).toEqual({
      authorizeUrl: 'https://accounts.spotify.com/authorize',
      clientId: 'client-123',
      scopes: ['user-library-read', 'user-read-playback-position', 'user-read-playback-state', 'user-modify-playback-state'],
    });
    delete process.env.SPOTIFY_CLIENT_ID;
    expect(spotifyConnector.oauth!()).toBeNull();
  });

  it('validate exchanges the PKCE code and keeps only tokens on the credential', async () => {
    const f = fakeSpotify({
      'POST /api/token': [200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }],
      'GET /me': [200, { display_name: 'Julia', country: 'US' }],
    });
    const cred: Record<string, unknown> = { code: 'the-code', code_verifier: 'v'.repeat(64), redirect_uri: REDIRECT };
    expect(await spotifyConnector.validate(cred, f.transport)).toEqual({ ok: true, accountLabel: 'Julia' });
    const sent = new URLSearchParams(f.calls[0].body);
    expect(Object.fromEntries(sent)).toEqual({
      grant_type: 'authorization_code', code: 'the-code', redirect_uri: REDIRECT,
      client_id: 'client-123', code_verifier: 'v'.repeat(64),
    });
    expect(Object.keys(cred).sort()).toEqual(['access_token', 'expires_at', 'refresh_token']);
    expect(f.calls[1].url).toBe('https://api.spotify.com/v1/me');
  });

  it('explains a 403 from a Development mode app for users off its allowlist', async () => {
    const f = fakeSpotify({
      'POST /api/token': [200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }],
      'GET /me': [403, 'User not registered in the Developer Dashboard'],
    });
    const v = await spotifyConnector.validate({ code: 'c', code_verifier: 'v', redirect_uri: REDIRECT }, f.transport);
    expect(v.ok).toBe(false);
    expect(v.error).toMatch(/developer dashboard/i);
  });

    it('notes accounts outside the audiobook markets', async () => {
    const f = fakeSpotify({ 'GET /me': [200, { display_name: 'Ana', country: 'DE' }] });
    expect((await spotifyConnector.validate(fresh(), f.transport)).accountLabel).toBe('Ana (no Spotify audiobooks in DE)');
  });

  it('refreshes an expired token and keeps the refresh token when Spotify does not rotate it', async () => {
    const f = fakeSpotify({
      'POST /api/token': [200, { access_token: 'at2', expires_in: 3600 }],
      'GET /me': [200, { id: 'julia' }],
    });
    const cred = { access_token: 'old', refresh_token: 'rt', expires_at: 0 };
    expect((await spotifyConnector.validate(cred, f.transport)).ok).toBe(true);
    expect(cred).toMatchObject({ access_token: 'at2', refresh_token: 'rt' });
  });

  it('lists every page of saved audiobooks, and an empty library is just empty', async () => {
    const f = fakeSpotify({
      'GET /me/audiobooks?limit=50': [200, { items: [{ id: 'a1', name: 'Dune', authors: [{ name: 'Frank Herbert' }] }], next: 'https://api.spotify.com/v1/me/audiobooks?offset=50' }],
      'GET /me/audiobooks?offset=50': [200, { items: [{ audiobook: { id: 'a2', name: 'Emma', authors: [] } }], next: null }],
    });
    expect(await spotifyConnector.listCurrentlyReading!(fresh(), f.transport)).toEqual([
      { externalId: 'a1', title: 'Dune', author: 'Frank Herbert' },
      { externalId: 'a2', title: 'Emma', author: null },
    ]);
    const empty = fakeSpotify({ 'GET /me/audiobooks': [200, { items: [], next: null }] });
    expect(await spotifyConnector.listCurrentlyReading!(fresh(), empty.transport)).toEqual([]);
  });

  it('matches by title and author from catalog search', async () => {
    const f = fakeSpotify({
      'GET /search': [200, { audiobooks: { items: [
        { id: 'a1', name: 'Dune', authors: [{ name: 'Frank Herbert' }] },
        { id: 'a9', name: 'Dune Messiah', authors: [{ name: 'Frank Herbert' }] },
      ] } }],
    });
    const m = await spotifyConnector.match(fresh(), { document: DOC, title: 'Dune', author: 'Frank Herbert', filename: null }, f.transport);
    expect(m).toMatchObject({ externalId: 'a1', title: 'Dune' });
    expect(f.calls[0].url).toContain('type=audiobook');
  });

  it('never pushes: fan-out skips it and push refuses', async () => {
    expect(spotifyConnector.capabilities).toEqual({ read: true, write: false });
    expect((await spotifyConnector.push({}, { externalId: 'a1', confidence: 1 }, { kind: 'progress', document: DOC, timestamp: 0 }, fakeSpotify().transport)).ok).toBe(false);
  });

  it('reads chapters plus the live player', async () => {
    const f = fakeSpotify({
      'GET /audiobooks/a1/chapters': [200, { items: CHAPTERS, next: null }],
      'GET /me/player': [204, null],
    });
    expect(await spotifyPosition(fresh(), 'a1', f.transport)).toMatchObject({ chapterId: 'c2', positionMs: 500 });
    expect(f.calls[1].url).toBe('https://api.spotify.com/v1/me/player?additional_types=episode');
  });

  it('resume plays the chapter at the position', async () => {
    const f = fakeSpotify({
      'GET /audiobooks/a1/chapters': [200, { items: CHAPTERS, next: null }],
      'GET /me/player': [204, null],
      'PUT /me/player/play': [204, null],
    });
    expect((await spotifyResume(fresh(), 'a1', f.transport))!.ok).toBe(true);
    expect(JSON.parse(f.calls[2].body!)).toEqual({ uris: ['spotify:episode:c2'], position_ms: 500 });
  });

  it.each([
    [404, 'NO_ACTIVE_DEVICE'],
    [403, 'PREMIUM_REQUIRED'],
  ])('resume falls back to the chapter deep link on %i', async (status, reason) => {
    const f = fakeSpotify({
      'GET /audiobooks/a1/chapters': [200, { items: CHAPTERS, next: null }],
      'GET /me/player': [204, null],
      'PUT /me/player/play': [status, { error: { status, reason } }],
    });
    expect(await spotifyResume(fresh(), 'a1', f.transport)).toMatchObject({
      ok: false, reason, fallbackUrl: 'https://open.spotify.com/chapter/c2',
    });
  });
});

describe('spotify routes', () => {
  async function linked(routes: Record<string, [number, unknown]>) {
    const f = fakeSpotify({
      'POST /api/token': [200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }],
      'GET /me': [200, { display_name: 'Julia', country: 'US' }],
      ...routes,
    });
    const { app } = makeTestApp({}, { connectorTransport: f.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/spotify/reveal', { method: 'POST', headers });
    expect((await callback(app, (await begin(app, headers)).state)).status).toBe(302);
    await app.request('/api/v1/documents', {
      method: 'PUT', headers, body: JSON.stringify({ items: [{ document: DOC, title: 'Dune', author: 'Frank Herbert' }] }),
    });
    return { app, headers, f };
  }

  it('matches on demand from saved audiobooks, and returns the position', async () => {
    const { app, headers, f } = await linked({
      'GET /me/audiobooks': [200, { items: [{ id: 'a1', name: 'Dune', authors: [{ name: 'Frank Herbert' }] }], next: null }],
      'GET /audiobooks/a1/chapters': [200, { items: CHAPTERS, next: null }],
      'GET /me/player': [204, null],
    });
    const res = await app.request(`/api/v1/connectors/spotify/position/${DOC}`, { headers });
    expect(await res.json()).toMatchObject({ matched: true, external_id: 'a1', position: { chapterId: 'c2', positionMs: 500 } });
    // Never plays on its own.
    expect(f.calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('reports unmatched books (empty library outside the markets) without failing', async () => {
    const { app, headers } = await linked({
      'GET /me/audiobooks': [200, { items: [], next: null }],
      'GET /search': [200, { audiobooks: { items: [] } }],
    });
    const res = await app.request(`/api/v1/connectors/spotify/position/${DOC}`, { headers });
    expect(await res.json()).toEqual({ matched: false, position: null });
  });

  it('resume returns the fallback deep link without an active device', async () => {
    const { app, headers } = await linked({
      'GET /me/audiobooks': [200, { items: [{ id: 'a1', name: 'Dune', authors: [{ name: 'Frank Herbert' }] }], next: null }],
      'GET /audiobooks/a1/chapters': [200, { items: CHAPTERS, next: null }],
      'GET /me/player': [204, null],
      'PUT /me/player/play': [404, { error: { status: 404, reason: 'NO_ACTIVE_DEVICE' } }],
    });
    const res = await app.request(`/api/v1/connectors/spotify/resume/${DOC}`, { method: 'POST', headers });
    expect(await res.json()).toMatchObject({ ok: false, reason: 'NO_ACTIVE_DEVICE', fallback_url: 'https://open.spotify.com/chapter/c2' });
  });
});

const MIN = 60_000;
// 10 + 30 + 10 minutes: c2 starts at 20% of the book, c3 at 80%.
const book = (chapter: 1 | 2 | 3, atMin: number) => ({
  items: [
    ch('c1', 10 * MIN, chapter > 1, chapter === 1 ? atMin * MIN : 0),
    ch('c2', 30 * MIN, chapter > 2, chapter === 2 ? atMin * MIN : 0),
    ch('c3', 10 * MIN, false, chapter === 3 ? atMin * MIN : 0),
  ],
  next: null,
});
const at = (chapterIndex: number, offsetMin: number, finished = false) => ({
  ...positionFromChapters(book(1, 0).items)!, chapterIndex, offsetMs: offsetMin * MIN, finished,
});

describe('spotify snapshots', () => {
  const snap = { chapterIndex: 1, offsetMs: 15 * MIN, finished: false };

  it('first sighting is only a baseline', () => {
    expect(advance(null, at(1, 15))).toEqual({ moved: false, next: snap });
  });

  it('counts forward moves past the threshold, or into a later chapter', () => {
    expect(advance(snap, at(1, 15 + MIN_ADVANCE_MS / MIN)).moved).toBe(true);
    expect(advance({ ...snap, offsetMs: 29 * MIN }, at(2, 30.5)).moved).toBe(true);
    expect(advance(snap, at(2, 50, true)).moved).toBe(true);
  });

  it('ignores tiny forward moves without losing them: the snapshot stays put so they add up', () => {
    expect(advance(snap, at(1, 17))).toEqual({ moved: false, next: null });
  });

  it('re-baselines on a backward move without counting it', () => {
    expect(advance(snap, at(1, 12))).toEqual({ moved: false, next: { ...snap, offsetMs: 12 * MIN } });
  });
});

describe('spotify fan-in', () => {
  const T0 = Date.parse('2026-10-03T12:00:00Z');

  async function setup(readerPct = 0.1) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    const f = fakeSpotify({
      'GET /me/player': [204, null],
      'POST /api/token': [200, { access_token: 'at2', expires_in: 3600 }], // hours pass between checks
    });
    const { app, db } = makeTestApp({}, { connectorTransport: f.transport });
    const { headers } = await registerUser(app);
    const read = (percentage: number) => app.request('/syncs/progress', {
      method: 'PUT', headers, body: JSON.stringify({ document: DOC, progress: '/body/DocFragment[1]/body', percentage, device_id: 'reader' }),
    });
    await read(readerPct);
    upsertAccount(db, 1, 'spotify', fresh(), 'Julia');
    saveMatch(db, 1, 'spotify', DOC, { externalId: 'a1', confidence: 1 }, 'auto');
    const listen = (chapter: 1 | 2 | 3, atMin: number, laterMin: number) => {
      f.routes['GET /audiobooks/a1/chapters'] = [200, book(chapter, atMin)];
      vi.setSystemTime(T0 + laterMin * MIN);
      return pollConnector(db, 1, 'spotify', f.transport);
    };
    const latest = () => db.prepare('SELECT device_id, percentage, updated_at FROM progress ORDER BY updated_at DESC LIMIT 1').get();
    return { app, headers, db, f, read, listen, latest };
  }

  it('moves progress forward only on a real change, dated when we saw it', async () => {
    const { listen, latest } = await setup(0.1);
    expect(await listen(2, 1, 60)).toBe(0); // baseline (22% > reader's 10%, but no observed change)
    expect(latest()).toMatchObject({ device_id: 'reader', percentage: 0.1 });
    expect(await listen(2, 3, 120)).toBe(0); // +2 min: under the threshold
    expect(await listen(2, 5, 180)).toBe(1); // +4 min since the snapshot
    expect(latest()).toMatchObject({ device_id: 'spotify', percentage: 0.3, updated_at: (T0 + 180 * MIN) / 1000 });
  });

  it('never moves progress backward', async () => {
    const { read, listen, latest } = await setup(0.1);
    await listen(2, 1, 60);
    await read(0.9);
    expect(await listen(3, 2, 120)).toBe(0); // a new chapter (84%), but behind the reader's 90%
    expect(latest()).toMatchObject({ device_id: 'reader', percentage: 0.9 });
  });

  it('runs when a device checks progress, like BookFusion', async () => {
    const { app, headers, f } = await setup(0.1);
    f.routes['GET /audiobooks/a1/chapters'] = [200, book(2, 1)];
    await app.request(`/syncs/progress/${DOC}`, { headers }); // baseline
    f.routes['GET /audiobooks/a1/chapters'] = [200, book(2, 10)];
    vi.setSystemTime(T0 + 60 * MIN);
    const got = await (await app.request(`/syncs/progress/${DOC}`, { headers })).json();
    expect(got).toMatchObject({ device_id: 'spotify', percentage: 0.4 });
  });

  it('never plays while syncing', async () => {
    const { f, listen } = await setup();
    await listen(2, 1, 60);
    await listen(3, 1, 120);
    expect(f.calls.some((c) => c.method === 'PUT')).toBe(false);
  });
});

describe('spotify hourly job', () => {
  async function users(n: number, token: (i: number) => object = () => fresh()) {
    const f = fakeSpotify({
      'GET /me/player': [204, null],
      'GET /audiobooks/a1/chapters': [200, book(2, 1)],
      'POST /api/token': [200, { access_token: 'at2', expires_in: 3600 }],
    });
    const { app, db } = makeTestApp({}, { connectorTransport: f.transport });
    for (let i = 1; i <= n; i++) {
      await registerUser(app);
      revealConnector(db, i, 'spotify');
      upsertAccount(db, i, 'spotify', token(i), null);
      saveMatch(db, i, 'spotify', DOC, { externalId: 'a1', confidence: 1 }, 'auto');
    }
    return { db, f };
  }
  const snapshotOf = (db: any, userId: number) =>
    (db.prepare("SELECT snapshot FROM connector_matches WHERE user_id = ? AND connector_id = 'spotify'").get(userId) as any).snapshot;

  it('pulls every linked user with a matched book, one player call each', async () => {
    const { db, f } = await users(2);
    await pollSpotify(db, f.transport);
    expect(snapshotOf(db, 1)).toBeTruthy();
    expect(snapshotOf(db, 2)).toBeTruthy();
    expect(f.calls.filter((c) => c.url.includes('/me/player')).length).toBe(2);
  });

  it('refreshes expired tokens and saves them', async () => {
    const { db, f } = await users(1, () => ({ ...fresh(), expires_at: 0 }));
    await pollSpotify(db, f.transport);
    expect(decryptCredential(getAccount(db, 1, 'spotify')!).access_token).toBe('at2');
  });

  it('marks a revoked account as needing reconnect and skips it next time', async () => {
    const { db, f } = await users(1, () => ({ ...fresh(), expires_at: 0 }));
    f.routes['POST /api/token'] = [400, { error: 'invalid_grant' }];
    await pollSpotify(db, f.transport);
    expect(getAccount(db, 1, 'spotify')!.status).toBe('needs_reauth');
    const before = f.calls.length;
    await pollSpotify(db, f.transport);
    expect(f.calls.length).toBe(before);
  });

  it('stops on 429 until Retry-After, for every account', async () => {
    const { db, f } = await users(2);
    f.routes['GET /audiobooks/a1/chapters'] = [429, {}];
    await pollSpotify(db, f.transport);
    expect(f.calls.length).toBe(1); // user 1's first call; user 2 never asked
    await pollSpotify(db, f.transport);
    expect(f.calls.length).toBe(1);
  });
});

describe('spotify per-account flag', () => {
  const list = async (app: any, headers: Record<string, string>) =>
    ((await (await app.request('/api/v1/connectors', { headers })).json()).connectors as { id: string }[]).map((c) => c.id);

  it('is not listed or linkable until enabled, then is listed', async () => {
    const f = fakeSpotify({
      'POST /api/token': [200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }],
      'GET /me': [200, { display_name: 'Julia', country: 'US' }],
    });
    const { app } = makeTestApp({}, { connectorTransport: f.transport });
    const { headers } = await registerUser(app);
    expect(await list(app, headers)).not.toContain('spotify');
    expect((await begin(app, headers)).res.status).toBe(404);
    expect(f.calls).toEqual([]);

    expect((await app.request('/api/v1/connectors/spotify/reveal', { method: 'POST', headers })).status).toBe(200);
    expect(await list(app, headers)).toContain('spotify');
    expect((await callback(app, (await begin(app, headers)).state)).status).toBe(302);

    // Per account: another user still sees nothing.
    const { headers: other } = await registerUser(app);
    expect(await list(app, other)).not.toContain('spotify');
  });

  it('has no book card data until linked', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const matches = await (await app.request(`/api/v1/documents/${DOC}/matches`, { headers })).json();
    expect(matches.services.map((s: { id: string }) => s.id)).not.toContain('spotify');
    expect((await app.request(`/api/v1/connectors/spotify/position/${DOC}`, { headers })).status).toBe(400);
  });

  it('skips accounts that never enabled it in the hourly job', async () => {
    const f = fakeSpotify({ 'GET /me/player': [204, null], 'GET /audiobooks/a1/chapters': [200, { items: CHAPTERS, next: null }] });
    const { app, db } = makeTestApp({}, { connectorTransport: f.transport });
    await registerUser(app);
    upsertAccount(db, 1, 'spotify', fresh(), null);
    saveMatch(db, 1, 'spotify', DOC, { externalId: 'a1', confidence: 1 }, 'auto');
    await pollSpotify(db, f.transport);
    expect(f.calls).toEqual([]);
    revealConnector(db, 1, 'spotify');
    await pollSpotify(db, f.transport);
    expect(f.calls.length).toBeGreaterThan(0);
  });

  it('GET /spotify needs a session and calls the enable endpoint', async () => {
    const { app } = makeTestApp();
    expect((await app.request('/spotify')).status).toBe(302);
    const signup = await app.request('/auth/signup', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: `web-${Date.now()}` }),
    });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const res = await app.request('/spotify', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('/api/v1/connectors/spotify/reveal');
  });
});

describe('spotify sign-in (server-run PKCE, one https redirect)', () => {
  async function setup(routes: Record<string, [number, unknown]> = {}) {
    const f = fakeSpotify({
      'POST /api/token': [200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }],
      'GET /me': [200, { display_name: 'Julia', country: 'US' }],
      ...routes,
    });
    const { app, db } = makeTestApp({}, { connectorTransport: f.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/spotify/reveal', { method: 'POST', headers });
    const linked = async () => ((await (await app.request('/api/v1/connectors', { headers })).json()).connectors as any[])
      .find((c) => c.id === 'spotify').linked;
    return { app, db, f, headers, linked };
  }

  it('sends the browser to Spotify with S256 PKCE and the server callback as redirect', async () => {
    const { app, headers } = await setup();
    const { body, q } = await begin(app, headers);
    expect(body.redirect_uri).toBe(REDIRECT);
    expect(Object.fromEntries(q!)).toMatchObject({
      client_id: 'client-123', response_type: 'code', redirect_uri: REDIRECT, code_challenge_method: 'S256',
      scope: 'user-library-read user-read-playback-position user-read-playback-state user-modify-playback-state',
    });
    expect(q!.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('uses the public https origin behind a trusted proxy', async () => {
    const f = fakeSpotify();
    const { app } = makeTestApp({ trustProxy: true }, { connectorTransport: f.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/spotify/reveal', { method: 'POST', headers });
    const res = await app.request('https://sync.example.com/api/v1/connectors/spotify/oauth/begin', {
      method: 'POST', headers: { ...headers, 'x-forwarded-proto': 'https' }, body: '{}',
    });
    expect((await res.json()).redirect_uri).toBe('https://sync.example.com/connectors/spotify/callback');
  });

  it('web: the callback page exchanges the code with the stored verifier and returns to Settings', async () => {
    const { app, f, headers, linked } = await setup();
    const { state, q } = await begin(app, headers, 'web');
    const res = await callback(app, state);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/app/#/settings/spotify');
    const sent = Object.fromEntries(new URLSearchParams(f.calls[0].body));
    expect(sent).toMatchObject({ grant_type: 'authorization_code', code: 'c', redirect_uri: REDIRECT });
    const { createHash } = await import('node:crypto');
    expect(createHash('sha256').update(sent.code_verifier).digest('base64url')).toBe(q!.get('code_challenge'));
    expect(await linked()).toBe(true);
  });

  it('app without an app link: the callback page still links, and says to go back to the app', async () => {
    const { app, headers, linked } = await setup();
    const res = await callback(app, (await begin(app, headers, 'app')).state);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('go back to the CrossPoint Sync app');
    expect(await linked()).toBe(true);
  });

  it('app with an app link: the app completes it, and repeats share the result', async () => {
    const { app, headers, linked } = await setup();
    const { state } = await begin(app, headers, 'app');
    const complete = () => app.request('/api/v1/connectors/spotify/oauth/complete', {
      method: 'POST', headers, body: JSON.stringify({ state, code: 'c' }),
    });
    expect((await complete()).status).toBe(200);
    expect(await linked()).toBe(true);
    // A repeat (or the browser page too) shares that result; the code is exchanged once.
    expect((await complete()).status).toBe(200);
    expect((await callback(app, state)).status).toBe(200);
  });

  it("another user can't complete someone else's sign-in", async () => {
    const { app, headers } = await setup();
    const { state } = await begin(app, headers, 'app');
    const { headers: other } = await registerUser(app);
    const res = await app.request('/api/v1/connectors/spotify/oauth/complete', {
      method: 'POST', headers: other, body: JSON.stringify({ state, code: 'c' }),
    });
    expect(res.status).toBe(400);
  });

  it('shows declines, unknown states and Spotify errors on the callback page, escaped', async () => {
    const { app, headers, linked } = await setup({ 'GET /me': [403, 'nope'] });
    const declined = await callback(app, (await begin(app, headers)).state, 'error=access_denied');
    expect(await declined.text()).toContain('You declined on Spotify.');
    expect(await (await callback(app, 'made-up')).text()).toContain('This sign-in expired');
    const off = await callback(app, (await begin(app, headers)).state);
    expect(off.status).toBe(400);
    expect(await off.text()).toContain('Spotify developer dashboard');
    expect(await linked()).toBe(false);
  });

  it('a pasted token (an older app) gets "update the app", never a link', async () => {
    const { app, f, headers } = await setup();
    const res = await app.request('/api/v1/connectors/spotify', {
      method: 'PUT', headers, body: JSON.stringify({ credential: { token: 'pasted' } }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toBe('Update the CrossPoint Sync app to sign in with Spotify.');
    expect(f.calls).toEqual([]);
  });

  it('expires abandoned sign-ins after 10 minutes', async () => {
    const { app, headers } = await setup();
    vi.useFakeTimers({ toFake: ['Date'] });
    const { state } = await begin(app, headers);
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    expect((await callback(app, state)).status).toBe(400);
  });
});

describe('app links and icons', () => {
  afterEach(() => { delete process.env.APPLE_TEAM_ID; delete process.env.ANDROID_CERT_SHA256; });

  it('serves the app-link files only once the signing identity is configured', async () => {
    const { app } = makeTestApp();
    expect((await app.request('/.well-known/apple-app-site-association')).status).toBe(404);
    expect((await app.request('/.well-known/assetlinks.json')).status).toBe(404);
    process.env.APPLE_TEAM_ID = 'ABCDE12345';
    process.env.ANDROID_CERT_SHA256 = 'AA:BB, CC:DD';
    const aasa = await app.request('/.well-known/apple-app-site-association');
    expect(aasa.headers.get('content-type')).toContain('application/json');
    expect(await aasa.json()).toEqual({
      applinks: { details: [{ appIDs: ['ABCDE12345.com.crosspointreader.sync'], components: [{ '/': '/connectors/*/callback' }] }] },
    });
    expect(await (await app.request('/.well-known/assetlinks.json')).json()).toEqual([{
      relation: ['delegate_permission/common.handle_all_urls'],
      target: { namespace: 'android_app', package_name: 'com.crosspointreader.sync', sha256_cert_fingerprints: ['AA:BB', 'CC:DD'] },
    }]);
  });

  it.each(['spotify', 'kindle'])('serves the %s icon as a 128px PNG', async (id) => {
    const { app } = makeTestApp();
    const res = await app.request(`/icons/${id}.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([128, 128]);
  });
});

describe('spotify connect follow-ups', () => {
  const DOC2 = 'b'.repeat(32);
  const DOC3 = 'c'.repeat(32);

  async function reader(routes: Record<string, [number, unknown]> = {}) {
    vi.useFakeTimers({ toFake: ['Date'] });
    const f = fakeSpotify({
      'POST /api/token': [200, { access_token: 'at', refresh_token: 'rt', expires_in: 3600 }],
      'GET /me': [200, { display_name: 'Julia', country: 'US' }],
      'GET /me/player': [204, null],
      ...routes,
    });
    const { app, db } = makeTestApp({}, { connectorTransport: f.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/spotify/reveal', { method: 'POST', headers });
    return { app, db, f, headers };
  }
  const tokenCalls = (f: any) => f.calls.filter((c: any) => c.url.endsWith('/api/token')).length;

  it('a repeated callback shows the first one\'s result instead of "expired"', async () => {
    const { app, f, headers } = await reader();
    const { state } = await begin(app, headers);
    const [a, b] = await Promise.all([callback(app, state), callback(app, state)]);
    expect([a.status, b.status]).toEqual([302, 302]);
    expect((await callback(app, state)).status).toBe(302);
    expect(tokenCalls(f)).toBe(1);
  });

  it('first connect matches books in progress and takes Spotify\'s position where it is ahead', async () => {
    const { app, db, f, headers } = await reader({
      'GET /me/audiobooks': [200, { items: [{ id: 'a1', name: 'Dune', authors: [{ name: 'Frank Herbert' }] }], next: null }],
      'GET /search': [200, { audiobooks: { items: [] } }],
      'GET /audiobooks/a1/chapters': [200, book(2, 1)], // 22% in
    });
    const push = (document: string, percentage: number) => app.request('/syncs/progress', {
      method: 'PUT', headers, body: JSON.stringify({ document, progress: '/x', percentage, device_id: 'reader', device: 'r' }),
    });
    await push(DOC, 0.1);
    await push(DOC2, 0.99);
    await push(DOC3, 0.2);
    await app.request('/api/v1/documents', {
      method: 'PUT', headers, body: JSON.stringify({ items: [
        { document: DOC, title: 'Dune', author: 'Frank Herbert' },
        { document: DOC2, title: 'Finished Book', author: 'Someone' },
        { document: DOC3, title: 'Not On Spotify', author: 'Nobody' },
      ] }),
    });

    vi.setSystemTime(Date.now() + 60_000); // connecting comes later than the last read
    await callback(app, (await begin(app, headers)).state);
    const latest = () => db.prepare('SELECT device_id, percentage FROM progress WHERE document = ? ORDER BY updated_at DESC LIMIT 1').get(DOC) as any;
    await vi.waitFor(() => expect(latest()).toEqual({ device_id: 'spotify', percentage: 0.22 }));
    const matches = db.prepare("SELECT document, external_id FROM connector_matches WHERE connector_id = 'spotify' ORDER BY document").all();
    expect(matches).toEqual([{ document: DOC, external_id: 'a1' }, { document: DOC3, external_id: null }]); // finished book skipped

    // Re-linking isn't a first connect: no second sweep.
    const before = f.calls.length;
    await callback(app, (await begin(app, headers)).state);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.calls.slice(before).some((c: any) => c.url.includes('/me/audiobooks'))).toBe(false);
  });

  it('first connect leaves progress alone when the reader is ahead', async () => {
    const { app, db, headers } = await reader({
      'GET /me/audiobooks': [200, { items: [{ id: 'a1', name: 'Dune', authors: [{ name: 'Frank Herbert' }] }], next: null }],
      'GET /audiobooks/a1/chapters': [200, book(2, 1)],
    });
    await app.request('/syncs/progress', {
      method: 'PUT', headers, body: JSON.stringify({ document: DOC, progress: '/x', percentage: 0.6, device_id: 'reader', device: 'r' }),
    });
    await app.request('/api/v1/documents', {
      method: 'PUT', headers, body: JSON.stringify({ items: [{ document: DOC, title: 'Dune', author: 'Frank Herbert' }] }),
    });
    await callback(app, (await begin(app, headers)).state);
    await vi.waitFor(() => expect(db.prepare("SELECT snapshot FROM connector_matches WHERE document = ?").get(DOC)).toBeTruthy());
    await new Promise((r) => setTimeout(r, 20));
    expect(db.prepare('SELECT device_id FROM progress WHERE document = ? ORDER BY updated_at DESC LIMIT 1').get(DOC)).toEqual({ device_id: 'reader' });
  });
});
