import crypto from 'node:crypto';
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
 * External kosync mirror connector. Forwards reading progress to ANOTHER kosync
 * server (e.g. sync.koreader.rocks, a friend's server, or a second CrossPoint
 * Sync instance) so other KOReader devices see it too.
 *
 * This is the simplest connector: kosync keys progress by the same 32-hex
 * document hash we already have, so there is NO book matching. It also speaks
 * the exact protocol we store, so mirroring is lossless (we can forward the rich
 * position + metadata superset; a plain kosync target ignores the extras).
 *
 * Outbound only for now (we push to them); fan-in would need loop suppression.
 */

interface KosyncCred extends Credential {
  server: string;
  username: string;
  password: string;
}

function parseCred(cred: Credential): KosyncCred | null {
  const server = typeof cred.server === 'string' ? cred.server.trim() : '';
  const username = typeof cred.username === 'string' ? cred.username.trim() : '';
  const password = typeof cred.password === 'string' ? cred.password : '';
  if (!server || !username || !password) return null;
  return { server, username, password };
}

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

/** Normalize a server URL: add scheme if missing, strip trailing slashes. */
export function baseUrl(server: string): string {
  let url = server.includes('://') ? server : `https://${server}`;
  while (url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

function authHeaders(c: KosyncCred): Record<string, string> {
  return {
    'x-auth-user': c.username,
    'x-auth-key': md5(c.password),
    accept: 'application/vnd.koreader.v1+json',
    'content-type': 'application/json',
  };
}

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, error: 'server, username and password are required' };
  try {
    const res = await http(`${baseUrl(c.server)}/users/auth`, {
      method: 'GET',
      headers: authHeaders(c),
    });
    if (res.status === 200) return { ok: true, accountLabel: `${c.username} @ ${c.server}` };
    if (res.status === 401) return { ok: false, error: 'invalid sync credentials' };
    return { ok: false, error: `unexpected status ${res.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// The document hash is the kosync document id: matching is identity, no network.
async function match(_cred: Credential, doc: DocumentMeta, _http: HttpTransport): Promise<Match | null> {
  return { externalId: doc.document, confidence: 1 };
}

async function push(
  cred: Credential,
  m: Match,
  ev: OutboundEvent,
  http: HttpTransport
): Promise<PushResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, retryable: false, needsReauth: true, error: 'bad credential' };

  const percentage = Math.max(0, Math.min(1, ev.percentage ?? 0));
  const body: Record<string, unknown> = {
    document: m.externalId,
    // kosync servers reject an empty progress string; fall back to the percentage.
    progress: ev.progress && ev.progress.length > 0 ? ev.progress : String(percentage),
    percentage,
    device: 'CrossPoint Sync',
    device_id: 'crosspoint-sync-mirror',
  };
  // Forward the rich position superset (a plain kosync target ignores it).
  if (ev.position) body.position = ev.position;

  try {
    const res = await http(`${baseUrl(c.server)}/syncs/progress`, {
      method: 'PUT',
      headers: authHeaders(c),
      body: JSON.stringify(body),
    });
    if (res.status === 200 || res.status === 202) return { ok: true };
    if (res.status === 401) return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
    if (res.status === 429) return { ok: false, retryable: true, error: 'rate limited' };
    if (res.status >= 500) return { ok: false, retryable: true, error: `server ${res.status}` };
    return { ok: false, retryable: false, error: `unexpected status ${res.status}` };
  } catch (err) {
    return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
  }
}

export const kosyncConnector: Connector = {
  id: 'kosync',
  displayName: 'Another KOSync server',
  tier: 1,
  capabilities: { read: false, write: true },
  carries: ['progress', 'finished'],
  credentialKind: 'kosync',
  beta: false,
  // Keyed by our document hash, not book metadata: always mirror.
  matchBy: 'document',
  validate,
  match,
  push,
};
