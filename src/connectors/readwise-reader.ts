import { ConnectorOperationError } from './types.js';
import { decideMatch, extractTitleAuthor, normalizeText, type Candidate } from './matching.js';
import { postHighlight } from './readwise.js';
import { getMatchSnapshot, setMatchSnapshot } from './store.js';
import type {
  Connector,
  ConnectorContext,
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

/** Sync percentage progress with Readwise Reader; completion also archives the document. */
const BASE = 'https://readwise.io/api/v3';

// CrossPoint reads EPUBs, so only Reader's EPUB documents are match candidates. Reader has
// no title search, so we list them, then fetch only what changed since the last listing.
const BOOK_CATEGORY = 'epub';
// Safety bound on pages per walk, against a cursor loop.
const MAX_CANDIDATE_PAGES = 200;
// A walk stopped by a rate limit resumes from its cursor if it is younger than this.
const WALK_TTL_MS = 3_600_000;
// How long a listing serves matching and the picker before we ask Reader what changed.
const CANDIDATE_TTL_MS = 300_000;
// A full listing drops documents deleted from Reader, which a changes-only fetch can't see.
const FULL_LISTING_MS = 86_400_000;
// Archiving the wrong doc is worse than not archiving; our titles match ~1.0.
const MATCH_THRESHOLD = 0.85;

// Rate-limit backoff. Readwise is 20 req/min *per access token*; on a 429 we
// can't read the exact Retry-After (crosspoint-sync's HttpTransport exposes no
// response headers), so we approximate it: after a 429, skip that token's
// Readwise calls for this window. Keyed per token so one account's 429 never
// suppresses another's (crosspoint-sync is multi-user). The fan-in worker and
// the queue retry after it clears.
const COOLDOWN_MS = Number(process.env.READWISE_RATE_COOLDOWN_MS ?? 60_000);
const rateLimitedUntil = new Map<string, number>();
function rateLimited(token: string): boolean {
  const until = rateLimitedUntil.get(token) ?? 0;
  if (Date.now() < until) return true;
  if (until) rateLimitedUntil.delete(token); // expired; keep the map small
  return false;
}
function noteRateLimit(token: string, status: number): void {
  if (status === 429) rateLimitedUntil.set(token, Date.now() + COOLDOWN_MS);
}

interface ReadwiseCred extends Credential {
  token: string;
}
interface ReaderDoc {
  id: string;
  title?: string;
  author?: string;
  site_name?: string;
  location?: string;
  category?: string;
  reading_progress?: number;
  updated_at?: string;
}
interface ReaderList {
  results?: ReaderDoc[];
  nextPageCursor?: string | null;
}

/**
 * The reading_progress we last wrote to Reader. Any edit (a highlight we add, a tag) moves a
 * document's updated_at, so only a change from this value means someone read on in Reader.
 */
// `at`: when the position was read (ms), so an older queued event can't write over it.
interface ProgressSnapshot { progress: number; at?: number }
const SAME_PROGRESS = 0.0005;
function knownProgress(ctx: ConnectorContext | undefined, m: Match): ProgressSnapshot | null {
  const snap = ctx ? getMatchSnapshot<ProgressSnapshot>(ctx.db, ctx.userId, 'readwise-reader', m.externalId) : null;
  return typeof snap?.progress === 'number' ? snap : null;
}
function rememberProgress(ctx: ConnectorContext | undefined, m: Match, progress: number, at: number): void {
  if (ctx) setMatchSnapshot(ctx.db, ctx.userId, 'readwise-reader', m.externalId, { progress, at } satisfies ProgressSnapshot);
}
const unchanged = (known: ProgressSnapshot | null, progress: number) => known != null && Math.abs(progress - known.progress) < SAME_PROGRESS;

function tokenOf(cred: Credential): string {
  const t = (cred as ReadwiseCred).token;
  if (typeof t !== 'string' || t.length === 0) throw new Error('missing readwise token');
  return t;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Token ${token}`, 'content-type': 'application/json' };
}

interface Library {
  byId: Map<string, Candidate>;
  listedAt: number; // start of the last finished walk
  fullAt: number; // start of the last full walk
}
interface LibraryWalk {
  since?: number; // set for a changes-only walk
  found: Map<string, Candidate>;
  cursor?: string;
  seenCursors: Set<string>;
  pages: number;
  startedAt: number;
}
const libraries = new Map<string, Library>();
// Per-token progress through a listing, kept when a 429 or 5xx stops it so the retry
// goes on from the same page instead of starting again from page one.
const walks = new Map<string, LibraryWalk>();

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.delete(key);
  if (map.size >= 100) map.delete(map.keys().next().value!);
  map.set(key, value);
}

function walkFor(token: string, since: number | undefined): LibraryWalk {
  const walk = walks.get(token);
  if (walk && walk.since === since && Date.now() - walk.startedAt < WALK_TTL_MS) return walk;
  const fresh: LibraryWalk = { since, found: new Map(), seenCursors: new Set(), pages: 0, startedAt: Date.now() };
  remember(walks, token, fresh);
  return fresh;
}

// One listing per token at a time, so two callers never share or drop each other's cursor.
const listings = new Map<string, Promise<Candidate[]>>();
function loadCandidatePool(token: string, http: HttpTransport): Promise<Candidate[]> {
  const running = listings.get(token);
  if (running) return running;
  const listing = walkLibrary(token, http).finally(() => listings.delete(token));
  listings.set(token, listing);
  return listing;
}

async function walkLibrary(token: string, http: HttpTransport): Promise<Candidate[]> {
  if (rateLimited(token)) throw new ConnectorOperationError('Readwise Reader is rate limited; try again later', true);
  const library = libraries.get(token);
  const since = library && Date.now() - library.fullAt < FULL_LISTING_MS ? library.listedAt : undefined;
  const walk = walkFor(token, since);
  let finished = false;
  while (walk.pages < MAX_CANDIDATE_PAGES) {
    const params = new URLSearchParams({ withHtmlContent: 'false', category: BOOK_CATEGORY });
    if (walk.since !== undefined) params.set('updatedAfter', new Date(walk.since).toISOString());
    if (walk.cursor) params.set('pageCursor', walk.cursor);
    const res = await http(`${BASE}/list/?${params.toString()}`, { method: 'GET', headers: authHeaders(token) });
    noteRateLimit(token, res.status);
    if (res.status !== 200) {
      const needsReauth = res.status === 401 || res.status === 403;
      if (needsReauth) {
        walks.delete(token);
        libraries.delete(token);
      }
      throw new ConnectorOperationError(`Readwise Reader request failed (${res.status})`, res.status === 429 || res.status >= 500, needsReauth);
    }
    const body = (await res.json()) as ReaderList;
    walk.pages++;
    for (const d of body.results ?? []) {
      if (d.title) walk.found.set(d.id, { externalId: d.id, title: d.title, author: d.author ?? d.site_name ?? null });
    }
    const next = body.nextPageCursor ?? undefined;
    if (!next) { finished = true; break; }
    if (walk.seenCursors.has(next)) {
      walks.delete(token); // Reader looped: start over next time rather than match against part of the list
      throw new ConnectorOperationError('Readwise Reader repeated a page; try again later', true);
    }
    walk.seenCursors.add(next);
    walk.cursor = next;
  }
  const known = walk.since !== undefined && library ? library.byId : undefined;
  if (!finished) {
    // Use what was listed, but keep the old watermark so later changes-only walks miss nothing.
    walk.pages = 0; // a page-bound stop goes on from its cursor next time
    return [...new Map([...(known ?? []), ...walk.found]).values()];
  }
  walks.delete(token);
  const byId = known ?? new Map<string, Candidate>();
  for (const [id, candidate] of walk.found) byId.set(id, candidate);
  remember(libraries, token, {
    byId,
    listedAt: walk.startedAt,
    fullAt: walk.since !== undefined && library ? library.fullAt : walk.startedAt,
  });
  return [...byId.values()];
}

// Share in-flight library requests across matching and the picker; never cache positions.
const candidateCache = new Map<string, { expires: number; pending: Promise<Candidate[]> }>();
function candidatePool(token: string, http: HttpTransport): Promise<Candidate[]> {
  const cached = candidateCache.get(token);
  if (cached && cached.expires > Date.now()) return cached.pending;
  for (const [key, entry] of candidateCache) {
    if (entry.expires <= Date.now()) candidateCache.delete(key);
  }
  if (candidateCache.size >= 100) candidateCache.delete(candidateCache.keys().next().value!);
  const entry = { expires: Date.now() + CANDIDATE_TTL_MS, pending: loadCandidatePool(token, http) };
  candidateCache.set(token, entry);
  entry.pending.catch(() => {
    if (candidateCache.get(token) === entry) candidateCache.delete(token);
  });
  return entry.pending;
}

async function search(cred: Credential, query: string, http: HttpTransport): Promise<ExternalBook[]> {
  const words = normalizeText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const pool = await candidatePool(tokenOf(cred), http);
  return pool.filter(book => {
    const text = normalizeText(`${book.title} ${book.author ?? ''}`);
    return words.every(word => text.includes(word));
  });
}

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  try {
    const res = await http(`${BASE}/list/?withHtmlContent=false`, {
      method: 'GET',
      headers: authHeaders(tokenOf(cred)),
    });
    if (res.status === 200) return { ok: true };
    if (res.status === 401) return { ok: false, error: 'invalid token' };
    return { ok: false, error: `unexpected status ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function shouldPush(ev: OutboundEvent): boolean {
  return ev.kind === 'progress' || ev.kind === 'finished' || ev.kind === 'highlight';
}

// attach the clipping to the matched Reader document, so Readwise files it under that book
async function pushHighlight(token: string, m: Match, ev: OutboundEvent, http: HttpTransport): Promise<PushResult> {
  const h = ev.highlight;
  if (!h?.text) return { ok: true };
  if (rateLimited(token)) return { ok: false, retryable: true, error: 'rate limited' };
  const res = await http(`${BASE}/save/`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({
      parent_id: m.externalId,
      content: h.text,
      saved_using: 'crosspoint',
      ...(h.note ? { notes: h.note } : {}),
    }),
  });
  noteRateLimit(token, res.status);
  if (res.status === 401 || res.status === 403) return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  if (res.status === 429 || res.status >= 500) return { ok: false, retryable: true, error: `server ${res.status}` };
  if (res.status === 200 || res.status === 201) return { ok: true };
  return { ok: false, retryable: false, error: `highlight rejected (${res.status}): ${(await res.text()).slice(0, 200)}` };
}

const UNMATCHED_NOTE = 'No Reader document matched, so clippings go to a separate Readwise book.';

// a book that isn't in Reader still gets its clippings in Readwise, as its own book
async function pushUnmatched(cred: Credential, doc: DocumentMeta, ev: OutboundEvent, http: HttpTransport): Promise<PushResult | null> {
  const h = ev.highlight;
  if (ev.kind !== 'highlight' || !h?.text) return null;
  const title = h.title ?? extractTitleAuthor(doc)?.title;
  if (!title) return { ok: false, retryable: false, error: 'no book title' };
  const token = tokenOf(cred);
  if (rateLimited(token)) return { ok: false, retryable: true, error: 'rate limited' };
  const { status, result } = await postHighlight(token, { ...h, title, author: h.author ?? doc.author }, http);
  noteRateLimit(token, status);
  if (status === 403) return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  return result.ok ? { ok: true, note: UNMATCHED_NOTE } : result;
}

async function match(cred: Credential, doc: DocumentMeta, http: HttpTransport): Promise<Match | null> {
  const token = tokenOf(cred);
  const ta = extractTitleAuthor(doc);
  if (!ta) return null;
  const candidates = await candidatePool(token, http);
  const decision = decideMatch(ta.title, ta.author, candidates, { threshold: MATCH_THRESHOLD });
  if (!decision.accepted || !decision.best) return null;
  return {
    externalId: decision.best.externalId,
    confidence: decision.best.score,
    queryUsed: ta.title,
    title: decision.best.title,
    author: decision.best.author ?? null,
  };
}

/** Include archived documents so rereads can still be matched. */
async function listCurrentlyReading(cred: Credential, http: HttpTransport): Promise<ExternalBook[]> {
  const pool = await candidatePool(tokenOf(cred), http);
  return pool.map((c) => ({ externalId: c.externalId, title: c.title, author: c.author ?? null }));
}

/**
 * Fan-in: pull the current Readwise reading position for a matched document, so
 * a half-read-in-Readwise article resumes on the device. Readwise exposes only a
 * 0–1 `reading_progress` (no KOReader xpath), so we return the percentage; the
 * exact-line seek is best-effort (crosspoint-sync fills a position from a prior
 * device sample when it has one).
 */
async function pullProgress(
  cred: Credential,
  match: Match,
  http: HttpTransport,
  sinceMs: number,
  ctx?: ConnectorContext
): Promise<InboundChange | null> {
  const token = tokenOf(cred);
  if (rateLimited(token)) throw new ConnectorOperationError('Readwise Reader is rate limited; try again later', true);
  const res = await http(
    `${BASE}/list/?id=${encodeURIComponent(match.externalId)}&withHtmlContent=false`,
    { method: 'GET', headers: authHeaders(token) }
  );
  noteRateLimit(token, res.status);
  if (res.status !== 200) throw new ConnectorOperationError(`Readwise Reader request failed (${res.status})`, res.status === 429 || res.status >= 500, res.status === 401 || res.status === 403);
  const body = (await res.json()) as {
    results?: { reading_progress?: number; updated_at?: string }[];
  };
  const doc = body.results?.[0];
  if (!doc || typeof doc.reading_progress !== 'number' || !Number.isFinite(doc.reading_progress)) return null;
  const pct = Math.max(0, Math.min(1, doc.reading_progress));
  if (unchanged(knownProgress(ctx, match), pct)) return null; // still what we wrote; only updated_at moved
  // Always return a finite timestamp: a missing/unparseable updated_at falls
  // back to "now" so the cursor comparison works and we never leak NaN.
  const parsed = doc.updated_at ? Date.parse(doc.updated_at) : NaN;
  const updatedAtMs = Number.isFinite(parsed) ? parsed : Date.now();
  if (sinceMs && updatedAtMs <= sinceMs) return null;
  return { externalId: match.externalId, percentage: pct, finished: pct >= 0.98, updatedAtMs };
}

async function push(
  cred: Credential,
  m: Match,
  ev: OutboundEvent,
  http: HttpTransport,
  ctx?: ConnectorContext
): Promise<PushResult> {
  if (!shouldPush(ev)) return { ok: true };
  if (ev.kind === 'highlight') return pushHighlight(tokenOf(cred), m, ev, http);
  if (typeof ev.percentage !== 'number' || !Number.isFinite(ev.percentage) || ev.percentage < 0 || ev.percentage > 1) {
    return { ok: false, retryable: false, error: 'invalid reading percentage' };
  }
  const token = tokenOf(cred);
  if (rateLimited(token)) return { ok: false, retryable: true, error: 'rate limited' };
  // Check again at delivery time: matching and queued retries can outlive a newer Reader sync.
  const current = await http(`${BASE}/list/?id=${encodeURIComponent(m.externalId)}&withHtmlContent=false`, {
    method: 'GET', headers: authHeaders(token),
  });
  noteRateLimit(token, current.status);
  if (current.status !== 200) return { ok: false, retryable: current.status === 429 || current.status >= 500,
    needsReauth: current.status === 401 || current.status === 403, error: `Reader position check failed (${current.status})` };
  const doc = ((await current.json()) as ReaderList).results?.[0];
  if (!doc) return { ok: false, retryable: false, error: 'Matched Reader document no longer exists' };
  const updatedAt = Date.parse(doc.updated_at ?? '');
  if (!Number.isFinite(updatedAt) || !Number.isFinite(ev.timestamp)) {
    return { ok: false, retryable: true, error: 'Cannot safely compare Reader progress timestamps' };
  }
  const readerProgress = typeof doc.reading_progress === 'number' ? doc.reading_progress : 0;
  const known = knownProgress(ctx, m);
  // Reader still holding our own write only moved updated_at, unless that write came after this event.
  const ours = unchanged(known, readerProgress) && !(known?.at && known.at > ev.timestamp * 1000);
  if (updatedAt > ev.timestamp * 1000 && !ours) {
    return { ok: true, note: 'Newer Reader progress kept; sync this book to pull it.' };
  }
  if (doc.category === 'pdf' && ev.kind === 'progress') {
    return { ok: true, note: 'Readwise Reader does not support updating PDF reading progress.' };
  }
  const update = { id: m.externalId,
    ...(doc.category !== 'pdf' ? { reading_progress: ev.percentage } : {}),
    ...(ev.kind === 'finished' ? { location: 'archive', seen: true } : {}),
  };
  const res = await http(`${BASE}/bulk_update/`, {
    method: 'PATCH',
    headers: authHeaders(token),
    body: JSON.stringify({ updates: [update] }),
  });
  if (res.status === 401 || res.status === 403) return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  if (res.status === 429) {
    noteRateLimit(token, res.status);
    return { ok: false, retryable: true, error: 'rate limited' };
  }
  if (res.status >= 500) return { ok: false, retryable: true, error: `server ${res.status}` };
  if (res.status === 207) {
    // Partial failure: the single item we sent didn't apply. Retry.
    return { ok: false, retryable: true, error: 'bulk_update partial failure' };
  }
  if (res.status >= 200 && res.status < 300) {
    rememberProgress(ctx, m, doc.category !== 'pdf' ? ev.percentage : readerProgress, ev.timestamp * 1000);
    return { ok: true };
  }
  return { ok: false, retryable: false, error: `unexpected status ${res.status}` };
}

export const readwiseReaderConnector: Connector = {
  id: 'readwise-reader',
  displayName: 'Readwise Reader',
  tier: 1,
  capabilities: { read: true, write: true },
  carries: ['progress', 'finished', 'highlight'],
  credentialKind: 'token',
  beta: false,
  matchBy: 'metadata',
  validate,
  shouldPush,
  match,
  push,
  pushUnmatched,
  pullProgress,
  // A pulled position is Reader's reading we now hold; a later edit must not bring it back.
  progressStored: (m, change, ctx) => rememberProgress(ctx, m, change.percentage, change.updatedAtMs),
  listCurrentlyReading,
  search,
};
