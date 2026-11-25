import type { DB } from '../db/db.js';
import type { HttpTransport } from '../connectors/types.js';
import { fetchTransport } from '../connectors/registry.js';
import { documentMeta } from '../connectors/store.js';
import { extractTitleAuthor, scoreCandidate, type Candidate } from '../connectors/matching.js';
import { nowSeconds } from './sync.js';
import { cacheKey, cachedHardcoverBook, hardcoverBook, metadataApiUrl, tidy, type HardcoverBook } from './hardcover-catalog.js';
import { LIBRARY_HIT_TTL, libraryBook, libraryConfig, sameAuthor, sameTitle, storeLibraryCover, type LibraryBook } from './library.js';
import { keepManual } from './manual-details.js';

/**
 * Cover art and print page count from title/author. Covers use the same
 * sources as Mayberry's no-ISBN fallback: iTunes Search (entity=ebook, 600px
 * artwork) first, then Open Library. Page counts come from Open Library's
 * median across editions, then Google Books when GOOGLE_BOOKS_API_KEY is set
 * (keyless Google Books has no quota). A book-metadata API (METADATA_API_URL)
 * and Hardcover fill the rest through hardcoverBook.
 * Only URLs and numbers are stored. A miss is remembered for RETRY_AFTER so we
 * don't hammer any of them.
 */
const RETRY_AFTER = 7 * 86400;
/** A book the user's library didn't have is asked again after a day: it may have been added since. */
const LIBRARY_MISS_RETRY = 86400;
const THRESHOLD = 0.6;
// Open Library asks API clients to identify themselves.
const OL_HEADERS = { 'user-agent': 'crosspoint-sync (https://github.com/crosspoint-reader/crosspoint-sync)' };

type BookCandidate = Candidate & { url?: string; pages?: number };

export interface BookInfo {
  cover: string | null;
  pages: number | null;
}

function best(title: string, author: string, cands: BookCandidate[], has: (c: BookCandidate) => unknown) {
  let top: { c: BookCandidate; score: number } | null = null;
  for (const c of cands) {
    if (!has(c)) continue;
    const score = scoreCandidate(title, author, c);
    if (score >= THRESHOLD && (!top || score > top.score)) top = { c, score };
  }
  return top?.c ?? null;
}

async function safe(p: Promise<BookCandidate[]>): Promise<BookCandidate[]> {
  try {
    return await p;
  } catch {
    return []; // network errors count as a miss
  }
}

// Apple Books is per country: a Japanese book is only in the Japanese store.
function storeFor(text: string): string {
  if (/[\u3040-\u30ff]/.test(text)) return 'jp'; // kana
  if (/[\uac00-\ud7af]/.test(text)) return 'kr'; // hangul
  if (/[\u4e00-\u9fff]/.test(text)) return 'tw'; // han without kana: Chinese
  return 'us';
}

async function itunes(http: HttpTransport, title: string, author: string): Promise<BookCandidate[]> {
  const term = `${title} ${author}`.trim();
  const q = new URLSearchParams({ term, entity: 'ebook', limit: '10', country: storeFor(term) });
  const res = await http(`https://itunes.apple.com/search?${q}`, { method: 'GET', signal: AbortSignal.timeout(8000) });
  if (res.status !== 200) return [];
  const body = (await res.json()) as { results?: { trackName?: string; artistName?: string; artworkUrl100?: string }[] };
  return (body.results ?? [])
    .filter((r) => r.trackName)
    .map((r, i) => ({
      externalId: String(i),
      title: r.trackName!,
      author: r.artistName,
      url: r.artworkUrl100?.replace('100x100bb', '600x600bb'),
    }));
}

async function openLibrary(http: HttpTransport, title: string, author: string): Promise<BookCandidate[]> {
  const q = new URLSearchParams({ title, limit: '10', fields: 'title,author_name,cover_i,number_of_pages_median' });
  if (author) q.set('author', author);
  const res = await http(`https://openlibrary.org/search.json?${q}`, {
    method: 'GET',
    headers: OL_HEADERS,
    signal: AbortSignal.timeout(8000),
  });
  if (res.status !== 200) return [];
  const body = (await res.json()) as {
    docs?: { title?: string; author_name?: string[]; cover_i?: number; number_of_pages_median?: number }[];
  };
  return (body.docs ?? [])
    .filter((d) => d.title)
    .map((d, i) => ({
      externalId: String(i),
      title: d.title!,
      author: d.author_name?.[0],
      url: d.cover_i ? `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg` : undefined,
      pages: d.number_of_pages_median,
    }));
}

