import { getMatchSnapshot, setMatchSnapshot } from './store.js';
import { decideMatch, extractTitleAuthor, type Candidate } from './matching.js';
import {
  ConnectorOperationError,
  SAVE_CREDENTIAL,
  type Connector,
  type Credential,
  type DocumentMeta,
  type ExternalBook,
  type ConnectorContext,
  type HttpTransport,
  type InboundChange,
  type Match,
  type OAuthConfig,
  type PushResult,
  type SavableCredential,
  type ValidateResult,
} from './types.js';

/**
 * Spotify connector (Tier 2): audiobook listening position, read-only.
 *
 * Linking is OAuth Authorization Code with PKCE, run by the server (routes/v1/
 * connectors.ts, oauth/begin + /connectors/:id/callback) so one https redirect
 * serves the web and the native app. validate() swaps { code, code_verifier,
 * redirect_uri } for tokens in place, so only tokens are ever stored. No client
 * secret exists anywhere: SPOTIFY_CLIENT_ID is a public PKCE client.
 *
 * Spotify has no way to write a resume point silently, so this connector never
 * pushes on fan-out. Its position is shown next to the reader's on the book
 * page, and "Resume in Spotify" (a user tap, never background sync) starts
 * playback there, falling back to a deep link without Premium or a device.
 *
 * Reading in: pullProgress (on progress requests and hourly) moves canonical
 * progress forward when the listener has. Resume points carry no timestamp, so
 * each matched book keeps a snapshot of the last-seen position; a forward move
 * past MIN_ADVANCE_MS (or into a later chapter) between snapshots is a change,
 * dated when we saw it.
 */

const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API = 'https://api.spotify.com/v1';

export const SPOTIFY_SCOPES = [
  'user-library-read',
  'user-read-playback-position',
  'user-read-playback-state',
  'user-modify-playback-state',
];
// Spotify sells audiobooks only here; elsewhere every audiobook call comes back empty.
export const AUDIOBOOK_MARKETS = ['US', 'GB', 'CA', 'IE', 'NZ', 'AU'];

// Smaller forward moves are resume-point jitter or a quick scrub, not listening.
export const MIN_ADVANCE_MS = 3 * 60_000;

// Spotify rate limits per app, so one 429 pauses every account until Retry-After.
let pausedUntil = 0;
export const spotifyPaused = () => Date.now() < pausedUntil;
export const resetSpotifyPause = () => { pausedUntil = 0; };

// The server's shared app, if any; each user can bring their own (connector_reveals.client_id).
const clientId = () => process.env.SPOTIFY_CLIENT_ID?.trim() || null;

function oauth(): OAuthConfig {
  return { authorizeUrl: AUTHORIZE_URL, clientId: clientId(), scopes: SPOTIFY_SCOPES };
}

// Spotify Client IDs are 32 hex characters.
export const CLIENT_ID_RE = /^[0-9a-f]{32}$/;

export const CLIENT_ID_REJECTED =
  "Spotify doesn't recognize this Client ID. Copy it again from your app's Settings in the Spotify dashboard (step 3).";
export const REDIRECT_REJECTED =
  'Spotify rejected the redirect URI. Add it to your Spotify app exactly as shown in step 2, then sign in again.';

/**
 * Whether Spotify knows a Client ID: a token exchange with a dummy code fails
 * with invalid_client for an unknown one and invalid_grant for a real one.
 * (The redirect URI can't be checked ahead: Spotify only reports it after login.)
 */
async function checkClientId(id: string, redirectUri: string, http: HttpTransport): Promise<'ok' | 'rejected' | 'unknown'> {
  try {
    const { body } = await tokenPost(http, {
      grant_type: 'authorization_code', code: 'check', redirect_uri: redirectUri, client_id: id, code_verifier: 'check'.repeat(9),
    });
    if (body?.error === 'invalid_client') return 'rejected';
    return body?.error === 'invalid_grant' ? 'ok' : 'unknown';
  } catch {
    return 'unknown';
  }
}

interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
}

async function tokenPost(http: HttpTransport, fields: Record<string, string>) {
  const res = await http(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  });
  const body: any = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

// Spotify may or may not rotate the refresh token; keep the old one when it doesn't.
const tokenSet = (body: any, refreshToken?: string): TokenSet | null =>
  typeof body?.access_token === 'string' && typeof (body.refresh_token ?? refreshToken) === 'string'
    ? {
        access_token: body.access_token,
        refresh_token: body.refresh_token ?? refreshToken,
        expires_at: Math.floor(Date.now() / 1000) + (Number(body.expires_in) || 3600),
      }
    : null;

