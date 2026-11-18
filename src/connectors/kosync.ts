import crypto from 'node:crypto';
import {
  ConnectorOperationError,
  type Connector,
  type ConnectorContext,
  type Credential,
  type DocumentMeta,
  type HttpTransport,
  type InboundChange,
  type Match,
  type OutboundEvent,
  type PushResult,
  type ValidateResult,
} from './types.js';
import { documentMeta } from './store.js';

/**
 * External kosync mirror connector. Keeps reading progress in step with ANOTHER
 * kosync server (e.g. sync.koreader.rocks, a friend's server, or a second
 * CrossPoint Sync instance), both ways, so other KOReader devices stay in sync.
 *
 * This is the simplest connector: kosync keys progress by the same 32-hex
 * document hash we already have, so there is NO book matching. It also speaks
 * the exact protocol we store, so mirroring is lossless (we can forward the rich
 * position + metadata superset; a plain kosync target ignores the extras).
 *
 * Fan-in is per book, when a device asks for progress or on "Sync now": the
 * target's newest place wins if it is newer than ours and is not our own push.
 */

/** device_id on everything we push, so a pull can tell our own echo apart. */
const MIRROR_DEVICE_ID = 'crosspoint-sync-mirror';

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
  // Calibre-Web (Automated) serves kosync under /kosync and only accepts Basic auth.
  // Only send the plaintext password there; stock kosync servers get the md5 key alone.
  const basic: Record<string, string> = baseUrl(c.server).endsWith('/kosync')
    ? { authorization: `Basic ${Buffer.from(`${c.username}:${c.password}`).toString('base64')}` }
    : {};
  return {
    ...basic,
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
  http: HttpTransport,
  ctx?: ConnectorContext
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
    device_id: MIRROR_DEVICE_ID,
  };
  // Forward the rich position superset (a plain kosync target ignores it).
  if (ev.position) body.position = ev.position;
  // Book metadata in the KOReader progress format, so a CrossPoint Sync target can
  // show the book (a plain kosync target ignores it).
  if (ctx) {
    const meta = documentMeta(ctx.db, ctx.userId, ev.document);
    const metadata = Object.fromEntries(
      Object.entries({ title: meta.title, authors: meta.author, filename: meta.filename }).filter(([, v]) => v)
    );
    if (Object.keys(metadata).length) body.metadata = metadata;
  }

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

async function pullProgress(cred: Credential, m: Match, http: HttpTransport): Promise<InboundChange | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const res = await http(`${baseUrl(c.server)}/syncs/progress/${encodeURIComponent(m.externalId)}`, {
    method: 'GET',
    // Tells a CrossPoint Sync target not to pull from its own mirrors while answering
    // (two instances mirroring each other would otherwise wait on one another).
    headers: { ...authHeaders(c), 'x-crosspoint-mirror': '1' },
  });
  if (res.status === 401) throw new ConnectorOperationError('unauthorized', false, true);
  if (res.status >= 500 || res.status === 429) throw new ConnectorOperationError(`server ${res.status}`, true);
  if (res.status !== 200) return null;
  // A book the target has never seen is 200 with an empty object.
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.progress !== 'string' || !body.progress || typeof body.percentage !== 'number' ||
      typeof body.timestamp !== 'number' || body.device_id === MIRROR_DEVICE_ID) return null;
  const percentage = Math.max(0, Math.min(1, body.percentage));
  return {
    externalId: m.externalId, percentage, progress: body.progress,
    finished: percentage >= 0.999, updatedAtMs: body.timestamp * 1000,
  };
}

export const kosyncConnector: Connector = {
  id: 'kosync',
  displayName: 'Another KOSync server',
  tier: 1,
  capabilities: { read: true, write: true },
  carries: ['progress', 'finished'],
  credentialKind: 'kosync',
  beta: false,
  // Keyed by our document hash, not book metadata: always mirror.
  matchBy: 'document',
  validate,
  match,
  push,
  pullProgress,
};