async function googleBooks(http: HttpTransport, title: string, author: string, key: string): Promise<BookCandidate[]> {
  const q = new URLSearchParams({
    q: `intitle:${title}${author ? ` inauthor:${author}` : ''}`,
    maxResults: '10',
    fields: 'items(volumeInfo(title,authors,pageCount))',
    key,
  });
  const res = await http(`https://www.googleapis.com/books/v1/volumes?${q}`, {
    method: 'GET',
    signal: AbortSignal.timeout(8000),
  });
  if (res.status !== 200) return [];
  const body = (await res.json()) as { items?: { volumeInfo?: { title?: string; authors?: string[]; pageCount?: number } }[] };
  return (body.items ?? [])
    .filter((v) => v.volumeInfo?.title)
    .map((v, i) => ({
      externalId: String(i),
      title: v.volumeInfo!.title!,
      author: v.volumeInfo!.authors?.[0],
      pages: v.volumeInfo!.pageCount,
    }));
}

/** A title without bracketed edition notes or a trailing ": A Novel". */
export const editionless = (title: string) =>
  title.replace(/\s*[[(][^\])]*[\])]/g, '').replace(/:\s*a novel\s*$/i, '').trim() || title;

export async function findBookInfo(
  http: HttpTransport,
  title: string,
  author: string,
  env: NodeJS.ProcessEnv = process.env,
  known: { cover?: string | null; pages?: number | null } = {}
): Promise<BookInfo> {
  const [apple, ol] = await Promise.all([safe(itunes(http, title, author)), safe(openLibrary(http, title, author))]);
  // `known` (Hardcover's) fills in after the free sources, before the keyed ones.
  let cover = best(title, author, apple, (c) => c.url)?.url ?? best(title, author, ol, (c) => c.url)?.url ?? null;
  // Edition text ("Bel Canto [Movie Tie-In]: A Novel") hides a book from the searches.
  const plain = editionless(title);
  if (!cover && !known.cover && plain !== title) {
    const [apple2, ol2] = await Promise.all([safe(itunes(http, plain, author)), safe(openLibrary(http, plain, author))]);
    cover = best(plain, author, apple2, (c) => c.url)?.url ?? best(plain, author, ol2, (c) => c.url)?.url ?? null;
  }
  cover ??= known.cover ?? null;
  let pages = known.pages ?? best(title, author, ol, (c) => c.pages)?.pages ?? null;
  // A series prefix ("Game Changers 6: The Long Game") hides the book from Open Library.
  const short = title.split(': ').slice(1).join(': ');
  if (!pages && short) pages = best(short, author, await safe(openLibrary(http, short, author)), (c) => c.pages)?.pages ?? null;
  if (!pages && env.GOOGLE_BOOKS_API_KEY) {
    pages = best(title, author, await safe(googleBooks(http, title, author, env.GOOGLE_BOOKS_API_KEY)), (c) => c.pages)?.pages ?? null;
  }
  return { cover, pages };
}

export interface CoverCandidate {
  url: string;
  title: string;
  author: string | null;
  source: 'Apple Books' | 'Open Library';
  pages: number | null;
}

/** Every cover the sources offer for a title, best matches first: the app's cover picker. */
export async function coverCandidates(http: HttpTransport, title: string, author: string): Promise<CoverCandidate[]> {
  const [apple, ol] = await Promise.all([safe(itunes(http, title, author)), safe(openLibrary(http, title, author))]);
  const tagged = [
    ...apple.map((c) => ({ ...c, source: 'Apple Books' as const })),
    ...ol.map((c) => ({ ...c, source: 'Open Library' as const })),
  ].filter((c) => c.url);
  const seen = new Set<string>();
  return tagged
    .map((c) => ({ c, score: scoreCandidate(title, author, c) }))
    .sort((a, b) => b.score - a.score)
    .filter(({ c }) => !seen.has(c.url!) && seen.add(c.url!))
    .slice(0, 12)
    .map(({ c }) => ({ url: c.url!, title: c.title, author: c.author ?? null, source: c.source, pages: c.pages ?? null }));
}

/** findBookInfo from the free sources, cached across users by title/author. */
async function sharedBookInfo(
  db: DB,
  http: HttpTransport,
  title: string,
  author: string,
  env: NodeJS.ProcessEnv,
  known: { cover?: string | null; pages?: number | null }
): Promise<BookInfo> {
  const key = `info:${cacheKey(title, author)}`;
  const hit = db.prepare('SELECT data, checked_at FROM catalog_cache WHERE key = ?').get(key) as
    | { data: string; checked_at: number }
    | undefined;
  const cached = hit ? (JSON.parse(hit.data) as BookInfo) : null;
  if (hit && cached && (cached.pages || nowSeconds() - hit.checked_at < RETRY_AFTER)) {
    return { cover: cached.cover ?? known.cover ?? null, pages: cached.pages ?? known.pages ?? null };
  }
  const info = await findBookInfo(http, title, author, env, known);
  db.prepare(
    `INSERT INTO catalog_cache (key, data, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET data = excluded.data, checked_at = excluded.checked_at`
  ).run(key, JSON.stringify(info), nowSeconds());
  return info;
}