/** The PKCE code exchange; mutates the link credential into a stored token credential. */
async function exchangeCode(cred: Credential, http: HttpTransport): Promise<void> {
  const id = typeof cred.client_id === 'string' ? cred.client_id : clientId();
  if (!id) throw new ConnectorOperationError("Add your Spotify app's Client ID first.", false);
  if (typeof cred.code !== 'string' || typeof cred.code_verifier !== 'string' || typeof cred.redirect_uri !== 'string') {
    throw new ConnectorOperationError('Spotify sign-in was incomplete. Start again.', false);
  }
  const { status, body } = await tokenPost(http, {
    grant_type: 'authorization_code',
    code: cred.code,
    redirect_uri: cred.redirect_uri,
    client_id: id,
    code_verifier: cred.code_verifier,
  });
  const tokens = tokenSet(body);
  if (!tokens) {
    if (body?.error === 'invalid_client') throw new ConnectorOperationError(CLIENT_ID_REJECTED, false);
    if (/redirect/i.test(body?.error_description ?? '')) throw new ConnectorOperationError(REDIRECT_REJECTED, false);
    throw new ConnectorOperationError(body?.error_description ?? body?.error ?? `Spotify answered ${status}`, false);
  }
  for (const k of Object.keys(cred)) delete cred[k];
  // Refresh tokens belong to the app that issued them, so the link keeps its Client ID.
  Object.assign(cred, tokens, { client_id: id });
}

// ponytail: concurrent refreshes of one credential both hit Spotify; fine since
// Spotify doesn't revoke on refresh-token reuse. Serialize like hardcover.ts if it starts to.
async function accessToken(cred: Credential, http: HttpTransport): Promise<string> {
  const c = cred as SavableCredential & Partial<TokenSet>;
  if (typeof c.access_token !== 'string' || typeof c.refresh_token !== 'string') {
    throw new ConnectorOperationError('Spotify is not linked', false, true);
  }
  if ((c.expires_at ?? 0) - 60 > Date.now() / 1000) return c.access_token;
  const { status, body } = await tokenPost(http, {
    grant_type: 'refresh_token',
    refresh_token: c.refresh_token,
    client_id: (typeof c.client_id === 'string' ? c.client_id : clientId()) ?? '',
  });
  const tokens = tokenSet(body, c.refresh_token);
  if (!tokens) {
    if (status === 400 || status === 401) {
      throw new ConnectorOperationError('Spotify sign-in expired or was revoked. Link Spotify again.', false, true);
    }
    throw new ConnectorOperationError(`Spotify token refresh failed (${status})`, true);
  }
  Object.assign(c, tokens);
  c[SAVE_CREDENTIAL]?.();
  return tokens.access_token;
}

async function api(http: HttpTransport, cred: Credential, method: string, path: string, body?: unknown) {
  if (spotifyPaused()) throw new ConnectorOperationError('Spotify rate limit; waiting for Retry-After', true);
  const token = await accessToken(cred, http);
  const res = await http(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) throw new ConnectorOperationError('Spotify sign-in expired. Link Spotify again.', false, true);
  if (res.status === 429) pausedUntil = Date.now() + (Number(res.headers?.get('retry-after')) || 60) * 1000;
  if (res.status === 429 || res.status >= 500) throw new ConnectorOperationError(`Spotify answered ${res.status}`, true);
  // 204 (nothing playing, playback started) has no body.
  const json: any = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, body: json };
}

/** Follow a paged list ({ items, next }) to the end, capped. */
async function pages(http: HttpTransport, cred: Credential, path: string, max = 20): Promise<any[]> {
  const out: any[] = [];
  let next: string | null = path;
  for (let i = 0; next && i < max; i++) {
    const r = await api(http, cred, 'GET', next.replace(API, ''));
    if (r.status !== 200) break; // 404/403: not available in this market
    out.push(...(Array.isArray(r.body?.items) ? r.body.items : []));
    next = typeof r.body?.next === 'string' ? r.body.next : null;
  }
  return out;
}

