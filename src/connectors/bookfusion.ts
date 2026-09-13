import { decideMatch, extractTitleAuthor, type Candidate } from './matching.js';
import { bookFusionEpub, epubPosition, epubXPath } from './bookfusion-epub.js';
import { ConnectorOperationError } from './types.js';
import type {
  Connector,
  Credential,
  DeviceLinkPoll,
  DeviceLinkStart,
  DocumentMeta,
  HttpTransport,
  InboundChange,
  Match,
  OutboundEvent,
  PushResult,
  ValidateResult,
} from './types.js';

/**
 * BookFusion connector (Tier 3, experimental). Uses BookFusion's OAuth 2.0
 * device-authorization grant to obtain a per-user access token, then pushes
 * reading position to /api/user/books/{id}/reading_position. Endpoints and the
 * api_version header come from BookFusion's official KOReader plugin.
 *
 * !!! LIVE-VERIFY GATE !!!
 * BookFusion's API is real but not formally public (a developer portal is "coming").
 * The plugin hardcodes client_id "koreader"; confirm we may reuse it or register
 * our own before shipping. Reconfirm the device-code, search, and reading_position
 * shapes against a live account. Search this file for GATE.
 */

const BASE = 'https://www.bookfusion.com';
const API_VERSION = 'application/json; api_version=10';
// GATE: confirm we can use this client_id; BookFusion may require registration.
const CLIENT_ID = 'koreader';

interface BookFusionCred extends Credential {
  access_token: string;
}

