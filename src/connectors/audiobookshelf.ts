import { ConnectorOperationError } from './types.js';
import { cachedEpub, epubPosition, epubXPath, withEpubMap, type TextEpub } from './bookfusion-epub.js';
import { decideMatch, extractTitleAuthor, type Candidate } from './matching.js';
import { audioToText, textToAudio } from './spotify.js';
import { getMatchAnchor } from './store.js';
import type {
  Connector,
  ConnectorContext,
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
 * Audiobookshelf connector (Tier 1). Syncs reading position to a self-hosted
 * Audiobookshelf server so your book progress moves the matching audiobook, and
 * (later, via fan-in) vice versa. Self-hosted Whispersync.
 *
 * Position is percentage-based: ABS derives a book's `progress` from
 * `currentTime / duration`, so we map ebook% -> currentTime = pct * duration.
 * This is approximate (text position != audio time) but lands you at roughly
 * the right spot. Verified against api.audiobookshelf.org + the ABS source.
 *
 * When the ABS item also has an EPUB, the device's KOReader XPath is resolved
 * against that EPUB into an exact CFI and sent as `ebookLocation` (with
 * `ebookProgress`). ABS's built-in reader resumes from `ebookLocation` only,
 * so without it "Read" always opened at the start of the book.
 */

interface AbsCred extends Credential {
  server: string;
  token: string;
}

function parseCred(cred: Credential): AbsCred | null {
  const server = typeof cred.server === 'string' ? cred.server.trim() : '';
  const token = typeof cred.token === 'string' ? cred.token.trim() : '';
  if (!server || !token) return null;
  return { server, token };
}

/** Normalize a server URL: add scheme if missing, strip trailing slashes. */
export function baseUrl(server: string): string {
  let url = server.includes('://') ? server : `https://${server}`;
  while (url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

async function absGet(http: HttpTransport, c: AbsCred, path: string) {
  const res = await http(`${baseUrl(c.server)}${path}`, { method: 'GET', headers: authHeaders(c.token) });
  let body: any = null;
  if (res.status >= 200 && res.status < 300) {
    try {
      body = await res.json();
    } catch {
      body = null;
    }
  }
  return { status: res.status, body };
}

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  const c = parseCred(cred);
  if (!c) return { ok: false, error: 'server URL and API key are required' };
  try {
    const r = await absGet(http, c, '/api/me');
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'invalid API key' };
    if (r.status >= 200 && r.status < 300) {
      return { ok: true, accountLabel: r.body?.username ? `${r.body.username} @ ${c.server}` : c.server };
    }
    return { ok: false, error: `unexpected status ${r.status}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Pull book (mediaType === 'book') library ids. */
async function bookLibraryIds(http: HttpTransport, c: AbsCred): Promise<string[]> {
  const r = await absGet(http, c, '/api/libraries');
  const libs = Array.isArray(r.body?.libraries) ? r.body.libraries : [];
  return libs.filter((l: any) => l?.mediaType === 'book' && l?.id).map((l: any) => String(l.id));
}

/** GET a library item, adapting to the { id, media: { metadata, duration } } shape. */
export function itemToCandidate(item: any): (Candidate & { duration?: number }) | null {
  const li = item?.libraryItem ?? item;
  const id = li?.id;
  const meta = li?.media?.metadata;
  const title = meta?.title;
  if (id == null || typeof title !== 'string') return null;
  const duration = typeof li?.media?.duration === 'number' ? li.media.duration : undefined;
  return { externalId: String(id), title, author: meta?.authorName ?? undefined, duration };
}

async function match(cred: Credential, doc: DocumentMeta, http: HttpTransport): Promise<Match | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const ta = extractTitleAuthor(doc);
  if (!ta) return null;
  // ABS search matches best on the title alone; author is only used to score
  // and disambiguate the results (searching "title author" returns little).
  const q = ta.title.trim();

  const libIds = await bookLibraryIds(http, c);
  const candidates: (Candidate & { duration?: number })[] = [];
  for (const libId of libIds.length ? libIds : ['']) {
    const path = libId
      ? `/api/libraries/${encodeURIComponent(libId)}/search?q=${encodeURIComponent(q)}`
      : '';
    if (!path) continue;
    const r = await absGet(http, c, path);
    const books = Array.isArray(r.body?.book) ? r.body.book : Array.isArray(r.body?.results) ? r.body.results : [];
    for (const b of books) {
      const cand = itemToCandidate(b);
      if (cand) candidates.push(cand);
    }
  }
  if (candidates.length === 0) return null;
  const decision = decideMatch(ta.title, ta.author, candidates);
  if (!decision.accepted || !decision.best) return null;
  const chosen = candidates.find((x) => x.externalId === decision.best!.externalId);
  return {
    externalId: decision.best.externalId,
    // Cache the duration so push doesn't need an extra fetch.
    externalEdition: chosen?.duration != null ? String(chosen.duration) : null,
    confidence: decision.best.score,
    queryUsed: q,
    title: chosen?.title ?? null,
    author: chosen?.author ?? null,
  };
}

/** Books the user has in progress (a small, high-signal candidate pool). */
async function listCurrentlyReading(cred: Credential, http: HttpTransport): Promise<ExternalBook[]> {
  const c = parseCred(cred);
  if (!c) return [];
  const r = await absGet(http, c, '/api/me/items-in-progress');
  const items = Array.isArray(r.body?.libraryItems) ? r.body.libraryItems : [];
  const out: ExternalBook[] = [];
  for (const it of items) {
    const cand = itemToCandidate(it);
    if (cand) out.push({ externalId: cand.externalId, title: cand.title, author: cand.author ?? null, edition: cand.duration != null ? String(cand.duration) : null });
  }
  return out;
}

/** Search the user's book libraries (for the manual-match picker). */
async function search(cred: Credential, query: string, http: HttpTransport): Promise<ExternalBook[]> {
  const c = parseCred(cred);
  if (!c) return [];
  const libIds = await bookLibraryIds(http, c);
  const out: ExternalBook[] = [];
  for (const libId of libIds) {
    const r = await absGet(http, c, `/api/libraries/${encodeURIComponent(libId)}/search?q=${encodeURIComponent(query)}`);
    const books = Array.isArray(r.body?.book) ? r.body.book : Array.isArray(r.body?.results) ? r.body.results : [];
    for (const b of books) {
      const cand = itemToCandidate(b);
      if (cand) out.push({ externalId: cand.externalId, title: cand.title, author: cand.author ?? null, edition: cand.duration != null ? String(cand.duration) : null });
    }
  }
  return out;
}

/** Fetch an item's audiobook duration in seconds (null if unknown). */
async function fetchDuration(http: HttpTransport, c: AbsCred, externalId: string): Promise<number | null> {
  const r = await absGet(http, c, `/api/items/${encodeURIComponent(externalId)}?expanded=1`);
  return fetchDurationFrom(r.body?.media);
}

/** An item's duration from its media: media.duration, else the audio files summed. */
function fetchDurationFrom(media: any): number | null {
  const d = media?.duration;
  if (typeof d === 'number' && d > 0) return d;
  // Fall back to summing the audio files (older ABS items omit media.duration).
  const files = Array.isArray(media?.audioFiles) ? media.audioFiles : [];
  const sum = files.reduce((acc: number, f: any) => acc + (typeof f?.duration === 'number' ? f.duration : 0), 0);
  return sum > 0 ? sum : null;
}

/**
 * The item's chapters with where each starts (ms), for the calibration picker,
 * plus the listening position. A chapterless item is one "track" spanning the book.
 */
export async function absTracks(cred: Credential, externalId: string, http: HttpTransport) {
  const c = parseCred(cred);
  if (!c) throw new ConnectorOperationError('bad credential', false, true);
  const [item, prog] = await Promise.all([
    absGet(http, c, `/api/items/${encodeURIComponent(externalId)}?expanded=1`),
    absGet(http, c, `/api/me/progress/${encodeURIComponent(externalId)}`),
  ]);
  if (item.status === 401 || item.status === 403) throw new ConnectorOperationError('unauthorized', false, true);
  if (item.status < 200 || item.status >= 300) throw new ConnectorOperationError(`Audiobookshelf item request failed (${item.status})`, item.status >= 500);
  const total_ms = Math.round((fetchDurationFrom(item.body?.media) ?? 0) * 1000);
  const chapters = Array.isArray(item.body?.media?.chapters) ? item.body.media.chapters : [];
  const tracks = chapters.length
    ? chapters.map((ch: any, index: number) => ({
        index, name: String(ch?.title ?? `Chapter ${index + 1}`),
        start_ms: Math.round((Number(ch?.start) || 0) * 1000),
        duration_ms: Math.max(0, Math.round(((Number(ch?.end) || 0) - (Number(ch?.start) || 0)) * 1000)),
      }))
    : [{ index: 0, name: 'Whole book', start_ms: 0, duration_ms: total_ms }];
  const p = prog.body;
  const position_ms = typeof p?.currentTime === 'number' ? Math.round(p.currentTime * 1000) : null;
  return { tracks, total_ms, position_ms, finished: !!p?.isFinished, listened_pct: total_ms && position_ms != null ? position_ms / total_ms : null };
}

/** Resolve the audiobook duration (seconds): cached on the match, else fetch. */
async function resolveDuration(http: HttpTransport, c: AbsCred, m: Match): Promise<number | null> {
  const cached = m.externalEdition ? Number(m.externalEdition) : NaN;
  if (Number.isFinite(cached) && cached > 0) return cached;
  return fetchDuration(http, c, m.externalId);
}

/** Resolve+cache the duration for a chosen item (called when a match is saved). */
async function resolveEdition(cred: Credential, externalId: string, http: HttpTransport): Promise<string | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const d = await fetchDuration(http, c, externalId);
  return d != null ? String(d) : null;
}

/** Items recently found to have no downloadable EPUB (audio-only), so pushes skip the lookup. */
const noEpub = new Map<string, number>();
const NO_EPUB_TTL = 60 * 60 * 1000;

function noEpubKey(c: AbsCred, externalId: string): string {
  return `${baseUrl(c.server)}\n${externalId}`;
}

/** The item's primary EPUB from ABS (`GET /api/items/:id/ebook`), briefly cached (text entries only). */
function absEpub(http: HttpTransport, c: AbsCred, externalId: string): Promise<TextEpub> {
  return cachedEpub(['audiobookshelf', baseUrl(c.server), c.token, externalId], async () => {
    const res = await http(`${baseUrl(c.server)}/api/items/${encodeURIComponent(externalId)}/ebook`, {
      method: 'GET',
      headers: { authorization: `Bearer ${c.token}` },
    });
    if (res.status === 404 || res.status === 400) noEpub.set(noEpubKey(c, externalId), Date.now() + NO_EPUB_TTL);
    if (res.status < 200 || res.status >= 300) throw new Error(`ABS ebook download failed (${res.status})`);
    return res;
  });
}

function knownNoEpub(c: AbsCred, externalId: string): boolean {
  const key = noEpubKey(c, externalId);
  const until = noEpub.get(key);
  if (until === undefined) return false;
  if (until > Date.now()) return true;
  noEpub.delete(key);
  return false;
}

/** Test hook: forget which items were found to have no EPUB. */
export function clearAbsNoEpubCache(): void {
  noEpub.clear();
}

/**
 * Resolve a KOReader XPath to an EPUB CFI in the ABS item's own EPUB. Null when
 * the item has no EPUB or the position can't be placed - the push still lands
 * the percentage, it just can't give ABS's reader an exact resume point.
 */
async function resolveCfi(
  http: HttpTransport, c: AbsCred, m: Match, xpath: string, ctx?: ConnectorContext
): Promise<string | null> {
  if (knownNoEpub(c, m.externalId)) return null;
  try {
    const at = await withEpubMap(ctx, 'audiobookshelf', m.externalId, () => absEpub(http, c, m.externalId), (b) => epubPosition(b, xpath));
    return at.cfi;
  } catch {
    return null;
  }
}

/**
 * Pull this book's ABS position when a device asks for progress (and match it on
 * demand), so opening a book you've been listening to jumps to the audiobook's
 * spot before the device's older position is pushed over it. ABS derives
 * `progress` from currentTime/duration, so it maps straight back to a reading
 * percentage.
 */
async function pullProgress(
  cred: Credential, m: Match, http: HttpTransport, sinceMs: number, ctx?: ConnectorContext
): Promise<InboundChange | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const { status, body: p } = await absGet(http, c, `/api/me/progress/${encodeURIComponent(m.externalId)}`);
  if (status === 404) return null; // No reading position yet.
  if (status < 200 || status >= 300 || !p) {
    throw new ConnectorOperationError(`Audiobookshelf progress request failed (${status})`, status === 429 || status >= 500, status === 401 || status === 403);
  }
  const lu = typeof p?.lastUpdate === 'number' ? p.lastUpdate : 0;
  if (!p || lu <= sinceMs) return null;
  const hasAudio = typeof p.duration === 'number' && p.duration > 0;
  let pct = typeof p.progress === 'number' ? p.progress : 0;
  if (!pct && hasAudio && typeof p.currentTime === 'number') {
    pct = p.currentTime / p.duration;
  }
  // "Not the right spot?" calibration: listening % -> reading %.
  if (hasAudio && ctx) pct = audioToText(pct, getMatchAnchor(ctx.db, ctx.userId, 'audiobookshelf', m.externalId));
  // Ebook-only items are read in ABS's own reader, which records its position
  // as ebookProgress + an ebookLocation CFI rather than `progress`. Items with
  // audio keep the listening position (that is the audiobook<->ebook sync).
  let progress: string | undefined;
  if (!hasAudio && typeof p.ebookProgress === 'number') {
    pct = p.ebookProgress;
    const cfi = p.ebookLocation;
    if (typeof cfi === 'string' && cfi.startsWith('epubcfi(') && !knownNoEpub(c, m.externalId)) {
      progress = await absEpub(http, c, m.externalId).then((b) => epubXPath(b, cfi)).catch(() => undefined);
    }
  }
  return {
    externalId: m.externalId,
    percentage: Math.max(0, Math.min(1, pct)),
    finished: !!p.isFinished,
    ...(progress ? { progress } : {}),
    updatedAtMs: lu,
  };
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
  const pct = Math.max(0, Math.min(1, ev.percentage ?? 0));
  const finished = ev.kind === 'finished' || pct >= 0.999;

  // ABS accepts a `progress` fraction directly, so we can always update the
  // reading position even when we can't resolve the audiobook duration. When we
  // DO know the duration we also send currentTime/duration so the app seeks to
  // the right spot in the audio.
  //
  // IMPORTANT: ABS ignores the `progress` field when the payload also carries
  // `isFinished: false` (verified against a live server) - it only updates the
  // displayed progress if isFinished is absent or true. So we send isFinished
  // ONLY when finishing; otherwise we omit it and let progress/currentTime land.
  const duration = await resolveDuration(http, c, m);
  // The listening side goes through the calibration; ebookProgress below stays the reading %.
  const audio = ctx ? textToAudio(pct, getMatchAnchor(ctx.db, ctx.userId, 'audiobookshelf', m.externalId)) : pct;
  const payload: Record<string, unknown> = { progress: finished ? 1 : audio };
  if (finished) payload.isFinished = true;
  if (duration) {
    payload.duration = duration;
    payload.currentTime = Math.max(0, Math.min(duration, audio * duration));
  }

  // The ebook side of the same progress record. ABS's reader shows ebookProgress
  // and resumes from ebookLocation (a CFI); `progress` alone opens at page one.
  payload.ebookProgress = finished ? 1 : pct;
  if (!finished && ev.progress?.startsWith('/body')) {
    const cfi = await resolveCfi(http, c, m, ev.progress, ctx);
    if (cfi) payload.ebookLocation = cfi;
  }

  const res = await http(`${baseUrl(c.server)}/api/me/progress/${encodeURIComponent(m.externalId)}`, {
    method: 'PATCH',
    headers: authHeaders(c.token),
    body: JSON.stringify(payload),
  });
  if (res.status === 401 || res.status === 403) {
    return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  }
  if (res.status === 429) return { ok: false, retryable: true, error: 'rate limited' };
  if (res.status >= 500) return { ok: false, retryable: true, error: `server ${res.status}` };
  if (res.status >= 200 && res.status < 300) return { ok: true };
  return { ok: false, retryable: false, error: `unexpected status ${res.status}` };
}

export const audiobookshelfConnector: Connector = {
  id: 'audiobookshelf',
  displayName: 'Audiobookshelf',
  tier: 1,
  capabilities: { read: true, write: true },
  carries: ['progress', 'finished'],
  credentialKind: 'abs',
  beta: false,
  validate,
  match,
  push,
  listCurrentlyReading,
  search,
  resolveEdition,
  pullProgress,
};
