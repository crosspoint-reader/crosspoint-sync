import crypto from 'node:crypto';
import { documentMeta, getMatchSnapshot, setMatchSnapshot } from './store.js';
import type {
  Connector,
  ConnectorContext,
  Credential,
  DeviceLinkPoll,
  DeviceLinkStart,
  DocumentMeta,
  HttpTransport,
  Match,
  OutboundEvent,
  PushResult,
  ValidateResult,
} from './types.js';

/**
 * Seekquel connector (Tier 1). Sends reading progress, finished books and
 * highlights to a Seekquel account (seekquel.app), a book tracker.
 *
 * Seekquel speaks KOSync under /koreader and keys books by the same document
 * hash we store, so there is no book matching here: the document id is sent as
 * is, with the title, author and filename we know, and Seekquel matches the
 * file to a book on its side. A file it cannot place waits in the reader's
 * Seekquel library until they say which book it is.
 *
 * Linking is Seekquel's device-code pairing: the user approves a code in the
 * Seekquel app and the poll returns a per-link key, sent as x-auth-user. The
 * key is the whole credential; Seekquel never reads the KOSync password.
 *
 * Highlights and the finished status attach to a book, so Seekquel answers 409
 * until the file is linked to one. Seekquel matches a file a few seconds after
 * the first progress push that carries its title, so a 409 is retried on the
 * queue's backoff; a file nobody links dead-letters with a message saying so,
 * and "Sync now" sends it again once the reader picks the book in Seekquel.
 *
 * A finished book is marked Read once, then not again until the device has gone
 * back below the end. Every sync of a book at 100% fans out as 'finished', and
 * re-sending Read each time would undo a re-read the reader started in Seekquel
 * while the device still shows the old copy at the end.
 */

const DEFAULT_BASE = 'https://api.seekquel.app';
const CLIENT = 'crosspoint-sync';
const DEVICE_NAME = 'CrossPoint Sync';
const ACCEPT = 'application/vnd.koreader.v1+json';
const MAX_TEXT = 500;
const MAX_XPATH = 120;
const NOT_LINKED = 409;
const CONNECTOR_ID = 'seekquel';
const NOT_LINKED_ERROR = 'not linked to a book in Seekquel yet; choose the book in Seekquel, then Sync now';

/**
 * Per-book state kept on the match: whether Read has been sent since the device
 * last went below the end, and to which link. Matches outlive an unlink, so a
 * relink (perhaps to another Seekquel account) must not inherit the old answer.
 */
interface FinishSnapshot {
  readSent: boolean;
  link: string;
}

interface SeekquelCred extends Credential {
  server: string;
  key: string;
}

/** Seekquel's API origin. SEEKQUEL_URL points a test install at a local Seekquel. */
export function seekquelBase(env: NodeJS.ProcessEnv = process.env): string {
  let url = env.SEEKQUEL_URL?.trim() || DEFAULT_BASE;
  while (url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

function parseCred(cred: Credential): SeekquelCred | null {
  const server = typeof cred.server === 'string' ? cred.server.trim() : '';
  const key = typeof cred.key === 'string' ? cred.key.trim() : '';
  if (!server || !key) return null;
  return { server, key };
}

function headers(c: SeekquelCred): Record<string, string> {
  return { 'x-auth-user': c.key, accept: ACCEPT, 'content-type': 'application/json' };
}

function clip(value: string | null | undefined, max = MAX_TEXT): string | null {
  if (!value) return null;
  const chars = Array.from(value.trim());
  return chars.length === 0 ? null : chars.slice(0, max).join('');
}

async function readJson(res: { json(): Promise<unknown> }): Promise<Record<string, any>> {
  try {
    const body = await res.json();
    return body && typeof body === 'object' ? (body as Record<string, any>) : {};
  } catch {
    return {};
  }
}

function failure(status: number, what: string): PushResult {
  if (status === 401) return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  if (status === 403) return { ok: false, retryable: false, error: `${what}: forbidden` };
  if (status === 429) return { ok: false, retryable: true, error: 'rate limited' };
  if (status >= 500) return { ok: false, retryable: true, error: `server ${status}` };
  return { ok: false, retryable: false, error: `${what}: unexpected status ${status}` };
}

/**
 * Only a 401 means Seekquel refused the key. The key being checked was issued by
 * the pairing poll a moment ago, so a rate limit, a server error or a dropped
 * connection here is no reason to throw away a link the reader just approved:
 * the code is spent, and they would have to start again.
 */
async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, error: 'server and key are required' };
  try {
    const res = await http(`${c.server}/users/auth`, { method: 'GET', headers: headers(c) });
    if (res.status === 401) return { ok: false, error: 'Seekquel no longer accepts this link. Link it again.' };
    return { ok: true, accountLabel: 'Seekquel' };
  } catch {
    return { ok: true, accountLabel: 'Seekquel' };
  }
}

