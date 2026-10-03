import { decideMatch, extractTitleAuthor, type Candidate } from './matching.js';
import { baseUrl } from './audiobookshelf.js';
import { cachedEpub, epubPosition, epubRangeCfi, epubRangeOffsets, epubXPath, withEpubMap, type Epub } from './bookfusion-epub.js';
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
 * Auth is the BookOrbit account (password login, "native" client so we get a
 * refresh token). Access tokens are short-lived (15m default) and cached in
 * memory; a restart just logs in again.
 */

interface OrbitCred extends Credential {
  server: string;
  username: string;
  password: string;
}

function parseCred(cred: Credential): OrbitCred | null {
  const server = typeof cred.server === 'string' ? cred.server.trim() : '';
  const username = typeof cred.username === 'string' ? cred.username.trim() : '';
  const password = typeof cred.password === 'string' ? cred.password : '';
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
  const res = await post('/auth/login', {
    username: c.username,
    password: c.password,
    clientKind: 'native',
    deviceLabel: 'CrossPoint Sync',
  });
  if (res.status === 200) return store(res);
  if (res.status === 401 || res.status === 403) throw new ConnectorOperationError('invalid BookOrbit username or password', false, true);
  if (res.status === 429) throw new ConnectorOperationError('BookOrbit rate limited the login', true);
  throw new ConnectorOperationError(`BookOrbit login failed (${res.status})`, res.status >= 500);
}

/** Authenticated request; re-logs in once if the cached token was revoked. */
async function call(http: HttpTransport, c: OrbitCred, method: string, path: string, body?: unknown) {
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

async function getJson(http: HttpTransport, c: OrbitCred, path: string): Promise<any> {
  const res = await call(http, c, 'GET', path);
  if (res.status < 200 || res.status >= 300) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, error: 'server URL, username and password are required' };
  try {
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

async function pullProgress(
  cred: Credential, m: Match, http: HttpTransport, sinceMs: number, ctx?: ConnectorContext
): Promise<InboundChange | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const rows = await getJson(http, c, `/books/${encodeURIComponent(m.externalId)}/progress`);
  if (!Array.isArray(rows)) return null;
  const row = rows.find((r: any) => String(r?.fileId) === m.externalEdition) ?? rows[0];
  if (!row || typeof row.percentage !== 'number') return null;
  const updatedAtMs = row.updatedAt ? Date.parse(row.updatedAt) : NaN;
  if (!Number.isFinite(updatedAtMs) || updatedAtMs <= sinceMs) return null;
  const pct = Math.max(0, Math.min(1, row.percentage / 100));
  // Every BookOrbit save replaces both fields, so whichever is set is current:
  // koreaderProgress is ours (or a KOReader's), cfi is its web reader's.
  let progress: string | undefined;
  if (typeof row.koreaderProgress === 'string' && row.koreaderProgress.startsWith('/body/')) {
    progress = row.koreaderProgress;
  } else if (typeof row.cfi === 'string' && row.cfi && m.externalEdition && String(row.fileId) === m.externalEdition) {
    // The stored map is of the matched file; progress on another file stays a percentage.
    progress = await positionMap(http, c, m, m.externalEdition, ctx, (b) => epubXPath(b, row.cfi)).catch(() => undefined);
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
  const rows = await getJson(http, c, `/books/${encodeURIComponent(m.externalId)}/annotations`);
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

function result(status: number): PushResult {
  if (status >= 200 && status < 300) return { ok: true };
  if (status === 401 || status === 403) return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  if (status === 429) return { ok: false, retryable: true, error: 'rate limited' };
  if (status >= 500) return { ok: false, retryable: true, error: `server ${status}` };
  return { ok: false, retryable: false, error: `unexpected status ${status}` };
}

// Whitespace and soft hyphens differ between the firmware's clipping text and the raw EPUB text.
const squash = (t: string) => t.replace(/[\s\u00ad]+/g, '');

/**
 * Clippings become BookOrbit highlights at the exact spot: the firmware's chapter
 * codepoint offsets resolve to a range CFI in BookOrbit's own copy of the EPUB.
 * Re-sent clippings update the note on the existing annotation instead of duplicating it.
 */
async function pushHighlight(http: HttpTransport, c: OrbitCred, m: Match, file: string, h: NonNullable<OutboundEvent['highlight']>): Promise<PushResult> {
  if (h.spine == null || h.startOffset == null || h.endOffset == null) {
    return { ok: false, retryable: false, error: 'clipping has no position (update the reader firmware)' };
  }
  const { cfi, text } = await epubRangeCfi(await epub(http, c, file), h.spine, h.startOffset, h.endOffset);
  if (!squash(text).startsWith(squash(h.text).slice(0, 40))) {
    return { ok: false, retryable: false, error: 'clipping text not found at its position in the BookOrbit copy of the book' };
  }
  const book = encodeURIComponent(m.externalId);
  const existing = await getJson(http, c, `/books/${book}/annotations`);
  const same = (Array.isArray(existing) ? existing : []).find((a: any) => a?.cfi === cfi);
  if (same) {
    if ((same.note ?? null) === (h.note ?? null)) return { ok: true };
    return result((await call(http, c, 'PATCH', `/books/${book}/annotations/${encodeURIComponent(same.id)}`, { note: h.note ?? null })).status);
  }
  const body: Record<string, unknown> = { cfi, bookFileId: Number(file), text: h.text };
  if (h.note) body.note = h.note;
  if (h.chapter) body.chapterTitle = h.chapter.slice(0, 500);
  return result((await call(http, c, 'POST', `/books/${book}/annotations`, body)).status);
}

async function push(
  cred: Credential, m: Match, ev: OutboundEvent, http: HttpTransport, ctx?: ConnectorContext
): Promise<PushResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, retryable: false, needsReauth: true, error: 'bad credential' };
  try {
    if (ev.kind === 'highlight') {
      const file = m.externalEdition ?? (await fileId(http, c, m.externalId));
      if (!file) return { ok: false, retryable: false, error: 'book has no EPUB file in BookOrbit' };
      return ev.highlight ? await pushHighlight(http, c, m, file, ev.highlight) : { ok: true };
    }
    const pct = Math.max(0, Math.min(1, ev.percentage ?? 0));
    const finished = ev.kind === 'finished' || pct >= 0.999;
    const file = m.externalEdition ?? (await fileId(http, c, m.externalId));
    if (!file) return { ok: false, retryable: false, error: 'book has no EPUB file in BookOrbit' };

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
    const saved = result((await call(http, c, 'POST', `/books/files/${encodeURIComponent(file)}/progress`, body)).status);
    if (!saved.ok || !finished) return saved;
    return result((await call(http, c, 'PATCH', `/books/${encodeURIComponent(m.externalId)}/status`, { status: 'read' })).status);
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
