import crypto from 'node:crypto';
import { documentMeta, getMatchSnapshot, setMatchSnapshot } from './store.js';
import { ConnectorOperationError, SAVE_CREDENTIAL, type SavableCredential } from './types.js';
import { cachedEpub, epubQuoteRangeCfi, epubRangeCfi, epubRangeOffsets, epubXPath, normalizeEpubQuote, type Epub } from './bookfusion-epub.js';
import type {
  Connector,
  ConnectorContext,
  Credential,
  DeviceLinkPoll,
  DeviceLinkStart,
  DocumentMeta,
  HttpTransport,
  InboundChange,
  InboundHighlight,
  Match,
  OutboundEvent,
  PushResult,
  ValidateResult,
} from './types.js';

/**
 * Readest connector (Tier 1). Syncs reading progress both ways with a Readest
 * account (readest.com), the reader app, and sends clippings as highlights.
 *
 * Readest serves KOSync for CrossPoint readers under /api/crosspoint. Its
 * CrossPoint plugin points the reader's own KOReader Sync there, which takes it
 * off this server (and its clipping sync with it); linking Readest here instead
 * keeps the reader on CrossPoint Sync and forwards its position.
 *
 * Readest keys books by partial MD5, the same id a reader with Binary document
 * matching sends, so there is no book matching for progress: the document id is
 * sent as is, with the title and authors we know, and Readest links a copy whose
 * hash it doesn't know to the library book with that title and first author.
 *
 * Linking is Readest's device-code sign-in, approved once on web.readest.com/link.
 * It asks for a Readest session (the grant Readest's KOReader plugin uses), since
 * highlights go through Readest's main sync API, which takes nothing less. With
 * that session the link then approves a second code itself for the per-reader
 * key that the KOSync progress routes take (sent as its md5 in x-auth-key).
 * Session refresh tokens rotate on every use, so refreshes are serialized and
 * the newest set is saved on the link.
 *
 * Positions are KOReader XPointers both ways. Readest stores only XPointers, so
 * a position without one (a percentage from a non-EPUB source) isn't sent.
 * The place that comes back is forward-only, as in Readest's own plugin (the
 * furthest position wins), so a stale answer can never pull a device back;
 * our own push read back is dropped by fan-in's echo check.
 *
 * A clipping is placed in Readest's own copy of the book, so the book must be
 * in the reader's Readest cloud library: its chapter offsets become a range CFI
 * plus start and end XPointers there, checked against the clipping text. A
 * re-sent or edited clipping keeps its note id and updates in place. Readest
 * highlights come back the same way: their range CFI in that copy becomes
 * chapter offsets, and a highlight whose text isn't there is left out.
 */

const DEFAULT_BASE = 'https://web.readest.com';
const DEVICE_NAME = 'CrossPoint Sync';
const ACCEPT = 'application/vnd.koreader.v1+json';
const MAX_TEXT = 500;
const MS_PER_SECOND = 1000;
const LINK_PAGE = 'https://web.readest.com/link';
const CONNECTOR_ID = 'readest';
const NOT_IN_LIBRARY = 'book is not in your Readest library (upload the EPUB to Readest Cloud)';
// Readest's Supabase project and its public anon key, as its KOReader plugin ships them.
const DEFAULT_SUPABASE_URL = 'https://vbsyxfusjjqdxkjqlysc.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZic3l4ZnVzampxZHhranFseXNjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MzQxMjM2NzEsImV4cCI6MjA0OTY5OTY3MX0.3U5Uqaou_1SgrVe1eo9rApc0uKjqhpQdUXhvwUHmUfg';

interface ReadestCred extends Credential {
  server: string;
  key: string;
  username?: string;
  /** Readest's id for the reader key, which revokes it. */
  keyId?: string;
}

interface Session {
  access_token: string;
  refresh_token: string;
  /** unix seconds */
  expires_at: number;
}

/** The Readest library book a document's highlights belong to. */
interface BookSnapshot {
  bookHash: string;
  metaHash: string | null;
}

