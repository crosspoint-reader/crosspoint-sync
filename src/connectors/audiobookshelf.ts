import { decideMatch, extractTitleAuthor, type Candidate } from './matching.js';
import type {
  Connector,
  Credential,
  DocumentMeta,
  ExternalBook,
  HttpTransport,
  InboundChange,
  Match,
  OutboundEvent,
  PushResult,
  ValidateResult,
} from './types.js';

/**
 * Audiobookshelf connector (Tier 1). Syncs reading position to a self-hosted
 * Audiobookshelf server so your book progress moves the matching audiobook, and
 * (later, via fan-in) vice versa. Self-hosted Whispersync.
 *
 * Position is percentage-based: ABS derives a book's `progress` from
 * `currentTime / duration`, so we map ebook% -> currentTime = pct * duration.
 * This is approximate (text position != audio time) but lands you at roughly
 * the right spot. Verified against api.audiobookshelf.org + the ABS source.
 */

interface AbsCred extends Credential {
  server: string;
  token: string;
}

function parseCred(cred: Credential): AbsCred | null {
  const server = typeof cred.server === 'string' ? cred.server.trim() : '';
  const token = typeof cred.token === 'string' ? cred.token.trim() : '';
  if (!server || !token) return null;
  return { server, token };
}

/** Normalize a server URL: add scheme if missing, strip trailing slashes. */
export function baseUrl(server: string): string {
  let url = server.includes('://') ? server : `https://${server}`;
  while (url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function absGet(http: HttpTransport, c: AbsCred, path: string) {
  const res = await http(`${baseUrl(c.server)}${path}`, { method: 'GET', headers: authHeaders(c.token) });
  let body: any = null;
  if (res.status >= 200 && res.status < 300) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }
  return { status: res.status, body };
}

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, error: 'server URL and API key are required' };
  try {
    const r = await absGet(http, c, '/api/me');
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'invalid API key' };
    if (r.status >= 200 && r.status < 300) {
      return { ok: true, accountLabel: r.body?.username ? `${r.body.username} @ ${c.server}` : c.server };
    }
    return { ok: false, error: `unexpected status ${r.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Pull book (mediaType === 'book') library ids. */
async function bookLibraryIds(http: HttpTransport, c: AbsCred): Promise<string[]> {
  const r = await absGet(http, c, '/api/libraries');
  const libs = Array.isArray(r.body?.libraries) ? r.body.libraries : [];
  return libs.filter((l: any) => l?.mediaType === 'book' && l?.id).map((l: any) => String(l.id));
}

/** GET a library item, adapting to the { id, media: { metadata, duration } } shape. */
export function itemToCandidate(item: any): (Candidate & { duration?: number }) | null {
  const li = item?.libraryItem ?? item;
  const id = li?.id;
  const meta = li?.media?.metadata;
  const title = meta?.title;
  if (id == null || typeof title !== 'string') return null;
  const duration = typeof li?.media?.duration === 'number' ? li.media.duration : undefined;
  return { externalId: String(id), title, author: meta?.authorName ?? undefined, duration };
}

async function match(cred: Credential, doc: DocumentMeta, http: HttpTransport): Promise<Match | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const ta = extractTitleAuthor(doc);
  if (!ta) return null;
  // ABS search matches best on the title alone; author is only used to score
  // and disambiguate the results (searching "title author" returns little).
  const q = ta.title.trim();

  const libIds = await bookLibraryIds(http, c);
  const candidates: (Candidate & { duration?: number })[] = [];
  for (const libId of libIds.length ? libIds : ['']) {
    const path = libId
      ? `/api/libraries/${encodeURIComponent(libId)}/search?q=${encodeURIComponent(q)}`
      : '';
    if (!path) continue;
    const r = await absGet(http, c, path);
    const books = Array.isArray(r.body?.book) ? r.body.book : Array.isArray(r.body?.results) ? r.body.results : [];
    for (const b of books) {
      const cand = itemToCandidate(b);
      if (cand) candidates.push(cand);
    }
  }
  if (candidates.length === 0) return null;
  const decision = decideMatch(ta.title, ta.author, candidates);
  if (!decision.accepted || !decision.best) return null;
  const chosen = candidates.find((x) => x.externalId === decision.best!.externalId);
  return {
    externalId: decision.best.externalId,
    // Cache the duration so push doesn't need an extra fetch.
    externalEdition: chosen?.duration != null ? String(chosen.duration) : null,
    confidence: decision.best.score,
    queryUsed: q,
    title: chosen?.title ?? null,
    author: chosen?.author ?? null,
  };
}

/** Books the user has in progress (a small, high-signal candidate pool). */
async function listCurrentlyReading(cred: Credential, http: HttpTransport): Promise<ExternalBook[]> {
  const c = parseCred(cred);
  if (!c) return [];
  const r = await absGet(http, c, '/api/me/items-in-progress');
  const items = Array.isArray(r.body?.libraryItems) ? r.body.libraryItems : [];
  const out: ExternalBook[] = [];
  for (const it of items) {
    const cand = itemToCandidate(it);
    if (cand) out.push({ externalId: cand.externalId, title: cand.title, author: cand.author ?? null, edition: cand.duration != null ? String(cand.duration) : null });
  }
  return out;
}

/** Search the user's book libraries (for the manual-match picker). */
async function search(cred: Credential, query: string, http: HttpTransport): Promise<ExternalBook[]> {
  const c = parseCred(cred);
  if (!c) return [];
  const libIds = await bookLibraryIds(http, c);
  const out: ExternalBook[] = [];
  for (const libId of libIds) {
    const r = await absGet(http, c, `/api/libraries/${encodeURIComponent(libId)}/search?q=${encodeURIComponent(query)}`);
    const books = Array.isArray(r.body?.book) ? r.body.book : Array.isArray(r.body?.results) ? r.body.results : [];
    for (const b of books) {
      const cand = itemToCandidate(b);
      if (cand) out.push({ externalId: cand.externalId, title: cand.title, author: cand.author ?? null, edition: cand.duration != null ? String(cand.duration) : null });
    }
  }
  return out;
}

/** Fetch an item's audiobook duration in seconds (null if unknown). */
async function fetchDuration(http: HttpTransport, c: AbsCred, externalId: string): Promise<number | null> {
  const r = await absGet(http, c, `/api/items/${encodeURIComponent(externalId)}?expanded=1`);
  const media = r.body?.media;
  const d = media?.duration;
  if (typeof d === 'number' && d > 0) return d;
  // Fall back to summing the audio files (older ABS items omit media.duration).
  const files = Array.isArray(media?.audioFiles) ? media.audioFiles : [];
  const sum = files.reduce((acc: number, f: any) => acc + (typeof f?.duration === 'number' ? f.duration : 0), 0);
  return sum > 0 ? sum : null;
}

/** Resolve the audiobook duration (seconds): cached on the match, else fetch. */
async function resolveDuration(http: HttpTransport, c: AbsCred, m: Match): Promise<number | null> {
  const cached = m.externalEdition ? Number(m.externalEdition) : NaN;
  if (Number.isFinite(cached) && cached > 0) return cached;
  return fetchDuration(http, c, m.externalId);
}

/** Resolve+cache the duration for a chosen item (called when a match is saved). */
async function resolveEdition(cred: Credential, externalId: string, http: HttpTransport): Promise<string | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const d = await fetchDuration(http, c, externalId);
  return d != null ? String(d) : null;
}

/**
 * Pull listening-position changes for bidirectional sync: read the user's media
 * progress and emit anything updated since the cursor. ABS derives `progress`
 * from currentTime/duration, so it maps straight back to a reading percentage.
 */
async function pullChanges(cred: Credential, http: HttpTransport, sinceMs: number): Promise<InboundChange[]> {
  const c = parseCred(cred);
  if (!c) return [];
  const r = await absGet(http, c, '/api/me');
  const mp = Array.isArray(r.body?.mediaProgress) ? r.body.mediaProgress : [];
  const out: InboundChange[] = [];
  for (const p of mp) {
    if (p?.episodeId) continue; // books only, not podcast episodes
    const lu = typeof p?.lastUpdate === 'number' ? p.lastUpdate : 0;
    if (lu <= sinceMs) continue;
    let pct = typeof p?.progress === 'number' ? p.progress : 0;
    if (!pct && typeof p?.currentTime === 'number' && typeof p?.duration === 'number' && p.duration > 0) {
      pct = p.currentTime / p.duration;
    }
    if (p?.libraryItemId == null) continue;
    out.push({
      externalId: String(p.libraryItemId),
      percentage: Math.max(0, Math.min(1, pct)),
      finished: !!p?.isFinished,
      updatedAtMs: lu,
    });
  }
  return out;
}

async function push(
  cred: Credential,
  m: Match,
  ev: OutboundEvent,
  http: HttpTransport
): Promise<PushResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, retryable: false, needsReauth: true, error: 'bad credential' };
  const pct = Math.max(0, Math.min(1, ev.percentage ?? 0));
  const finished = ev.kind === 'finished' || pct >= 0.999;

  // ABS accepts a `progress` fraction directly, so we can always update the
  // reading position even when we can't resolve the audiobook duration. When we
  // DO know the duration we also send currentTime/duration so the app seeks to
  // the right spot in the audio.
  //
  // IMPORTANT: ABS ignores the `progress` field when the payload also carries
  // `isFinished: false` (verified against a live server) - it only updates the
  // displayed progress if isFinished is absent or true. So we send isFinished
  // ONLY when finishing; otherwise we omit it and let progress/currentTime land.
  const duration = await resolveDuration(http, c, m);
  const payload: Record<string, unknown> = { progress: finished ? 1 : pct };
  if (finished) payload.isFinished = true;
  if (duration) {
    payload.duration = duration;
    payload.currentTime = Math.max(0, Math.min(duration, pct * duration));
  }

  const res = await http(`${baseUrl(c.server)}/api/me/progress/${encodeURIComponent(m.externalId)}`, {
    method: 'PATCH',
    headers: authHeaders(c.token),
    body: JSON.stringify(payload),
  });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  }
  if (res.status === 429) return { ok: false, retryable: true, error: 'rate limited' };
  if (res.status >= 500) return { ok: false, retryable: true, error: `server ${res.status}` };
  if (res.status >= 200 && res.status < 300) return { ok: true };
  return { ok: false, retryable: false, error: `unexpected status ${res.status}` };
}

export const audiobookshelfConnector: Connector = {
  id: 'audiobookshelf',
  displayName: 'Audiobookshelf',
  tier: 1,
  capabilities: { read: true, write: true },
  carries: ['progress', 'finished'],
  credentialKind: 'abs',
  beta: false,
  validate,
  match,
  push,
  listCurrentlyReading,
  search,
  resolveEdition,
  pullChanges,
};