/**
 * The user's library (LIBRARY_OPDS_URL) is the truth for a book it holds: its details win. The other
 * sources' answer is kept only when it is the same book (their match is fuzzy and can be another book by
 * the same author), and then fills what the library lacks.
 */
export function withLibrary(lib: LibraryBook | null, other: HardcoverBook | null): HardcoverBook | null {
  if (!lib) return other;
  // The library's rule for the same book: the same author, and the same title apart from a subtitle
  // on one side only (a fuzzy score would take "Saga: Book Two" for "Saga: Book One").
  const agrees = other !== null && sameAuthor(lib.author, other.author) && sameTitle(lib.title, other.title);
  const base: HardcoverBook = agrees
    ? other
    : {
        id: '', slug: null, title: lib.title, author: lib.author, moods: [], genres: [], content_warnings: [], rating: null,
        series: null, series_id: null, series_position: null, release_year: null, pages: null, cover: null, description: null,
      };
  const genres = tidy(lib.genres, 6);
  return {
    ...base,
    description: lib.description ?? base.description,
    genres: genres.length ? genres : base.genres,
    series: lib.series ?? base.series,
    series_id: lib.series ? null : base.series_id,
    series_position: lib.series ? lib.series_position : base.series_position,
    release_year: lib.release_year ?? base.release_year,
  };
}

/** Store Hardcover's details on a document (a miss just records the check). Details set by hand stay. */
function saveHardcover(db: DB, userId: number, document: string, hc: HardcoverBook | null): void {
  const json = (v: string[] | undefined) => (v?.length ? JSON.stringify(v) : null);
  db.prepare(
    `UPDATE documents SET hc_id = ?, hc_slug = ?, ${keepManual('moods')}, ${keepManual('genres')},
       ${keepManual('content_warnings')}, rating = ?, ${keepManual('series')}, ${keepManual('hc_series_id')},
       ${keepManual('series_position')}, ${keepManual('release_year')}, ${keepManual('description')}, hc_checked_at = ?
     WHERE user_id = ? AND document = ?`
  ).run(
    hc?.id || null, hc?.slug ?? null, json(hc?.moods), json(hc?.genres), json(hc?.content_warnings), hc?.rating ?? null,
    hc?.series ?? null, hc?.series_id ?? null, hc?.series_position ?? null, hc?.release_year ?? null,
    hc?.description ?? null, nowSeconds(), userId, document
  );
}

/** Cached cover URL + print page count for a document, resolving on first ask. The user's library
 *  (LIBRARY_OPDS_URL) is asked first. With it, METADATA_API_URL or HARDCOVER_API_KEY set, also fills the
 *  document's book details once. */