function toBook(raw: any): ExternalBook | null {
  const a = raw?.audiobook ?? raw;
  if (typeof a?.id !== 'string' || typeof a?.name !== 'string') return null;
  return { externalId: a.id, title: a.name, author: a?.authors?.[0]?.name ?? null };
}
const books = (items: any[]) => items.map(toBook).filter((b): b is ExternalBook => !!b);

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  try {
    if (cred.code) await exchangeCode(cred, http);
    const r = await api(http, cred, 'GET', '/me');
    // A Development mode Spotify app answers 403 "User not registered in the
    // Developer Dashboard" for anyone but its owner and allowlist (max 5 users).
    if (r.status === 403) {
      return {
        ok: false,
        error: "This Spotify account can't use this Spotify app. Sign in with the Spotify account that created the app (step 1), or add this account under User Management in the Spotify dashboard.",
      };
    }
    if (r.status !== 200) return { ok: false, error: `Spotify answered ${r.status}` };
    const name = r.body?.display_name || r.body?.id || 'Spotify';
    const country = r.body?.country;
    return {
      ok: true,
      accountLabel: country && !AUDIOBOOK_MARKETS.includes(country) ? `${name} (no Spotify audiobooks in ${country})` : name,
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Saved audiobooks: the runner tries these before catalog search. */
async function listCurrentlyReading(cred: Credential, http: HttpTransport): Promise<ExternalBook[]> {
  return books(await pages(http, cred, '/me/audiobooks?limit=50'));
}

async function search(cred: Credential, query: string, http: HttpTransport): Promise<ExternalBook[]> {
  const r = await api(http, cred, 'GET', `/search?type=audiobook&limit=10&q=${encodeURIComponent(query)}`);
  return books(Array.isArray(r.body?.audiobooks?.items) ? r.body.audiobooks.items : []);
}

// Neither our documents nor Spotify's audiobook objects carry an ISBN, so title/author it is.
async function match(cred: Credential, doc: DocumentMeta, http: HttpTransport): Promise<Match | null> {
  const ta = extractTitleAuthor(doc);
  if (!ta) return null;
  const q = `${ta.title} ${ta.author}`.trim();
  const hits: Candidate[] = await search(cred, q, http);
  const decision = decideMatch(ta.title, ta.author, hits);
  if (!decision.accepted || !decision.best) return null;
  return {
    externalId: decision.best.externalId,
    confidence: decision.best.score,
    queryUsed: q,
    title: decision.best.title,
    author: decision.best.author ?? null,
  };
}

async function push(): Promise<PushResult> {
  return { ok: false, retryable: false, error: 'Spotify progress is resume-only' };
}

export interface SpotifyChapter {
  id: string;
  uri: string;
  name: string;
  duration_ms: number;
  resume_point?: { fully_played?: boolean; resume_position_ms?: number };
}

export interface SpotifyPosition {
  chapterId: string;
  chapterUri: string;
  chapterName: string;
  chapterIndex: number;
  chapterCount: number;
  positionMs: number;
  /** positionMs plus every earlier chapter: where we are in the whole book. */
  offsetMs: number;
  /** 0..1 through the whole audiobook. */
  percentage: number;
  finished: boolean;
  /** Playing right now on one of the user's devices. */
  live: boolean;
}

/**
 * Where the listener is: the first chapter not fully played, at its resume
 * point. A matching live player overrides that (resume points lag playback).
 */
export function positionFromChapters(chapters: SpotifyChapter[], player?: any): SpotifyPosition | null {
  if (!chapters.length) return null;
  let index = chapters.findIndex((c) => !c.resume_point?.fully_played);
  const finished = index < 0;
  if (finished) index = chapters.length - 1;
  let positionMs = finished ? chapters[index].duration_ms : chapters[index].resume_point?.resume_position_ms ?? 0;
  let live = false;
  const playing = player?.item?.id ? chapters.findIndex((c) => c.id === player.item.id) : -1;
  if (playing >= 0) {
    index = playing;
    positionMs = Number(player.progress_ms) || 0;
    live = !!player.is_playing;
  }
  const total = chapters.reduce((s, c) => s + (c.duration_ms || 0), 0);
  const before = chapters.slice(0, index).reduce((s, c) => s + (c.duration_ms || 0), 0);
  const c = chapters[index];
  return {
    chapterId: c.id,
    chapterUri: c.uri,
    chapterName: c.name,
    chapterIndex: index,
    chapterCount: chapters.length,
    positionMs,
    offsetMs: before + positionMs,
    percentage: total ? Math.min(1, (before + positionMs) / total) : 0,
    finished: finished && playing < 0,
    live,
  };
}

const chaptersOf = async (cred: Credential, audiobookId: string, http: HttpTransport) =>
  (await pages(http, cred, `/audiobooks/${encodeURIComponent(audiobookId)}/chapters?limit=50`))
    .filter((c) => typeof c?.id === 'string' && typeof c?.uri === 'string') as SpotifyChapter[];

const playerOf = async (cred: Credential, http: HttpTransport) => {
  const r = await api(http, cred, 'GET', '/me/player?additional_types=episode');
  return r.status === 200 ? r.body : null;
};

/** The listening position on a matched audiobook; null when Spotify has none (or none in this market). */
export async function spotifyPosition(cred: Credential, audiobookId: string, http: HttpTransport): Promise<SpotifyPosition | null> {
  return positionFromChapters(await chaptersOf(cred, audiobookId, http), await playerOf(cred, http));
}

export interface SpotifySnapshot { chapterIndex: number; offsetMs: number; finished: boolean }

/**
 * Compare a fresh position with the book's last snapshot. `moved` = the listener
 * went forward for real. Small forward moves keep the old snapshot so they add
 * up across checks; backward moves (a re-listen) re-baseline. The first sighting
 * is only a baseline: no change has been observed yet, so there's nothing to date.
 */
export function advance(prev: SpotifySnapshot | null, pos: SpotifyPosition): { moved: boolean; next: SpotifySnapshot | null } {
  const next = { chapterIndex: pos.chapterIndex, offsetMs: pos.offsetMs, finished: pos.finished };
  if (!prev) return { moved: false, next };
  const moved = pos.chapterIndex > prev.chapterIndex || pos.offsetMs - prev.offsetMs >= MIN_ADVANCE_MS ||
    (pos.finished && !prev.finished);
  if (moved || pos.offsetMs < prev.offsetMs) return { moved, next };
  return { moved: false, next: null };
}

// One /me/player call per credential per poll run, shared by all its books.
const players = new WeakMap<Credential, Promise<any>>();

/**
 * Fan-in: a forward change since the last snapshot, dated now. The applier
 * (furthestReadOnly) then takes it only if it is ahead of saved progress.
 */
async function pullProgress(
  cred: Credential, match: Match, http: HttpTransport, _sinceMs: number, ctx?: ConnectorContext
): Promise<InboundChange | null> {
  if (!ctx) return null;
  const prev = getMatchSnapshot<SpotifySnapshot>(ctx.db, ctx.userId, 'spotify', match.externalId);
  if (prev?.finished) return null; // nothing left to advance; saves the calls
  const chapters = await chaptersOf(cred, match.externalId, http);
  if (!players.has(cred)) players.set(cred, playerOf(cred, http));
  const pos = positionFromChapters(chapters, await players.get(cred));
  if (!pos) return null;
  const { moved, next } = advance(prev, pos);
  if (next) setMatchSnapshot(ctx.db, ctx.userId, 'spotify', match.externalId, next);
  if (!moved) return null;
  return {
    externalId: match.externalId,
    percentage: pos.finished ? 1 : pos.percentage,
    finished: pos.finished,
    updatedAtMs: Date.now(),
    furthestReadOnly: true,
  };
}

export type ResumeResult =
  | { ok: true; position: SpotifyPosition }
  | { ok: false; position: SpotifyPosition; reason: string; fallbackUrl: string; appUrl: string };

/**
 * Start playback at the listening position. Only ever called from a user tap.
 * Without Premium (403) or an active device (404) the caller opens fallbackUrl.
 */
export async function spotifyResume(cred: Credential, audiobookId: string, http: HttpTransport): Promise<ResumeResult | null> {
  const position = await spotifyPosition(cred, audiobookId, http);
  if (!position) return null;
  const r = await api(http, cred, 'PUT', '/me/player/play', { uris: [position.chapterUri], position_ms: position.positionMs });
  if (r.status >= 200 && r.status < 300) return { ok: true, position };
  if (r.status === 403 || r.status === 404) {
    return {
      ok: false,
      position,
      reason: r.body?.error?.reason ?? (r.status === 404 ? 'NO_ACTIVE_DEVICE' : 'PREMIUM_REQUIRED'),
      // Spotify has no web page for a chapter, so both point at the audiobook; the
      // app resumes it at its own saved place (the position shown).
      fallbackUrl: `https://open.spotify.com/audiobook/${encodeURIComponent(audiobookId)}`,
      appUrl: `spotify:audiobook:${encodeURIComponent(audiobookId)}`,
    };
  }
  throw new ConnectorOperationError(r.body?.error?.message ?? `Spotify answered ${r.status}`, false);
}

export const spotifyConnector: Connector = {
  id: 'spotify',
  displayName: 'Spotify',
  tier: 2,
  // Read is forward-only fan-in (see pullProgress); write is the user's Resume tap.
  capabilities: { read: true, write: false },
  carries: ['progress'],
  credentialKind: 'oauth',
  beta: true,
  oauth,
  checkClientId,
  validate,
  match,
  push,
  listCurrentlyReading,
  search,
  pullProgress,
};
