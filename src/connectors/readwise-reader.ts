import { ConnectorOperationError } from './types.js';
import { decideMatch, extractTitleAuthor, normalizeText, type Candidate } from './matching.js';
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

/** Sync percentage progress with Readwise Reader; completion also archives the document. */
const BASE = 'https://readwise.io/api/v3';

// Follow nextPageCursor through the library; this is just a safety bound
// against a pathological cursor loop (a 429 mid-walk stops us far sooner and the
// backfill/fan-in worker resumes after the cooldown).
const MAX_CANDIDATE_PAGES = 50;
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

function tokenOf(cred: Credential): string {
  const t = (cred as ReadwiseCred).token;
  if (typeof t !== 'string' || t.length === 0) throw new Error('missing readwise token');
  return t;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Token ${token}`, 'content-type': 'application/json' };
}

async function listDocs(token: string, http: HttpTransport): Promise<ReaderDoc[]> {
  const out: ReaderDoc[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < MAX_CANDIDATE_PAGES; page++) {
    const params = new URLSearchParams({ withHtmlContent: 'false' });
    if (cursor) params.set('pageCursor', cursor);
    const res = await http(`${BASE}/list/?${params.toString()}`, {
      method: 'GET',
      headers: authHeaders(token),
    });
    noteRateLimit(token, res.status);
    if (res.status !== 200) throw new ConnectorOperationError(`Readwise Reader request failed (${res.status})`, res.status === 429 || res.status >= 500, res.status === 401 || res.status === 403);
    const body = (await res.json()) as ReaderList;
    out.push(...(body.results ?? []));
    const next = body.nextPageCursor ?? undefined;
    // Stop at the last page, or if the API ever repeats a cursor (loop guard).
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  return out;
}

async function loadCandidatePool(token: string, http: HttpTransport): Promise<Candidate[]> {
  const seen = new Set<string>();
  const pool: Candidate[] = [];
  if (rateLimited(token)) throw new ConnectorOperationError('Readwise Reader is rate limited; try again later', true);
  for (const d of await listDocs(token, http)) {
    if (!d.title || seen.has(d.id) || d.category === 'highlight' || d.category === 'note') continue;
    seen.add(d.id);
    pool.push({ externalId: d.id, title: d.title, author: d.author ?? d.site_name ?? null });
  }
  return pool;
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
  const entry = { expires: Date.now() + 300_000, pending: loadCandidatePool(token, http) };
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
  sinceMs: number
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
  http: HttpTransport
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
  if (updatedAt > ev.timestamp * 1000) return { ok: true, note: 'Newer Reader progress kept; sync this book to pull it.' };
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
  if (res.status >= 200 && res.status < 300) return { ok: true };
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
  pullProgress,
  listCurrentlyReading,
  search,
};