// Seekquel keys books by our document hash: matching is identity, no network.
async function match(_cred: Credential, doc: DocumentMeta): Promise<Match | null> {
  return { externalId: doc.document, confidence: 1, title: doc.title, author: doc.author };
}

/** The freshest metadata we hold: a document's title often arrives after its first sync. */
function metadataFor(m: Match, ev: OutboundEvent, ctx?: ConnectorContext): Record<string, string> | null {
  const meta = ctx ? documentMeta(ctx.db, ctx.userId, ev.document) : null;
  const fields: Record<string, string | null> = {
    title: clip(meta?.title ?? m.title),
    authors: clip(meta?.author ?? m.author),
    filename: clip(meta?.filename),
  };
  const present = Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== null);
  return present.length > 0 ? Object.fromEntries(present) : null;
}

/** CrossPoint's position object, minus an xpath longer than Seekquel stores. */
function positionFor(ev: OutboundEvent): Record<string, unknown> | null {
  if (!ev.position) return null;
  const position = { ...ev.position };
  if (typeof position.xpath === 'string' && position.xpath.length > MAX_XPATH) delete position.xpath;
  return position;
}

async function pushProgress(
  c: SeekquelCred,
  m: Match,
  ev: OutboundEvent,
  http: HttpTransport,
  ctx?: ConnectorContext
): Promise<PushResult> {
  const percentage = Math.max(0, Math.min(1, ev.percentage ?? 0));
  const body: Record<string, unknown> = {
    document: m.externalId,
    // KOSync refuses an empty progress string; fall back to the percentage.
    progress: ev.progress && ev.progress.length > 0 ? ev.progress : String(percentage),
    percentage,
    device: DEVICE_NAME,
    device_id: CLIENT,
  };
  const position = positionFor(ev);
  if (position) body.position = position;
  const metadata = metadataFor(m, ev, ctx);
  if (metadata) body.metadata = metadata;

  const res = await http(`${c.server}/syncs/progress`, { method: 'PUT', headers: headers(c), body: JSON.stringify(body) });
  return res.status >= 200 && res.status < 300 ? { ok: true } : failure(res.status, 'progress');
}

function linkId(c: SeekquelCred): string {
  return crypto.createHash('sha256').update(`${c.server}
${c.key}`).digest('hex').slice(0, 16);
}

function readAlreadySent(c: SeekquelCred, m: Match, ctx?: ConnectorContext): boolean {
  if (!ctx) return false;
  const snapshot = getMatchSnapshot<FinishSnapshot>(ctx.db, ctx.userId, CONNECTOR_ID, m.externalId);
  return snapshot?.readSent === true && snapshot.link === linkId(c);
}

function rememberReadSent(c: SeekquelCred, m: Match, readSent: boolean, ctx?: ConnectorContext): void {
  if (!ctx) return;
  const snapshot: FinishSnapshot = { readSent, link: linkId(c) };
  setMatchSnapshot(ctx.db, ctx.userId, CONNECTOR_ID, m.externalId, snapshot);
}

async function pushFinished(c: SeekquelCred, m: Match, http: HttpTransport, ctx?: ConnectorContext): Promise<PushResult> {
  if (readAlreadySent(c, m, ctx)) return { ok: true };
  const res = await http(`${c.server}/documents/${encodeURIComponent(m.externalId)}/status`, {
    method: 'PUT',
    headers: headers(c),
    body: JSON.stringify({ status: 'read' }),
  });
  if (res.status === NOT_LINKED) return { ok: false, retryable: true, error: NOT_LINKED_ERROR };
  if (res.status < 200 || res.status >= 300) return failure(res.status, 'status');
  rememberReadSent(c, m, true, ctx);
  return { ok: true };
}

