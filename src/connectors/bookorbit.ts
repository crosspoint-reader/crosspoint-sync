import { decideMatch, extractTitleAuthor, type Candidate } from './matching.js';
import { baseUrl } from './audiobookshelf.js';
import { replaceMatchEdition } from './store.js';
import { cachedEpub, epubPosition, epubQuoteRangeCfi, epubRangeCfi, epubRangeOffsets, epubXPath, normalizeEpubQuote, withEpubMap, type Epub } from './bookfusion-epub.js';
import {
  ConnectorOperationError,
  type Connector,
  type ConnectorContext,
  type Credential,
  type DocumentMeta,
  type ExternalBook,
  type HttpTransport,
  type InboundChange,
  type InboundHighlight,
  type Match,
  type OutboundEvent,
  type PushResult,
  type ValidateResult,
} from './types.js';

/**
 * BookOrbit connector (Tier 1). Syncs reading position with a self-hosted
 * BookOrbit server (github.com/bookorbit/bookorbit, NestJS REST under /api/v1).
 *
 * BookOrbit's own KOReader endpoint only resolves KOReader's binary partial-MD5,
 * and CrossPoint hashes by filename by default, so a plain kosync mirror 404s.
 * Instead we match by title/author against the user's libraries and sync
 * progress and highlights with the book's file through the same REST API its
 * web reader uses. Positions are exact both ways: XPath <-> CFI against
 * BookOrbit's own copy of the EPUB.
 *
 * Auth is a BookOrbit API key (3.8+), sent as X-Api-Key. Older links use the
 * account password ("native" login for a refresh token, access tokens cached in
 * memory).
 */

interface OrbitCred extends Credential {
  server: string;
  apiKey?: string;
  username: string;
  password: string;
}

function parseCred(cred: Credential): OrbitCred | null {
  const server = typeof cred.server === 'string' ? cred.server.trim() : '';
  const apiKey = typeof cred.apiKey === 'string' ? cred.apiKey.trim() : '';
  const username = typeof cred.username === 'string' ? cred.username.trim() : '';
  const password = typeof cred.password === 'string' ? cred.password : '';
  if (server && apiKey) return { server, apiKey, username, password };
  if (!server || !username || !password) return null;
  return { server, username, password };
}

const api = (c: OrbitCred) => `${baseUrl(c.server)}/api/v1`;

interface Session {
  access: string;
  refresh?: string;
  expiresAt: number;
}
const sessions = new Map<string, Session>();
const sessionKey = (c: OrbitCred) => `${api(c)}\n${c.username}\n${c.password}`;

async function login(http: HttpTransport, c: OrbitCred): Promise<Session> {
  const key = sessionKey(c);
  const cached = sessions.get(key);
  if (cached && cached.expiresAt - 60_000 > Date.now()) return cached;

  const store = async (res: Awaited<ReturnType<HttpTransport>>) => {
    const body = (await res.json()) as { accessToken?: string; refreshToken?: string; accessTokenExpiresAt?: string };
    if (!body?.accessToken) throw new ConnectorOperationError('BookOrbit returned no access token', true);
    const exp = body.accessTokenExpiresAt ? Date.parse(body.accessTokenExpiresAt) : NaN;
    const s: Session = {
      access: body.accessToken,
      refresh: body.refreshToken ?? cached?.refresh,
      expiresAt: Number.isFinite(exp) ? exp : Date.now() + 10 * 60_000,
    };
    sessions.set(key, s);
    return s;
  };
  const post = (path: string, body: unknown) =>
    http(`${api(c)}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  if (cached?.refresh) {
    const res = await post('/auth/refresh', { refreshToken: cached.refresh });
    if (res.status === 200) return store(res);
  }
  sessions.delete(key);
  let res = await post('/auth/login', {
    username: c.username,
    password: c.password,
    clientKind: 'native',
    deviceLabel: 'CrossPoint Sync',
  });
  if (res.status === 400) {
    // Older servers reject native-client fields. Retry only that validation error.
    const body = await res.json().catch(() => null) as { message?: unknown } | null;
    const errors = body?.message;
    if (Array.isArray(errors) && errors.length > 0 && errors.every((error) =>
      error === 'property clientKind should not exist' || error === 'property deviceLabel should not exist'
    )) {
      res = await post('/auth/login', { username: c.username, password: c.password });
    }
  }
  if (res.status === 200) return store(res);
  if (res.status === 401 || res.status === 403) throw new ConnectorOperationError('invalid BookOrbit username or password', false, true);
  if (res.status === 429) throw new ConnectorOperationError('BookOrbit rate limited the login', true);
  throw new ConnectorOperationError(`BookOrbit login failed (${res.status})`, res.status >= 500);
}

/** Authenticated request; re-logs in once if the cached token was revoked. */
async function call(http: HttpTransport, c: OrbitCred, method: string, path: string, body?: unknown) {
  if (c.apiKey) {
    return http(`${api(c)}${path}`, {
      method,
      headers: { 'x-api-key': c.apiKey, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  for (let attempt = 0; ; attempt++) {
    const s = await login(http, c);
    const res = await http(`${api(c)}${path}`, {
      method,
      headers: { authorization: `Bearer ${s.access}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status !== 401 || attempt > 0) return res;
    sessions.delete(sessionKey(c));
  }
}