function tokenOf(cred: Credential): string {
  const t = (cred as BookFusionCred).access_token;
  if (typeof t !== 'string' || t.length === 0) throw new Error('missing bookfusion token');
  return t;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, accept: API_VERSION, 'content-type': 'application/json' };
}

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  try {
    const token = tokenOf(cred);
    // GATE: confirm a cheap authenticated endpoint for validation.
    const res = await http(`${BASE}/api/user/books/search`, {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({ query: '', per_page: 1 }),
    });
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'invalid token' };
    if (res.status >= 200 && res.status < 300) return { ok: true };
    return { ok: false, error: `unexpected status ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function match(
  cred: Credential,
  doc: DocumentMeta,
  http: HttpTransport
): Promise<Match | null> {
  const ta = extractTitleAuthor(doc);
  if (!ta) return null;
  const token = tokenOf(cred);
  const q = `${ta.title} ${ta.author}`.trim();
  // GATE: confirm the search request/response shape.
  const res = await http(`${BASE}/api/user/books/search`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ query: q, per_page: 10 }),
  });
  if (res.status < 200 || res.status >= 300) return null;
  let body: any;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  const hits = extractBooks(body);
  if (hits.length === 0) return null;
  const decision = decideMatch(ta.title, ta.author, hits);
  if (!decision.accepted || !decision.best) return null;
  return { externalId: decision.best.externalId, confidence: decision.best.score, queryUsed: q };
}

/** GATE: adapt to the real search payload. */
export function extractBooks(body: any): Candidate[] {
  const arr = Array.isArray(body) ? body : (body?.books ?? body?.results ?? []);
  const out: Candidate[] = [];
  for (const b of Array.isArray(arr) ? arr : []) {
    const id = b?.id ?? b?.book_id;
    const title = b?.title;
    if (id == null || typeof title !== 'string') continue;
    const author = b?.author ?? (Array.isArray(b?.authors) ? b.authors[0]?.name ?? b.authors[0] : undefined);
    out.push({ externalId: String(id), title, author });
  }
  return out;
}

async function readingPosition(token: string, bookId: string, http: HttpTransport) {
  const res = await http(`${BASE}/api/user/books/${encodeURIComponent(bookId)}/reading_position`, {
    method: 'GET', headers: authHeaders(token), signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) throw new ConnectorOperationError(
    `BookFusion reading position failed (${res.status})`, res.status === 429 || res.status >= 500,
    res.status === 401 || res.status === 403
  );
  const body = await res.json() as { updated_at?: unknown; percentage?: unknown; cfi?: unknown } | null;
  const updatedAtMs = typeof body?.updated_at === 'string' ? Date.parse(body.updated_at) : NaN;
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= 0 || typeof body?.percentage !== 'number' ||
      !Number.isFinite(body.percentage) || body.percentage < 0 || body.percentage > 100) {
    throw new ConnectorOperationError('BookFusion reading position is invalid', false);
  }
  return { updatedAtMs, percentage: body.percentage / 100, cfi: body.cfi };
}

async function pullProgress(
  cred: Credential, match: Match, http: HttpTransport, sinceMs: number
): Promise<InboundChange | null> {
  if (!match.fromSidecar) return null;
  const token = tokenOf(cred);
  const remote = await readingPosition(token, match.externalId, http);
  if (!remote || Math.floor(remote.updatedAtMs / 1000) <= Math.floor(sinceMs / 1000)) return null;
  if (typeof remote.cfi !== 'string' || !remote.cfi) {
    throw new ConnectorOperationError('BookFusion reading position has no CFI', false);
  }
  const epub = await bookFusionEpub(token, match.externalId, authHeaders(token), http);
  return {
    externalId: match.externalId, percentage: remote.percentage, finished: remote.percentage === 1,
    updatedAtMs: remote.updatedAtMs, progress: await epubXPath(epub, remote.cfi),
  };
}

async function push(
  cred: Credential,
  m: Match,
  ev: OutboundEvent,
  http: HttpTransport
): Promise<PushResult> {
  const token = tokenOf(cred);
  const percentage = Math.max(0, Math.min(1, ev.percentage ?? 0)) * 100; // BookFusion uses 0..100
  const body: Record<string, number | string> = { percentage: Number(percentage.toFixed(4)) };
  if (m.fromSidecar) {
    if (!ev.progress) throw new ConnectorOperationError('BookFusion position: XPath missing', false);
    const epub = await bookFusionEpub(token, m.externalId, authHeaders(token), http);
    try {
      Object.assign(body, await epubPosition(epub, ev.progress));
    } catch (error) {
      if (error instanceof ConnectorOperationError) throw error;
      throw new ConnectorOperationError('BookFusion position: cannot resolve XPath in the EPUB', false);
    }
  }
  if (m.fromSidecar) {
    // A delayed queue event must not roll back a newer BookFusion reading session.
    const remote = await readingPosition(token, m.externalId, http);
    if (remote && Math.floor(remote.updatedAtMs / 1000) > ev.timestamp) return { ok: true };
  }
  const res = await http(`${BASE}/api/user/books/${encodeURIComponent(m.externalId)}/reading_position`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(body),
  });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  }
  if (res.status === 429) return { ok: false, retryable: true, error: 'rate limited' };
  if (res.status >= 500) return { ok: false, retryable: true, error: `server ${res.status}` };
  if (res.status >= 200 && res.status < 300) return { ok: true };
  return { ok: false, retryable: false, error: `unexpected status ${res.status}` };
}

// --- Device-code linking flow -------------------------------------------------

async function beginLink(http: HttpTransport): Promise<DeviceLinkStart> {
  const res = await http(`${BASE}/api/user/auth/device`, {
    method: 'POST',
    headers: { accept: API_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
  });
  const body = (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval?: number;
    expires_in?: number;
  };
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri,
    interval: body.interval ?? 5,
    expiresIn: body.expires_in ?? 900,
  };
}

async function pollLink(deviceCode: string, http: HttpTransport): Promise<DeviceLinkPoll> {
  const res = await http(`${BASE}/api/user/auth/token`, {
    method: 'POST',
    headers: { accept: API_VERSION, 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: CLIENT_ID,
      device_code: deviceCode,
    }),
  });
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    /* ignore */
  }
  if (body?.access_token) {
    return { status: 'ok', credential: { access_token: body.access_token } };
  }
  switch (body?.error) {
    case 'authorization_pending':
    case 'slow_down':
      return { status: 'pending' };
    case 'access_denied':
      return { status: 'denied', error: 'You declined the request on BookFusion.' };
    case 'expired_token':
      return { status: 'expired', error: 'The code expired. Start again.' };
    default:
      return res.status >= 500
        ? { status: 'pending' }
        : { status: 'error', error: body?.error ?? `status ${res.status}` };
  }
}

export const bookfusionConnector: Connector = {
  id: 'bookfusion',
  displayName: 'BookFusion',
  tier: 3,
  capabilities: { read: true, write: true },
  carries: ['progress', 'finished'],
  credentialKind: 'device_code',
  experimental: true,
  validate,
  match,
  push,
  pullProgress,
  beginLink,
  pollLink,
};