/** Stable per highlight, so a re-sent or edited highlight updates rather than duplicates. */
function highlightId(document: string, h: NonNullable<OutboundEvent['highlight']>): string {
  const anchor = [document, h.spine ?? '', h.startOffset ?? '', h.endOffset ?? '', h.text].join('\n');
  return `crosspoint-sync:${crypto.createHash('sha1').update(anchor).digest('hex')}`;
}

async function pushHighlight(c: SeekquelCred, m: Match, ev: OutboundEvent, http: HttpTransport): Promise<PushResult> {
  const h = ev.highlight;
  if (!h || !h.text.trim()) return { ok: false, retryable: false, error: 'empty highlight' };
  const createdAt = h.highlightedAt ?? ev.timestamp;
  const highlight: Record<string, unknown> = {
    external_id: highlightId(m.externalId, h),
    text: h.text,
    created_at: new Date(createdAt * 1000).toISOString(),
  };
  if (h.note) highlight.note = h.note;
  const chapter = clip(h.chapter);
  if (chapter) highlight.chapter = chapter;

  const res = await http(`${c.server}/highlights`, {
    method: 'POST',
    headers: headers(c),
    body: JSON.stringify({ document: m.externalId, highlights: [highlight] }),
  });
  if (res.status === NOT_LINKED) return { ok: false, retryable: true, error: NOT_LINKED_ERROR };
  return res.status >= 200 && res.status < 300 ? { ok: true } : failure(res.status, 'highlight');
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
  try {
    if (ev.kind === 'highlight') return await pushHighlight(c, m, ev, http);
    const progress = await pushProgress(c, m, ev, http, ctx);
    if (!progress.ok) return progress;
    if (ev.kind !== 'finished') {
      if (readAlreadySent(c, m, ctx)) rememberReadSent(c, m, false, ctx);
      return progress;
    }
    return await pushFinished(c, m, http, ctx);
  } catch (err) {
    return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- Device-code linking flow -------------------------------------------------

async function beginLink(http: HttpTransport): Promise<DeviceLinkStart> {
  const res = await http(`${seekquelBase()}/koreader/pair/start`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ device_name: DEVICE_NAME, client: CLIENT }),
  });
  const body = await readJson(res);
  if (res.status !== 201 || typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
    const message = typeof body.message === 'string' ? body.message : `status ${res.status}`;
    throw new Error(`Seekquel did not start the link: ${message}`);
  }
  const complete = typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete : null;
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: complete ? complete.split('?')[0] : 'https://seekquel.app/settings/integrations',
    verificationUriComplete: complete ?? undefined,
    interval: Number(body.interval) || 5,
    expiresIn: Number(body.expires_in) || 900,
  };
}

async function pollLink(deviceCode: string, http: HttpTransport): Promise<DeviceLinkPoll> {
  const base = seekquelBase();
  const res = await http(`${base}/koreader/pair/poll`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ device_code: deviceCode }),
  });
  const body = await readJson(res);
  if (res.status === 200 && typeof body.key === 'string' && body.key) {
    return { status: 'ok', credential: { server: `${base}/koreader`, key: body.key }, accountLabel: 'Seekquel' };
  }
  switch (body.error?.type) {
    case 'authorization_pending':
    case 'slow_down':
      return { status: 'pending' };
    case 'access_denied':
      return { status: 'denied', error: 'The request was declined in Seekquel.' };
    case 'expired_token':
    case 'invalid_grant':
      return { status: 'expired', error: 'The code expired. Start again.' };
    default:
      return res.status >= 500 || res.status === 429
        ? { status: 'pending' }
        : { status: 'error', error: body.error?.type ?? `status ${res.status}` };
  }
}

export const seekquelConnector: Connector = {
  id: CONNECTOR_ID,
  displayName: 'Seekquel',
  tier: 1,
  capabilities: { read: false, write: true },
  carries: ['progress', 'finished', 'highlight'],
  credentialKind: 'device_code',
  beta: true,
  // Keyed by our document hash: Seekquel matches the file itself, so always send.
  matchBy: 'document',
  validate,
  match,
  push,
  beginLink,
  pollLink,
};