/** Readest's web origin. READEST_URL points a test install at a local Readest. */
export function readestBase(env: NodeJS.ProcessEnv = process.env): string {
  return (env.READEST_URL?.trim() || DEFAULT_BASE).replace(/\/+$/, '');
}

function supabase(env: NodeJS.ProcessEnv = process.env): { url: string; key: string } {
  return {
    url: (env.READEST_SUPABASE_URL?.trim() || DEFAULT_SUPABASE_URL).replace(/\/+$/, ''),
    key: env.READEST_SUPABASE_ANON_KEY?.trim() || DEFAULT_SUPABASE_ANON_KEY,
  };
}

/** Readest's web origin for a link: its server is the origin plus /api/crosspoint. */
const originOf = (c: ReadestCred) => c.server.replace(/\/api\/crosspoint$/, '');

function parseCred(cred: Credential): ReadestCred | null {
  const server = typeof cred.server === 'string' ? cred.server.trim() : '';
  const key = typeof cred.key === 'string' ? cred.key.trim() : '';
  if (!server || !key) return null;
  const username = typeof cred.username === 'string' ? cred.username : undefined;
  const keyId = typeof cred.keyId === 'string' ? cred.keyId : undefined;
  return { server, key, username, keyId };
}

function headers(c: ReadestCred): Record<string, string> {
  return {
    'x-auth-user': c.username || DEVICE_NAME,
    'x-auth-key': crypto.createHash('md5').update(c.key).digest('hex'),
    accept: ACCEPT,
    'content-type': 'application/json',
  };
}

function clip(value: string | null | undefined): string | null {
  if (!value) return null;
  const chars = Array.from(value.trim());
  return chars.length === 0 ? null : chars.slice(0, MAX_TEXT).join('');
}

async function readJson(res: { json(): Promise<unknown> }): Promise<Record<string, any>> {
  try {
    const body = await res.json();
    return body && typeof body === 'object' ? (body as Record<string, any>) : {};
  } catch {
    return {};
  }
}

function failure(status: number): PushResult {
  if (status === 401) return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  if (status === 429) return { ok: false, retryable: true, error: 'rate limited' };
  if (status >= 500) return { ok: false, retryable: true, error: `server ${status}` };
  return { ok: false, retryable: false, error: `progress: unexpected status ${status}` };
}

/**
 * Only a 401 means Readest refused the key. The key being checked was issued by
 * the sign-in poll a moment ago, and that poll hands it out once, so a server
 * error or a dropped connection here is no reason to throw away a link the
 * reader just approved.
 */
async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, error: 'server and key are required' };
  const accountLabel = c.username ? `Readest (${c.username})` : 'Readest';
  try {
    const res = await http(`${c.server}/users/auth`, { method: 'GET', headers: headers(c) });
    if (res.status === 401) return { ok: false, error: 'Readest no longer accepts this link. Link it again.' };
    return { ok: true, accountLabel };
  } catch {
    return { ok: true, accountLabel };
  }
}

// Readest keys books by our document hash: matching is identity, no network.
async function match(_cred: Credential, doc: DocumentMeta): Promise<Match | null> {
  return { externalId: doc.document, confidence: 1, title: doc.title, author: doc.author };
}

/** The freshest metadata we hold: a document's title often arrives after its first sync. */
function metadataFor(m: Match, ev: OutboundEvent, ctx?: ConnectorContext): Record<string, string> | null {
  const meta = ctx ? documentMeta(ctx.db, ctx.userId, ev.document) : null;
  const fields: Record<string, string | null> = {
    title: clip(meta?.title ?? m.title),
    authors: clip(meta?.author ?? m.author),
  };
  const present = Object.entries(fields).filter((entry): entry is [string, string] => entry[1] !== null);
  return present.length > 0 ? Object.fromEntries(present) : null;
}

// --- Readest session (highlights) ---------------------------------------------

function sessionFrom(body: Record<string, any>): Session | null {
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string') return null;
  const expiresAt = Number(body.expires_at) || Math.floor(Date.now() / 1000) + (Number(body.expires_in) || 3600);
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_at: expiresAt };
}

