import type {
  Connector,
  Credential,
  DocumentMeta,
  HttpTransport,
  Match,
  OutboundEvent,
  PushResult,
  ValidateResult,
} from './types.js';

/**
 * Readwise connector (Tier 1). Official REST API, per-user access token.
 * Carries highlights/notes only - NOT reading progress. Bidirectional:
 *  - fan-out: push CrossInk clippings via POST /api/v2/highlights/
 *  - fan-in: pull highlights via GET /api/v2/export/ (incl. Kindle, which
 *    Readwise ingests for us - the "aggregator hop", see docs/design/sync-hub.md).
 *
 * LIVE-VERIFY GATE: the v2 field names below follow Readwise's documented API
 * (readwise.io/api_deets) but should be reconfirmed at implementation. Endpoints
 * are stable and public, so the risk is lower than Hardcover's beta API.
 */

const BASE = 'https://readwise.io/api/v2';

interface ReadwiseCred extends Credential {
  token: string;
}

function tokenOf(cred: Credential): string {
  const t = (cred as ReadwiseCred).token;
  if (typeof t !== 'string' || t.length === 0) throw new Error('missing readwise token');
  return t;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Token ${token}`, 'content-type': 'application/json' };
}

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  try {
    const token = tokenOf(cred);
    const res = await http(`${BASE}/auth/`, { method: 'GET', headers: authHeaders(token) });
    if (res.status === 204 || res.status === 200) return { ok: true };
    if (res.status === 401) return { ok: false, error: 'invalid token' };
    return { ok: false, error: `unexpected status ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Readwise groups highlights by (title, author) rather than an external book id
 * we look up ahead of time - when we push, we send title/author and Readwise
 * creates/finds the book. So "matching" is trivial: any document with a title
 * (or a parseable filename) is pushable. We store a synthetic match so the
 * runner treats it as matched.
 */
async function match(
  cred: Credential,
  doc: DocumentMeta,
  _http: HttpTransport
): Promise<Match | null> {
  const title = doc.title ?? titleFromFilename(doc.filename);
  if (!title) return null;
  return { externalId: `title:${title}`, confidence: 1, queryUsed: title };
}

function titleFromFilename(filename: string | null): string | null {
  if (!filename) return null;
  const base = filename.replace(/\.[a-z0-9]+$/i, '');
  const parts = base.split(' - ');
  return (parts[0] ?? base).trim() || null;
}

async function push(
  cred: Credential,
  _m: Match,
  ev: OutboundEvent,
  http: HttpTransport
): Promise<PushResult> {
  // Readwise only accepts highlight events; progress/finished are no-ops here.
  if (ev.kind !== 'highlight' || !ev.highlight) {
    return { ok: true };
  }
  const token = tokenOf(cred);
  const h = ev.highlight;
  const highlight: Record<string, unknown> = {
    text: h.text,
    title: h.title ?? undefined,
    author: h.author ?? undefined,
    source_type: 'crosspoint',
    category: 'books',
    note: h.note ?? undefined,
    location: h.location ?? undefined,
    location_type: 'order',
    highlighted_at: h.highlightedAt ? new Date(h.highlightedAt * 1000).toISOString() : undefined,
  };
  const res = await http(`${BASE}/highlights/`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ highlights: [highlight] }),
  });
  if (res.status === 401) {
    return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  }
  if (res.status === 429) return { ok: false, retryable: true, error: 'rate limited' };
  if (res.status >= 500) return { ok: false, retryable: true, error: `server ${res.status}` };
  if (res.status === 200 || res.status === 201) return { ok: true };
  return { ok: false, retryable: false, error: `unexpected status ${res.status}` };
}

/**
 * Fan-in: export highlights updated since a cursor. Returns raw Readwise books
 * (each with a highlights[] array) plus the nextCursor for incremental pulls.
 * The caller maps these into the canonical clippings store. Kept separate from
 * the Connector interface (which is fan-out only for now) - wired when clipping
 * fan-in lands.
 */
export async function exportHighlights(
  cred: Credential,
  http: HttpTransport,
  updatedAfter?: number,
  pageCursor?: string
): Promise<{ results: unknown[]; nextCursor: string | null; status: number }> {
  const token = tokenOf(cred);
  const params = new URLSearchParams();
  if (updatedAfter) params.set('updatedAfter', new Date(updatedAfter * 1000).toISOString());
  if (pageCursor) params.set('pageCursor', pageCursor);
  const res = await http(`${BASE}/export/?${params.toString()}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  if (res.status !== 200) return { results: [], nextCursor: null, status: res.status };
  const body = (await res.json()) as { results?: unknown[]; nextPageCursor?: string | null };
  return {
    results: body.results ?? [],
    nextCursor: body.nextPageCursor ?? null,
    status: res.status,
  };
}

export const readwiseConnector: Connector = {
  id: 'readwise',
  displayName: 'Readwise',
  tier: 1,
  capabilities: { read: true, write: true },
  carries: ['highlight'],
  credentialKind: 'token',
  beta: false,
  // Hidden until the fan-in hop is wired and firmware sends clippings; the code
  // stays registered so re-enabling is a one-line change.
  hidden: true,
  validate,
  match,
  push,
};