/**
 * 401 is always the credential. A 403 is only about the account when BookOrbit says it is the key;
 * a plain 403 is one library or book this account cannot see.
 */
async function authFailure(res: Awaited<ReturnType<HttpTransport>>): Promise<boolean> {
  if (res.status === 401) return true;
  if (res.status !== 403) return false;
  const body = await res.json().catch(() => null) as { errorCode?: unknown } | null;
  return typeof body?.errorCode === 'string' && body.errorCode.startsWith('API_KEY');
}

class OrbitRequestError extends ConnectorOperationError {
  constructor(message: string, retryable: boolean, needsReauth: boolean, readonly status: number) {
    super(message, retryable, needsReauth);
  }
}

async function failure(res: Awaited<ReturnType<HttpTransport>>, what: string): Promise<ConnectorOperationError> {
  return new OrbitRequestError(`${what} (${res.status})`, res.status === 429 || res.status >= 500, await authFailure(res), res.status);
}

async function getJson(http: HttpTransport, c: OrbitCred, path: string): Promise<any> {
  const res = await call(http, c, 'GET', path);
  if (res.status === 401 || res.status === 403) throw await failure(res, 'BookOrbit request failed');
  if (res.status < 200 || res.status >= 300) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/** Sync reads must distinguish empty remote data from a failed request. */
export async function bookorbitStatsJson(cred: Credential, http: HttpTransport, path: string): Promise<any> {
  const c = parseCred(cred);
  if (!c) throw new ConnectorOperationError('invalid BookOrbit credentials', false, true);
  const res = await call(http, c, 'GET', path);
  if (res.status < 200 || res.status >= 300) throw await failure(res, 'BookOrbit request failed');
  return res.json();
}

/** Save a cumulative session checkpoint with a provider-side retry identity. */
export async function saveBookorbitSession(cred: Credential, http: HttpTransport, file: string, body: unknown): Promise<void> {
  const c = parseCred(cred);
  if (!c) throw new ConnectorOperationError('invalid BookOrbit credentials', false, true);
  const res = await call(http, c, 'POST', `/books/files/${encodeURIComponent(file)}/sessions`, body);
  if (res.status !== 204) throw await failure(res, 'BookOrbit session export failed');
}

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, error: 'server URL and API key are required' };
  try {
    if (c.apiKey) {
      const res = await call(http, c, 'GET', '/auth/me');
      if (res.status === 401 || res.status === 403) {
        const body = await res.json().catch(() => null) as { message?: unknown } | null;
        const reason = typeof body?.message === 'string' && body.message !== 'Unauthorized' ? body.message : null;
        return { ok: false, error: reason ? `BookOrbit: ${reason}` : 'BookOrbit rejected the API key (keys need BookOrbit 3.8 or newer)' };
      }
      if (res.status < 200 || res.status >= 300) return { ok: false, error: `BookOrbit request failed (${res.status})` };
      const me = await res.json().catch(() => null) as { username?: unknown } | null;
      if (typeof me?.username !== 'string') return { ok: false, error: 'BookOrbit returned no account' };
      cred.username = me.username;
      return { ok: true, accountLabel: `${me.username} @ ${c.server}` };
    }
    sessions.delete(sessionKey(c));
    const me = await getJson(http, c, '/auth/me');
    const name = me?.username ?? me?.user?.username ?? c.username;
    return { ok: true, accountLabel: `${name} @ ${c.server}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function toCandidate(b: any): Candidate | null {
  if (b?.id == null || typeof b.title !== 'string') return null;
  const authors = Array.isArray(b.authors) ? b.authors.filter((a: unknown) => typeof a === 'string') : [];
  return { externalId: String(b.id), title: b.title, author: authors.join(', ') || undefined };
}

async function searchBooks(http: HttpTransport, c: OrbitCred, q: string): Promise<Candidate[]> {
  const rows = await getJson(http, c, `/books/search?q=${encodeURIComponent(q.slice(0, 500))}&limit=20`);
  return (Array.isArray(rows) ? rows : [])
    .filter((b: any) => !Array.isArray(b?.formats) || b.formats.length === 0 || b.formats.includes('epub'))
    .map(toCandidate)
    .filter((x): x is Candidate => x !== null);
}

async function match(cred: Credential, doc: DocumentMeta, http: HttpTransport): Promise<Match | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const ta = extractTitleAuthor(doc);
  if (!ta) return null;
  const q = ta.title.trim();
  const candidates = await searchBooks(http, c, q);
  const decision = decideMatch(ta.title, ta.author, candidates);
  if (!decision.accepted || !decision.best) return null;
  const best = decision.best;
  return {
    externalId: best.externalId,
    externalEdition: await fileId(http, c, best.externalId),
    confidence: best.score,
    queryUsed: q,
    title: best.title,
    author: best.author ?? null,
  };
}

async function search(cred: Credential, query: string, http: HttpTransport): Promise<ExternalBook[]> {
  const c = parseCred(cred);
  if (!c) return [];
  return (await searchBooks(http, c, query)).map((b) => ({ externalId: b.externalId, title: b.title, author: b.author ?? null }));
}

/** The book's EPUB file id (progress is stored per file). Primary EPUB first. */
async function fileId(http: HttpTransport, c: OrbitCred, bookId: string): Promise<string | null> {
  const book = await getJson(http, c, `/books/${encodeURIComponent(bookId)}`);
  const files: any[] = Array.isArray(book?.files) ? book.files : [];
  const epubs = files.filter((f) => f?.id != null && String(f.format).toLowerCase() === 'epub');
  const chosen = epubs.find((f) => f.role === 'primary') ?? epubs[0];
  return chosen ? String(chosen.id) : null;
}

async function resolveEdition(cred: Credential, externalId: string, http: HttpTransport): Promise<string | null> {
  const c = parseCred(cred);
  return c ? fileId(http, c, externalId) : null;
}

interface FileProgress {
  percentage: number;
  updatedAt?: string | null;
  textUpdatedAt?: string | null;
  koreaderProgress?: string | null;
  cfi?: string | null;
}

// The book-level endpoint only exposes the web reader's updatedAt. Plugin
// writes preserve that timestamp; the file endpoint also exposes textUpdatedAt.
async function fileProgress(cred: Credential, http: HttpTransport, file: string): Promise<FileProgress> {
  const row = await bookorbitStatsJson(cred, http, `/books/files/${encodeURIComponent(file)}/progress`);
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
      typeof row.percentage !== 'number' || !Number.isFinite(row.percentage)) {
    throw new ConnectorOperationError('BookOrbit returned invalid progress', true);
  }
  return row;
}

/**
 * The match's EPUB file and its progress. Merging duplicate books in BookOrbit deletes one copy's
 * file, so a remembered file that 404s is looked up again from the book once.
 */
async function fileWithProgress(
  cred: Credential, c: OrbitCred, http: HttpTransport, m: Match, ctx?: ConnectorContext
): Promise<{ file: string; row: FileProgress } | null> {
  let file = m.externalEdition ?? (await fileId(http, c, m.externalId));
  if (!file) return null;
  try {
    return { file, row: await fileProgress(cred, http, file) };
  } catch (err) {
    if (!m.externalEdition || !(err instanceof OrbitRequestError) || err.status !== 404) throw err;
    const stale = file;
    file = await fileId(http, c, m.externalId);
    if (!file || file === stale) throw err;
    if (ctx?.document) replaceMatchEdition(ctx.db, ctx.userId, 'bookorbit', ctx.document, m.externalId, stale, file);
    return { file, row: await fileProgress(cred, http, file) };
  }
}

function progressUpdatedAt(row: FileProgress): number {
  const textTime = typeof row.textUpdatedAt === 'string' ? Date.parse(row.textUpdatedAt) : NaN;
  if (Number.isFinite(textTime)) return textTime;
  return typeof row.updatedAt === 'string' ? Date.parse(row.updatedAt) : NaN;
}

async function pullProgress(
  cred: Credential, m: Match, http: HttpTransport, sinceMs: number, ctx?: ConnectorContext
): Promise<InboundChange | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const found = await fileWithProgress(cred, c, http, m, ctx);
  if (!found) return null;
  const { file, row } = found;
  const updatedAtMs = progressUpdatedAt(row);
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= sinceMs) return null;
  const pct = Math.max(0, Math.min(1, row.percentage / 100));
  // Every BookOrbit save replaces both fields, so whichever is set is current:
  // koreaderProgress is ours (or a KOReader's), cfi is its web reader's.
  let progress: string | undefined;
  if (typeof row.koreaderProgress === 'string' && row.koreaderProgress.startsWith('/body/')) {
    progress = row.koreaderProgress;
  } else if (typeof row.cfi === 'string' && row.cfi) {
    const cfi = row.cfi;
    progress = await positionMap(http, c, m, file, ctx, (b) => epubXPath(b, cfi)).catch(() => undefined);
  }
  return { externalId: m.externalId, percentage: pct, finished: pct >= 0.999, updatedAtMs, ...(progress ? { progress } : {}) };
}

/** Position lookups run on the book's stored redacted map, keyed by book like the match. */
function positionMap<T>(
  http: HttpTransport, c: OrbitCred, m: Match, file: string, ctx: ConnectorContext | undefined, use: (b: Epub) => Promise<T>
): Promise<T> {
  return withEpubMap(ctx, 'bookorbit', m.externalId, () => epub(http, c, file), use);
}

/** BookOrbit's copy of the book, briefly cached (text entries only). Highlights need its real text. */
function epub(http: HttpTransport, c: OrbitCred, file: string) {
  return cachedEpub(['bookorbit', api(c), c.username, file], async () => {
    const res = await call(http, c, 'GET', `/books/files/${encodeURIComponent(file)}/serve`);
    if (res.status < 200 || res.status >= 300) {
      throw new ConnectorOperationError(`BookOrbit EPUB download failed (${res.status})`, res.status === 429 || res.status >= 500);
    }
    return res;
  });
}

async function pullHighlights(
  cred: Credential, m: Match, http: HttpTransport, skip: (text: string) => boolean
): Promise<InboundHighlight[]> {
  const c = parseCred(cred);
  if (!c) return [];
  const rows = await bookorbitStatsJson(cred, http, `/books/${encodeURIComponent(m.externalId)}/annotations`);
  if (!Array.isArray(rows)) throw new ConnectorOperationError('BookOrbit returned invalid highlights', true);
  const out: InboundHighlight[] = [];
  for (const a of Array.isArray(rows) ? rows : []) {
    if (typeof a?.cfi !== 'string' || typeof a.text !== 'string' || skip(a.text)) continue;
    const file = a.jumpFileId != null ? String(a.jumpFileId) : m.externalEdition ?? (await fileId(http, c, m.externalId));
    if (!file) continue;
    // A CFI we can't place, or one that doesn't hold the quote, is skipped rather than guessed.
    const at = await epub(http, c, file).then((b) => epubRangeOffsets(b, a.cfi)).catch(() => null);
    if (!at || !squash(at.text).startsWith(squash(a.text).slice(0, 40))) continue;
    const created = Date.parse(a.highlightedAt ?? a.createdAt);
    out.push({
      text: at.text, note: typeof a.note === 'string' && a.note ? a.note : null,
      chapter: typeof a.chapterTitle === 'string' ? a.chapterTitle : null,
      spine: at.spine, startOffset: at.start, endOffset: at.end,
      createdAt: Number.isFinite(created) ? Math.floor(created / 1000) : 0,
    });
  }
  return out;
}

async function result(res: Awaited<ReturnType<HttpTransport>>): Promise<PushResult> {
  const status = res.status;
  if (status >= 200 && status < 300) return { ok: true };
  if (await authFailure(res)) return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  if (status === 403) return { ok: false, retryable: false, error: 'no access to this book in BookOrbit' };
  if (status === 429) return { ok: false, retryable: true, error: 'rate limited' };
  if (status >= 500) return { ok: false, retryable: true, error: `server ${status}` };
  return { ok: false, retryable: false, error: `unexpected status ${status}` };
}

// Whitespace and soft hyphens differ between the firmware's clipping text and the raw EPUB text.
const squash = normalizeEpubQuote;

/**
 * Clippings become BookOrbit highlights at the exact spot: the firmware's chapter
 * codepoint offsets resolve to a range CFI in BookOrbit's own copy of the EPUB.
 * Re-sent clippings update the note on the existing annotation instead of duplicating it.
 */
async function pushHighlight(http: HttpTransport, c: OrbitCred, m: Match, file: string, h: NonNullable<OutboundEvent['highlight']>): Promise<PushResult> {
  const bookBytes = await epub(http, c, file);
  const positioned = h.spine != null && h.startOffset != null && h.endOffset != null;
  const { cfi, text } = positioned
    ? await epubRangeCfi(bookBytes, h.spine!, h.startOffset!, h.endOffset!)
    : await epubQuoteRangeCfi(bookBytes, h.text);
  if (positioned && !squash(text).startsWith(squash(h.text).slice(0, 40))) {
    return { ok: false, retryable: false, error: 'clipping text not found at its position in the BookOrbit copy of the book' };
  }
  const book = encodeURIComponent(m.externalId);
  const existing = await bookorbitStatsJson(c, http, `/books/${book}/annotations`);
  if (!Array.isArray(existing)) throw new ConnectorOperationError('BookOrbit returned invalid highlights', true);
  let same = existing.find((a: any) => a?.cfi === cfi);
  // Imported CFIs may include ID assertions or use another equivalent range
  // spelling. Compare their actual offsets before creating a duplicate on push.
  if (!same && existing.length) {
    const target = await epubRangeOffsets(bookBytes, cfi);
    for (const a of existing) {
      if (typeof a?.cfi !== 'string' || typeof a.text !== 'string' || squash(a.text) !== squash(h.text)) continue;
      if (a.jumpFileId != null && String(a.jumpFileId) !== file) continue;
      const at = await epubRangeOffsets(bookBytes, a.cfi).catch(() => null);
      if (at && at.spine === target.spine && at.start === target.start && at.end === target.end) { same = a; break; }
    }
  }
  if (same) {
    if ((same.note ?? null) === (h.note ?? null)) return { ok: true };
    return result(await call(http, c, 'PATCH', `/books/${book}/annotations/${encodeURIComponent(same.id)}`, { note: h.note ?? null }));
  }
  const body: Record<string, unknown> = { cfi, bookFileId: Number(file), text: h.text };
  if (h.note) body.note = h.note;
  if (h.chapter) body.chapterTitle = h.chapter.slice(0, 500);
  return result(await call(http, c, 'POST', `/books/${book}/annotations`, body));
}

async function push(
  cred: Credential, m: Match, ev: OutboundEvent, http: HttpTransport, ctx?: ConnectorContext
): Promise<PushResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, retryable: false, needsReauth: true, error: 'bad credential' };
  try {
    if (ev.kind === 'highlight') {
      const file = (await fileWithProgress(cred, c, http, m, ctx))?.file;
      if (!file) return { ok: false, retryable: false, error: 'book has no EPUB file in BookOrbit' };
      return ev.highlight ? await pushHighlight(http, c, m, file, ev.highlight) : { ok: true };
    }
    const pct = Math.max(0, Math.min(1, ev.percentage ?? 0));
    const finished = ev.kind === 'finished' || pct >= 0.999;
    const found = await fileWithProgress(cred, c, http, m, ctx);
    if (!found) return { ok: false, retryable: false, error: 'book has no EPUB file in BookOrbit' };
    const { file, row: current } = found;

    // Backfills and delayed queue jobs retain the original reading timestamp.
    // Do not replace a position saved more recently by another reader.
    const updated = progressUpdatedAt(current);
    if (Number.isFinite(updated) && Math.floor(updated / 1000) > ev.timestamp) return { ok: true };

    // Enough precision that pulling our own write back reads as the same position, not an edit.
    const body: Record<string, unknown> = { percentage: Math.round((finished ? 1 : pct) * 1_000_000) / 10_000 };
    // KOReader-style XPointers are what BookOrbit stores for its KOReader devices;
    // the CFI is what its web reader resumes from. A CFI miss still saves the rest.
    if (ev.progress?.startsWith('/body')) {
      const xpath = ev.progress;
      body.koreaderProgress = xpath;
      const at = await positionMap(http, c, m, file, ctx, (b) => epubPosition(b, xpath)).catch(() => null);
      if (at) body.cfi = at.cfi;
    }
    const saved = await result(await call(http, c, 'POST', `/books/files/${encodeURIComponent(file)}/progress`, body));
    if (!saved.ok || !finished) return saved;
    return result(await call(http, c, 'PATCH', `/books/${encodeURIComponent(m.externalId)}/status`, { status: 'read' }));
  } catch (err) {
    if (err instanceof ConnectorOperationError) {
      return { ok: false, retryable: err.retryable, needsReauth: err.needsReauth, error: err.message };
    }
    return { ok: false, retryable: true, error: err instanceof Error ? err.message : String(err) };
  }
}

export const bookorbitConnector: Connector = {
  id: 'bookorbit',
  displayName: 'BookOrbit',
  tier: 1,
  capabilities: { read: true, write: true },
  carries: ['progress', 'finished', 'highlight'],
  credentialKind: 'kosync',
  beta: true,
  validate,
  match,
  push,
  search,
  resolveEdition,
  pullProgress,
  pullHighlights,
};