// Refresh tokens rotate on every use, and Supabase revokes the sign-in when a
// spent one is replayed. So refreshes are serialized per token, and a caller
// holding an already-spent token (a credential loaded before another refresh)
// follows the chain to the newest set instead of replaying it.
// ponytail: in-process only; run a single server process (as deployed) or move this to the DB.
const inflight = new Map<string, Promise<Session>>();
const successor = new Map<string, Session>();

async function refreshed(http: HttpTransport, refreshToken: string): Promise<Session> {
  let next = successor.get(refreshToken);
  while (next && successor.has(next.refresh_token)) next = successor.get(next.refresh_token)!;
  if (next && next.expires_at - 300 > Date.now() / 1000) return next;
  const from = next?.refresh_token ?? refreshToken;
  let pending = inflight.get(from);
  if (!pending) {
    pending = (async () => {
      const { url, key } = supabase();
      const res = await http(`${url}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: key, 'content-type': 'application/json' },
        body: JSON.stringify({ refresh_token: from }),
      });
      const session = res.status === 200 ? sessionFrom(await readJson(res)) : null;
      if (session) {
        successor.set(from, session);
        return session;
      }
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        throw new ConnectorOperationError('Readest sign-in expired or was revoked. Link Readest again.', false, true);
      }
      throw new ConnectorOperationError(`Readest token refresh failed (${res.status})`, true);
    })().finally(() => inflight.delete(from));
    inflight.set(from, pending);
  }
  return pending;
}

async function accessToken(cred: Credential, http: HttpTransport): Promise<string> {
  const c = cred as SavableCredential & Partial<Session>;
  if (typeof c.access_token !== 'string' || typeof c.refresh_token !== 'string') {
    throw new ConnectorOperationError('Readest highlights need a new link. Link Readest again.', false, true);
  }
  if ((c.expires_at ?? 0) - 300 > Date.now() / 1000) return c.access_token;
  const session = await refreshed(http, c.refresh_token);
  Object.assign(c, session);
  c[SAVE_CREDENTIAL]?.();
  return session.access_token;
}

async function syncApi(http: HttpTransport, c: ReadestCred, cred: Credential, method: 'GET' | 'POST', query: string, body?: unknown) {
  const token = await accessToken(cred, http);
  const res = await http(`${originOf(c)}/api/sync${query}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401 || res.status === 403) throw new ConnectorOperationError('unauthorized', false, true);
  if (res.status === 429 || res.status >= 500) throw new ConnectorOperationError(`server ${res.status}`, true);
  if (res.status < 200 || res.status >= 300) throw new ConnectorOperationError(`Readest sync: unexpected status ${res.status}`, false);
  return readJson(res);
}

const squash = (value: string | null | undefined) =>
  Array.from((value ?? '').normalize('NFKC').toLowerCase()).filter((ch) => /[\p{L}\p{N}]/u.test(ch)).join('');

/**
 * The Readest library book for a document: the book under our own id, or else
 * the uploaded EPUB with the same title and first author (the one read most
 * recently). Remembered on the match once found.
 */
async function readestBook(
  c: ReadestCred, cred: Credential, m: Match, http: HttpTransport, ctx?: ConnectorContext
): Promise<BookSnapshot | null> {
  const known = ctx ? getMatchSnapshot<BookSnapshot>(ctx.db, ctx.userId, CONNECTOR_ID, m.externalId) : null;
  if (known?.bookHash) return known;
  const usable = (b: any) => b && typeof b.book_hash === 'string' && !b.deleted_at && b.uploaded_at && String(b.format ?? 'EPUB').toUpperCase() === 'EPUB';
  const exact = await syncApi(http, c, cred, 'GET', `?since=0&type=books&book=${encodeURIComponent(m.externalId)}`);
  let book = (Array.isArray(exact.books) ? exact.books : []).find((b: any) => usable(b) && b.book_hash === m.externalId);
  if (!book) {
    const meta = ctx ? documentMeta(ctx.db, ctx.userId, ctx.document ?? m.externalId) : null;
    const title = squash(meta?.title ?? m.title);
    const author = squash((meta?.author ?? m.author ?? '').split(/[,&;]| and /)[0]);
    if (!title) return null;
    const all = await syncApi(http, c, cred, 'GET', '?since=0&type=books');
    book = (Array.isArray(all.books) ? all.books : [])
      .filter((b: any) => usable(b) && squash(b.title) === title && (!author || squash(b.author).startsWith(author)))
      .sort((a: any, b: any) => String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? '')))[0];
  }
  if (!book) return null;
  const found: BookSnapshot = { bookHash: book.book_hash, metaHash: typeof book.meta_hash === 'string' ? book.meta_hash : null };
  if (ctx) setMatchSnapshot(ctx.db, ctx.userId, CONNECTOR_ID, m.externalId, found);
  return found;
}

/** Readest's copy of the book, through the reader key's download link. */
function epub(http: HttpTransport, c: ReadestCred, bookHash: string) {
  return cachedEpub(['readest', c.server, bookHash], async () => {
    const link = await http(`${c.server}/books/${encodeURIComponent(bookHash)}`, { method: 'GET', headers: headers(c) });
    if (link.status === 401) throw new ConnectorOperationError('unauthorized', false, true);
    if (link.status === 404) throw new ConnectorOperationError(NOT_IN_LIBRARY, false);
    const url = link.status === 200 ? (await readJson(link)).downloadUrl : null;
    if (typeof url !== 'string') {
      throw new ConnectorOperationError(`Readest EPUB link failed (${link.status})`, link.status === 429 || link.status >= 500);
    }
    const res = await http(url, { method: 'GET' });
    if (res.status < 200 || res.status >= 300) {
      throw new ConnectorOperationError(`Readest EPUB download failed (${res.status})`, res.status === 429 || res.status >= 500);
    }
    return res;
  });
}

/** Start and end XPointers of a range CFI (the form Readest's KOReader plugin sends). */
async function rangeXPointers(bytes: Epub, cfi: string): Promise<[string, string] | null> {
  const parts = /^epubcfi\((.*),(.*),(.*)\)$/.exec(cfi);
  if (!parts) return null;
  const [, base, from, to] = parts;
  try {
    return [await epubXPath(bytes, `epubcfi(${base}${from})`), await epubXPath(bytes, `epubcfi(${base}${to})`)];
  } catch {
    return null; // Readest places a note by its CFI alone
  }
}

/** Short and stable per clipping (like the KOReader plugin's ids), so a re-send updates it. */
function noteId(document: string, h: NonNullable<OutboundEvent['highlight']>): string {
  const anchor = ['crosspoint-sync', document, h.spine ?? '', h.startOffset ?? '', h.endOffset ?? '', h.text].join(':');
  return crypto.createHash('md5').update(anchor).digest('hex').slice(0, 7);
}

async function pushHighlight(
  c: ReadestCred, cred: Credential, m: Match, ev: OutboundEvent, http: HttpTransport, ctx?: ConnectorContext
): Promise<PushResult> {
  const h = ev.highlight;
  if (!h || !h.text.trim()) return { ok: false, retryable: false, error: 'empty highlight' };
  // A file Readest holds may have no library entry yet; its own hash still finds it.
  const book = (await readestBook(c, cred, m, http, ctx)) ?? { bookHash: m.externalId, metaHash: null };
  const bytes = await epub(http, c, book.bookHash);
  const positioned = h.spine != null && h.startOffset != null && h.endOffset != null;
  const { cfi, text } = positioned
    ? await epubRangeCfi(bytes, h.spine!, h.startOffset!, h.endOffset!)
    : await epubQuoteRangeCfi(bytes, h.text);
  if (positioned && !normalizeEpubQuote(text).startsWith(normalizeEpubQuote(h.text).slice(0, 40))) {
    return { ok: false, retryable: false, error: 'clipping text not found at its position in the Readest copy of the book' };
  }
  const points = await rangeXPointers(bytes, cfi);
  const createdAt = (h.highlightedAt ?? ev.timestamp) * MS_PER_SECOND;
  const note: Record<string, unknown> = {
    bookHash: book.bookHash,
    ...(book.metaHash ? { metaHash: book.metaHash } : {}),
    id: noteId(m.externalId, h),
    type: 'annotation',
    cfi,
    ...(points ? { xpointer0: points[0], xpointer1: points[1] } : {}),
    text: h.text,
    ...(h.note ? { note: h.note } : {}),
    style: 'highlight',
    color: 'yellow',
    createdAt,
    // The clipping's own change time, so an edit replaces what Readest holds.
    updatedAt: Math.max(createdAt, ev.timestamp * MS_PER_SECOND),
  };
  await syncApi(http, c, cred, 'POST', '', { books: [], configs: [], notes: [note] });
  return { ok: true };
}

// Books a pull found no Readest copy for, so each progress read doesn't list the whole library again.
// ponytail: in-process only; a restart searches again.
const noCopyUntil = new Map<string, number>();
const SEARCH_AGAIN_MS = 60 * 60 * 1000;
// Highlights whose text isn't at their CFI, so their book isn't downloaded again on every read.
// Keyed with the CFI and edit time: an edited highlight is tried again.
const unplaced = new Set<string>();
export function clearReadestSearches(): void { noCopyUntil.clear(); unplaced.clear(); }

/** Unix seconds from Readest's ISO timestamp (or epoch ms), 0 when missing. */
function seconds(value: unknown): number {
  const ms = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? Math.floor(ms / MS_PER_SECOND) : 0;
}

async function pullHighlights(
  cred: Credential, m: Match, http: HttpTransport, skip: (text: string) => boolean, ctx?: ConnectorContext
): Promise<InboundHighlight[]> {
  const c = parseCred(cred);
  if (!c) return [];
  // Live highlights in one copy; its CFIs mean nothing in another copy's EPUB.
  const highlightsIn = async (bookHash: string) => {
    const res = await syncApi(http, c, cred, 'GET', `?since=0&type=notes&book=${encodeURIComponent(bookHash)}`);
    return (Array.isArray(res.notes) ? res.notes : []).filter((n: any) =>
      n?.type === 'annotation' && !n.deleted_at && n.book_hash === bookHash &&
      typeof n.cfi === 'string' && typeof n.text === 'string' && n.text.trim());
  };
  // Readest keys notes by the file's own hash (which may have no library entry)
  // and may also hold another copy of the book in its library.
  const copies = [m.externalId];
  const search = JSON.stringify([c.server, c.username ?? '', m.externalId]);
  if ((noCopyUntil.get(search) ?? 0) <= Date.now()) {
    const book = await readestBook(c, cred, m, http, ctx);
    if (!book) noCopyUntil.set(search, Date.now() + SEARCH_AGAIN_MS);
    else if (book.bookHash !== m.externalId) copies.push(book.bookHash);
  }
  const out: InboundHighlight[] = [];
  for (const bookHash of copies) {
    const key = (n: any) => JSON.stringify([c.server, c.username ?? '', bookHash, n.id, n.cfi, n.updated_at]);
    const notes = (await highlightsIn(bookHash)).filter((n: any) => !skip(n.text) && !unplaced.has(key(n)));
    if (!notes.length) continue;
    let bytes: Epub;
    try {
      bytes = await epub(http, c, bookHash);
    } catch (err) {
      // A copy whose file Readest doesn't hold (notes without an upload) mustn't hide the other copy.
      if (err instanceof ConnectorOperationError && !err.retryable && !err.needsReauth) continue;
      throw err;
    }
    for (const n of notes) {
      const at = await epubRangeOffsets(bytes, n.cfi).catch(() => null);
      if (!at || normalizeEpubQuote(at.text) !== normalizeEpubQuote(n.text)) {
        unplaced.add(key(n));
        continue;
      }
      // Readest selections can take in the space around a word; whitespace is one codepoint each.
      const text = at.text.trim();
      const lead = at.text.length - at.text.trimStart().length;
      out.push({
        text, note: typeof n.note === 'string' && n.note.trim() ? n.note : null, chapter: null,
        spine: at.spine, startOffset: at.start + lead, endOffset: at.start + lead + Array.from(text).length,
        createdAt: seconds(n.created_at),
      });
    }
  }
  return out;
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
  if (ev.kind === 'highlight') {
    try {
      return await pushHighlight(c, cred, m, ev, http, ctx);
    } catch (err) {
      if (err instanceof ConnectorOperationError) {
        return { ok: false, retryable: err.retryable, needsReauth: err.needsReauth, error: err.message };
      }
      return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
    }
  }
  // Readest stores XPointers only; a bare percentage has nowhere to go.
  if (!ev.progress?.startsWith('/body')) return { ok: true };
  const body: Record<string, unknown> = {
    document: m.externalId,
    progress: ev.progress,
    percentage: Math.max(0, Math.min(1, ev.percentage ?? 0)),
    device: DEVICE_NAME,
    device_id: 'crosspoint-sync',
  };
  const metadata = metadataFor(m, ev, ctx);
  if (metadata) body.metadata = metadata;
  try {
    const res = await http(`${c.server}/syncs/progress`, { method: 'PUT', headers: headers(c), body: JSON.stringify(body) });
    return res.status >= 200 && res.status < 300 ? { ok: true } : failure(res.status);
  } catch (err) {
    return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
  }
}

async function pullProgress(cred: Credential, m: Match, http: HttpTransport): Promise<InboundChange | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const res = await http(`${c.server}/syncs/progress/${encodeURIComponent(m.externalId)}`, {
    method: 'GET',
    headers: headers(c),
  });
  if (res.status === 401) throw new ConnectorOperationError('unauthorized', false, true);
  if (res.status >= 500 || res.status === 429) throw new ConnectorOperationError(`server ${res.status}`, true);
  if (res.status < 200 || res.status >= 300) return null; // 404: Readest has no place for the book yet
  const body = await readJson(res);
  if (typeof body.progress !== 'string' || !body.progress.startsWith('/body') || typeof body.percentage !== 'number') {
    return null;
  }
  const percentage = Math.max(0, Math.min(1, body.percentage));
  const stamp = typeof body.timestamp === 'number' ? body.timestamp * MS_PER_SECOND : Date.now();
  return { externalId: m.externalId, percentage, progress: body.progress, finished: false, updatedAtMs: stamp, furthestReadOnly: true };
}

