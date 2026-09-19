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
 * Readwise Reader connector (Tier 1) — archive-on-finish.
 *
 * Distinct from the highlights-only `readwise` connector (classic /api/v2): this
 * one carries reading *state*. When a document is finished on the device, it
 * marks the matching Readwise Reader document archived + seen via the Reader
 * API v3 (`PATCH /api/v3/bulk_update/`). No highlights.
 *
 * Matching is by title/author metadata (the firmware sends the EPUB's title).
 * It works with any source whose EPUB `dc:title` equals the Reader document's
 * title; when the article is delivered by an OPDS bridge that copies the Readwise
 * title verbatim the match is effectively exact — but we still gate on a high
 * confidence so we never archive the wrong document.
 *
 * Reader API v3 (docs: readwise.io/reader_api): `GET /api/v3/list/` (paged,
 * 20 req/min, `location`/`pageCursor`/`nextPageCursor`) and
 * `PATCH /api/v3/bulk_update/` with `{ updates: [{ id, location, seen }] }`
 * (returns 200, or 207 when some items failed — see push()).
 */

const BASE = 'https://readwise.io/api/v3';

// Non-archived locations = the pool of docs that could still be "finished".
const CANDIDATE_LOCATIONS = ['new', 'later', 'shortlist', 'feed'] as const;
// One page (100 docs) per location keeps us well under the 20 req/min limit.
const MAX_CANDIDATE_PAGES = 1;
// Archiving the wrong doc is worse than not archiving; our titles match ~1.0.
const MATCH_THRESHOLD = 0.85;

// Rate-limit backoff. Readwise is 20 req/min; on a 429 we can't read the exact
// Retry-After (crosspoint-sync's HttpTransport exposes no response headers), so
// we approximate it: after a 429, skip all Readwise calls for this window. The
// fan-in worker and the queue retry after it clears.
const COOLDOWN_MS = Number(process.env.READWISE_RATE_COOLDOWN_MS ?? 60_000);
let rateLimitedUntil = 0;
function rateLimited(): boolean {
  return Date.now() < rateLimitedUntil;
}
function noteRateLimit(status: number): void {
  if (status === 429) rateLimitedUntil = Date.now() + COOLDOWN_MS;
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

async function listDocs(token: string, http: HttpTransport, location: string): Promise<ReaderDoc[]> {
  const out: ReaderDoc[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_CANDIDATE_PAGES; page++) {
    const params = new URLSearchParams({ location, withHtmlContent: 'false' });
    if (cursor) params.set('pageCursor', cursor);
    const res = await http(`${BASE}/list/?${params.toString()}`, {
      method: 'GET',
      headers: authHeaders(token),
    });
    if (res.status === 429) {
      noteRateLimit(res.status);
      break;
    }
    if (res.status !== 200) break;
    const body = (await res.json()) as ReaderList;
    out.push(...(body.results ?? []));
    cursor = body.nextPageCursor ?? undefined;
    if (!cursor) break;
  }
  return out;
}

async function candidatePool(token: string, http: HttpTransport): Promise<Candidate[]> {
  const seen = new Set<string>();
  const pool: Candidate[] = [];
  for (const loc of CANDIDATE_LOCATIONS) {
    for (const d of await listDocs(token, http, loc)) {
      if (!d.title || seen.has(d.id)) continue;
      seen.add(d.id);
      pool.push({ externalId: d.id, title: d.title, author: d.author ?? d.site_name ?? null });
    }
  }
  return pool;
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

/** Only act on finish — ignore ongoing progress so we don't churn the API. */
function shouldPush(ev: OutboundEvent): boolean {
  return ev.kind === 'finished';
}

async function match(cred: Credential, doc: DocumentMeta, http: HttpTransport): Promise<Match | null> {
  if (rateLimited()) return null;
  const ta = extractTitleAuthor(doc);
  if (!ta) return null;
  const candidates = await candidatePool(tokenOf(cred), http);
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

/** The Reader "in progress" pool (non-archived), used as the match candidate set. */
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
  if (rateLimited()) return null;
  const res = await http(
    `${BASE}/list/?id=${encodeURIComponent(match.externalId)}&withHtmlContent=false`,
    { method: 'GET', headers: authHeaders(tokenOf(cred)) }
  );
  noteRateLimit(res.status);
  if (res.status !== 200) return null;
  const body = (await res.json()) as {
    results?: { reading_progress?: number; updated_at?: string }[];
  };
  const doc = body.results?.[0];
  if (!doc || typeof doc.reading_progress !== 'number') return null;
  const pct = Math.max(0, Math.min(1, doc.reading_progress));
  const updatedAtMs = doc.updated_at ? Date.parse(doc.updated_at) : Date.now();
  if (sinceMs && Number.isFinite(updatedAtMs) && updatedAtMs <= sinceMs) return null;
  return { externalId: match.externalId, percentage: pct, finished: pct >= 0.98, updatedAtMs };
}

async function push(
  cred: Credential,
  m: Match,
  ev: OutboundEvent,
  http: HttpTransport
): Promise<PushResult> {
  if (ev.kind !== 'finished') return { ok: true };
  const res = await http(`${BASE}/bulk_update/`, {
    method: 'PATCH',
    headers: authHeaders(tokenOf(cred)),
    body: JSON.stringify({ updates: [{ id: m.externalId, location: 'archive', seen: true }] }),
  });
  if (res.status === 401) return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  if (res.status === 429) {
    noteRateLimit(res.status);
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
  displayName: 'Readwise Reader (archive on finish)',
  tier: 1,
  capabilities: { read: true, write: true },
  carries: ['finished'],
  credentialKind: 'token',
  experimental: false,
  matchBy: 'metadata',
  validate,
  shouldPush,
  match,
  push,
  pullProgress,
  listCurrentlyReading,
};