export async function documentInfo(
  db: DB,
  userId: number,
  document: string,
  http: HttpTransport = fetchTransport,
  env: NodeJS.ProcessEnv = process.env,
  // Hardcover lookups are throttled to ~1/s, so only the background enricher asks for them.
  { hardcover = false }: { hardcover?: boolean } = {}
): Promise<BookInfo> {
  const row = db
    .prepare(
      `SELECT cover_url, cover_manual, page_count, cover_checked_at, hc_checked_at, hc_id, library_checked_at, library_match
       FROM documents WHERE user_id = ? AND document = ?`
    )
    .get(userId, document) as
    | {
        cover_url: string | null;
        cover_manual: number;
        page_count: number | null;
        cover_checked_at: number | null;
        hc_checked_at: number | null;
        hc_id: string | null;
        library_checked_at: number | null;
        library_match: number;
      }
    | undefined;
  if (!row) return { cover: null, pages: null }; // no metadata, nothing to search on
  const want = extractTitleAuthor(documentMeta(db, userId, document));

  // The user's own library goes first. A book is due when the library never answered for it, didn't
  // have it a day ago, or had it a week ago (the library, or LIBRARY_OPDS_URL, may have changed since). Normal reads ask only for books without a cover; the background
  // enricher also brings books with older covers and details in line.
  const now = nowSeconds();
  const libraryOn = !!want && libraryConfig(env) !== null;
  const due =
    libraryOn &&
    (hardcover || !row.cover_url) &&
    (row.library_checked_at == null ||
      now - row.library_checked_at >= (row.library_match ? LIBRARY_HIT_TTL : LIBRARY_MISS_RETRY));
  const asked = due || (libraryOn && row.library_match) ? await libraryBook(db, http, want!.title, want!.author, env) : null;
  const lib = asked === 'later' ? null : asked;
  if (due && asked !== 'later') {
    let coverFailed = false;
    if (lib?.cover && !row.cover_manual) {
      // The library's cover replaces an automatic one (found earlier, or while the library was down).
      // A matched book's weekly refresh fetches the cover again: it may have changed in the library.
      const path = await storeLibraryCover(db, http, lib.cover, env, { refresh: !!row.library_match });
      coverFailed = !path;
      if (path && path !== row.cover_url) {
        row.cover_url = path;
        db.prepare('UPDATE documents SET cover_url = ?, cover_checked_at = ? WHERE user_id = ? AND document = ?').run(path, now, userId, document);
      }
    }
    // Details stored before the library had the book: its own go over them now (those set by hand stay).
    if (lib && row.hc_checked_at != null) {
      saveHardcover(db, userId, document, withLibrary(lib, row.hc_id ? cachedHardcoverBook(db, want!.title, want!.author) : null));
    }
    // A cover that couldn't be fetched counts as a miss for now, so it is tried again after a day.
    db.prepare('UPDATE documents SET library_checked_at = ?, library_match = ? WHERE user_id = ? AND document = ?').run(now, lib && !coverFailed ? 1 : 0, userId, document);
  }
  const external = metadataApiUrl(env) || env.HARDCOVER_API_KEY || env.ISBNDB_API_KEY;
  let hc: HardcoverBook | null = null;
  // A library that can't be asked right now leaves the book for the next round, so its details aren't missed.
  if (hardcover && want && (external || libraryConfig(env)) && row.hc_checked_at == null && asked !== 'later') {
    const found = external
      ? await hardcoverBook(db, http, want.title, want.author, env.HARDCOVER_API_KEY ?? '', metadataApiUrl(env), env.ISBNDB_API_KEY, env.METADATA_API_KEY)
      : null;
    if (found !== 'later') {
      hc = withLibrary(lib, found);
      saveHardcover(db, userId, document, hc);
    }
  }
  // A book matched earlier: its Hardcover details are in the cache, no lookup needed.
  if (!hc && want && row.hc_id) hc = withLibrary(lib, cachedHardcoverBook(db, want.title, want.author));
  // Hardcover's print page count is the stats source of truth, and its cover fills
  // a gap the free sources left, even when the cover lookup below is still cached
  // (it often ran before the throttled Hardcover lookup did).
  if (!row.page_count && hc?.pages) {
    row.page_count = hc.pages;
    db.prepare('UPDATE documents SET page_count = ? WHERE user_id = ? AND document = ?').run(hc.pages, userId, document);
  }
  if (!row.cover_url && hc?.cover) {
    row.cover_url = hc.cover;
    db.prepare('UPDATE documents SET cover_url = ? WHERE user_id = ? AND document = ?').run(hc.cover, userId, document);
  }
  let info: BookInfo = { cover: row.cover_url, pages: row.page_count };
  const fresh = (row.cover_url && row.page_count) || (row.cover_checked_at && nowSeconds() - row.cover_checked_at < RETRY_AFTER);
  if (!fresh) {
    const found = want
      ? await sharedBookInfo(db, http, want.title, want.author, env, { cover: hc?.cover, pages: hc?.pages })
      : { cover: null, pages: null };
    info = { cover: row.cover_url ?? found.cover, pages: row.page_count ?? found.pages };
    db.prepare(
      'UPDATE documents SET cover_url = ?, page_count = ?, cover_checked_at = ? WHERE user_id = ? AND document = ?'
    ).run(info.cover, info.pages, nowSeconds(), userId, document);
  }
  return info;
}

// Books still waiting on Hardcover details, filled in the background a few at a
// time (lookups are throttled, so this never holds up a request).
const enriching = new Set<number>();
export function enrichSoon(db: DB, userId: number, http: HttpTransport = fetchTransport, env: NodeJS.ProcessEnv = process.env, limit = 10): void {
  const library = libraryConfig(env) !== null;
  if (!(metadataApiUrl(env) || env.HARDCOVER_API_KEY || env.ISBNDB_API_KEY || library) || enriching.has(userId)) return;
  // With a library: also books it never answered for, its misses once a day old and its hits once a week old.
  const docs = db
    .prepare(
      `SELECT document FROM documents WHERE user_id = ?
         AND (hc_checked_at IS NULL
              OR (? AND (library_checked_at IS NULL
                         OR library_checked_at < CASE WHEN library_match = 1 THEN ? ELSE ? END)))
         AND (title IS NOT NULL OR filename IS NOT NULL) ORDER BY updated_at DESC LIMIT ?`
    )
    .all(userId, library ? 1 : 0, nowSeconds() - LIBRARY_HIT_TTL, nowSeconds() - LIBRARY_MISS_RETRY, limit) as { document: string }[];
  if (!docs.length) return;
  enriching.add(userId);
  (async () => {
    for (const d of docs) await documentInfo(db, userId, d.document, http, env, { hardcover: true }).catch(() => null);
  })().finally(() => enriching.delete(userId));
}