// --- Device-code linking flow -------------------------------------------------

async function beginLink(http: HttpTransport): Promise<DeviceLinkStart> {
  const res = await http(`${readestBase()}/api/crosspoint/device/code`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: '{}',
  });
  const body = await readJson(res);
  if (res.status !== 200 || typeof body.device_code !== 'string' || typeof body.user_code !== 'string') {
    throw new Error(`Readest did not start the link: ${typeof body.error === 'string' ? body.error : `status ${res.status}`}`);
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: typeof body.verification_uri === 'string' ? body.verification_uri : LINK_PAGE,
    verificationUriComplete: typeof body.verification_uri_complete === 'string' ? body.verification_uri_complete : undefined,
    interval: Number(body.interval) || 5,
    expiresIn: Number(body.expires_in) || 600,
  };
}

async function tokenPoll(http: HttpTransport, base: string, body: Record<string, string>) {
  const res = await http(`${base}/api/crosspoint/device/token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await readJson(res) };
}

/** The per-reader key for the KOSync routes, from a code the session approves itself. */
async function readerKey(http: HttpTransport, base: string, session: Session): Promise<{ key: string; keyId?: string; username?: string }> {
  const code = await beginLink(http);
  const approve = await http(`${base}/api/crosspoint/device/approve`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.access_token}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ user_code: code.userCode }),
  });
  if (approve.status !== 200) throw new Error(`Readest did not approve the reader key (status ${approve.status})`);
  const { status, body } = await tokenPoll(http, base, { device_code: code.deviceCode });
  if (status !== 200 || typeof body.access_token !== 'string' || !body.access_token) {
    throw new Error(`Readest did not issue the reader key (status ${status})`);
  }
  return {
    key: body.access_token,
    keyId: typeof body.id === 'string' && body.id ? body.id : undefined,
    username: typeof body.username === 'string' && body.username ? body.username : undefined,
  };
}

async function pollLink(deviceCode: string, http: HttpTransport): Promise<DeviceLinkPoll> {
  const base = readestBase();
  const { status, body } = await tokenPoll(http, base, { device_code: deviceCode, grant: 'session' });
  const session = status === 200 ? sessionFrom(body) : null;
  if (session) {
    try {
      const reader = await readerKey(http, base, session);
      const username = reader.username ?? (typeof body.user?.email === 'string' ? body.user.email : undefined);
      return {
        status: 'ok',
        credential: {
          server: `${base}/api/crosspoint`, key: reader.key, ...(reader.keyId ? { keyId: reader.keyId } : {}),
          ...(username ? { username } : {}), ...session,
        },
        accountLabel: username ? `Readest (${username})` : 'Readest',
      };
    } catch (err) {
      // The approved code is spent: a new link has to start over.
      return { status: 'error', error: `${err instanceof Error ? err.message : String(err)}. Start again.` };
    }
  }
  switch (body.error) {
    case 'authorization_pending':
    case 'slow_down':
      return { status: 'pending' };
    case 'access_denied':
      return { status: 'denied', error: 'The request was declined in Readest.' };
    case 'expired_token':
      return { status: 'expired', error: 'The code expired. Start again.' };
    default:
      return status >= 500 || status === 429
        ? { status: 'pending' }
        : { status: 'error', error: typeof body.error === 'string' ? body.error : `status ${status}` };
  }
}

/**
 * Unlinked or replaced: revoke the reader key (its id is the capability, as in
 * Readest's plugin) and sign the session out, which ends its refresh token.
 */
async function revoke(cred: Credential, http: HttpTransport): Promise<void> {
  const c = parseCred(cred);
  const failures: string[] = [];
  if (c?.keyId) {
    const res = await http(`${c.server}/keys/${encodeURIComponent(c.keyId)}`, { method: 'DELETE', headers: { accept: 'application/json' } })
      .catch(() => null);
    if (res?.status !== 200) failures.push(`reader key (${res?.status ?? 'unreachable'})`);
  }
  const session = cred as Partial<Session>;
  if (typeof session.refresh_token === 'string') {
    try {
      // An expired access token can't sign out; a fresh one from the refresh token can.
      const token = await accessToken({ ...cred }, http);
      const { url, key } = supabase();
      const res = await http(`${url}/auth/v1/logout?scope=local`, {
        method: 'POST', headers: { apikey: key, authorization: `Bearer ${token}` },
      });
      // 401/403: the session is already gone, which is the goal.
      if (res.status >= 300 && res.status !== 401 && res.status !== 403) failures.push(`session (${res.status})`);
    } catch (err) {
      if (!(err instanceof ConnectorOperationError && err.needsReauth)) failures.push('session (unreachable)');
    }
  }
  if (failures.length) throw new Error(`Readest did not revoke the ${failures.join(' and ')}`);
}

export const readestConnector: Connector = {
  id: CONNECTOR_ID,
  displayName: 'Readest',
  tier: 1,
  capabilities: { read: true, write: true },
  // A finished book is its last place; Readest has no separate finished mark.
  carries: ['progress', 'finished', 'highlight'],
  credentialKind: 'device_code',
  beta: true,
  // Keyed by our document hash: Readest matches the file itself, so always send.
  matchBy: 'document',
  validate,
  match,
  push,
  pullProgress,
  pullHighlights,
  beginLink,
  pollLink,
  revoke,
};
