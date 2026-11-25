import type { DB } from '../db/db.js';
import type { HttpTransport } from '../connectors/types.js';
import { normalizeAuthor, normalizeText, scoreCandidate, titleParts } from '../connectors/matching.js';
import { nowSeconds } from './sync.js';

/**
 * Book details from Hardcover's public catalog: moods, genres, content warnings,
 * community rating, series, release year, plus a print page count and cover to
 * fill gaps. One `search` request per book (it returns all of these), made with
 * the operator's HARDCOVER_API_KEY (read:catalog is enough) and cached across
 * users by title/author. Nothing about the user is sent to Hardcover.
 *
 * Hardcover's free plan allows 5,000 requests a day and 60 a minute, shared by
 * every user of this server, so lookups are throttled, capped per day, and a
 * 429 just means "try again later" (no miss is recorded).
 */
const ENDPOINT = 'https://api.hardcover.app/v1/graphql';
const RETRY_AFTER = 30 * 86400; // re-check a miss after a month
const THRESHOLD = 0.6;
const DAILY_CAP = 4000; // leave headroom under the free plan's 5,000
const MIN_GAP_MS = 1100; // ~55/min, under the 60/min refill

export interface HardcoverBook {
  id: string;
  slug: string | null;
  title: string;
  author: string | null;
  moods: string[];
  genres: string[];
  content_warnings: string[];
  rating: number | null;
  series: string | null;
  series_id: number | null;
  series_position: number | null;
  release_year: number | null;
  pages: number | null;
  cover: string | null;
  description: string | null;
}

// ---- throttle (in-process; one server) --------------------------------------
let nextSlot = 0;
let day = '';
let used = 0;
let pausedUntil = 0;

/** Reserve a request slot, or false when today's budget is spent / we were told to back off. */
async function slot(): Promise<boolean> {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) {
    day = today;
    used = 0;
  }
  if (used >= DAILY_CAP || Date.now() < pausedUntil) return false;
  used++;
  const wait = Math.max(0, nextSlot - Date.now());
  nextSlot = Math.max(Date.now(), nextSlot) + MIN_GAP_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
  return true;
}

/** Test hook. */
export function resetHardcoverThrottle(): void {
  nextSlot = 0;
  used = 0;
  pausedUntil = 0;
}

// Hardcover tags are user-entered: tidy case and drop duplicates ("Dark"/"dark").
export function tidy(list: unknown, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of Array.isArray(list) ? list : []) {
    if (typeof v !== 'string' || !v.trim()) continue;
    const key = v.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const t = v.trim(); // keep the first spelling's casing ("LGBTQ"), just capitalize "dark"
    out.push(t.charAt(0).toUpperCase() + t.slice(1));
    if (out.length >= max) break;
  }
  return out;
}

function toBook(doc: any): HardcoverBook | null {
  if (!doc?.id || typeof doc.title !== 'string') return null;
  const authors: string[] = Array.isArray(doc.author_names) ? doc.author_names.filter((a: unknown) => typeof a === 'string') : [];
  return {
    id: String(doc.id),
    slug: typeof doc.slug === 'string' ? doc.slug : null,
    title: doc.title,
    author: authors[0] ?? null,
    moods: tidy(doc.moods, 12), // pace ("medium-paced") tends to sit near the end
    genres: tidy(doc.genres, 6),
    content_warnings: tidy(doc.content_warnings, 8),
    rating: typeof doc.rating === 'number' && doc.ratings_count > 0 ? Math.round(doc.rating * 100) / 100 : null,
    series: Array.isArray(doc.series_names) && typeof doc.series_names[0] === 'string' ? doc.series_names[0] : null,
    series_id:
      typeof doc.featured_series?.series?.id === 'number'
        ? doc.featured_series.series.id
        : Array.isArray(doc.series_ids) && typeof doc.series_ids[0] === 'number'
          ? doc.series_ids[0]
          : null,
    series_position: typeof doc.featured_series_position === 'number' ? doc.featured_series_position : null,
    release_year: typeof doc.release_year === 'number' ? doc.release_year : null,
    pages: typeof doc.pages === 'number' && doc.pages > 0 ? doc.pages : null,
    cover: typeof doc.image?.url === 'string' ? doc.image.url : null,
    description: typeof doc.description === 'string' && doc.description.trim() ? doc.description.trim().slice(0, 6000) : null,
  };
}

/**
 * Search Hardcover for a title/author. Resolves to the best match, null for a
 * confident miss, or 'later' when the request couldn't be made right now.
 */
export async function searchHardcover(
  http: HttpTransport,
  title: string,
  author: string,
  key: string
): Promise<HardcoverBook | null | 'later'> {
  if (!(await slot())) return 'later';
  let res;
  try {
    res = await http(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: key.startsWith('Bearer ') ? key : `Bearer ${key}`,
        'user-agent': 'CrossPoint Sync (https://github.com/crosspoint-reader/crosspoint-sync)',
      },
      body: JSON.stringify({
        query: 'query ($q: String!) { search(query: $q, query_type: "Book", per_page: 5, page: 1) { results } }',
        // The whole title: which side of a separator is the real title is left to scoring.
        variables: { q: `${titleParts(title).full} ${author}`.trim() },
      }),
    });
  } catch {
    return 'later';
  }
  if (res.status === 429) {
    pausedUntil = Date.now() + 10 * 60 * 1000;
    return 'later';
  }
  if (res.status !== 200) return 'later';
  let body: any;
  try {
    body = await res.json();
  } catch {
    return 'later';
  }
  if (body?.errors?.length) return 'later';
  let top: { book: HardcoverBook; score: number } | null = null;
  for (const hit of body?.data?.search?.results?.hits ?? []) {
    const book = toBook(hit?.document);
    if (!book) continue;
    // Translations ("L'uomo di Marte") only appear among the alternative titles.
    const titles = [book.title, ...(hit.document.alternative_titles ?? []).filter((t: unknown) => typeof t === 'string')];
    const score = Math.max(
      ...titles.map((t: string) => scoreCandidate(title, author, { externalId: book.id, title: t, author: book.author ?? undefined }))
    );
    if (score >= THRESHOLD && (!top || score > top.score)) top = { book, score };
  }
  return top?.book ?? null;
}

/**
 * The same lookup against a book-metadata API (METADATA_API_URL): one request
 * returns details, cover and page count, so a server needs no catalog keys of
 * its own. Only the title and author are sent. The result has no Hardcover
 * slug or series id: with HARDCOVER_API_KEY also set, hardcoverBook asks
 * Hardcover as well and those come from it; without, Hardcover links and
 * "next in series" are unavailable.
 */
export async function searchMetadataApi(
  http: HttpTransport,
  title: string,
  author: string,
  baseUrl: string,
  /** METADATA_API_KEY: sent as a bearer token when set, so the API can tell this server apart. */
  apiKey?: string
): Promise<HardcoverBook | null | 'later'> {
  let body: any;
  try {
    const res = await http(`${baseUrl.replace(/\/+$/, '')}/books?${new URLSearchParams({ title, author })}`, {
      method: 'GET',
      ...(apiKey && { headers: { authorization: `Bearer ${apiKey}` } }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status !== 200) return 'later'; // busy, rate limited or down: not a miss
    body = await res.json();
  } catch {
    return 'later';
  }
  const b = body?.books?.[0];
  if (!b?.id || typeof b.title !== 'string') return null;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  return {
    id: String(b.id),
    slug: null,
    title: b.title,
    author: typeof b.author === 'string' ? b.author : null,
    moods: tidy(b.moods, 12),
    genres: tidy(b.genres, 6),
    content_warnings: tidy(b.content_warnings, 8),
    rating: num(b.rating),
    series: typeof b.series === 'string' ? b.series : null,
    series_id: null,
    series_position: num(b.series_position),
    release_year: num(b.release_year),
    pages: num(b.page_count),
    cover: typeof b.cover_url === 'string' ? b.cover_url : null,
    description: typeof b.description === 'string' && b.description.trim() ? b.description.trim().slice(0, 6000) : null,
  };
}

let isbndbPausedUntil = 0;

/**
 * The same lookup against ISBNdb (ISBNDB_API_KEY, a paid plan): one title
 * and author search, scored again here. ISBNdb lists every edition, so the
 * page count, cover and synopsis each come from the best-matching edition that
 * has one. It knows no moods, content warnings, ratings or series.
 */
export async function searchIsbndb(
  http: HttpTransport,
  title: string,
  author: string,
  key: string
): Promise<HardcoverBook | null | 'later'> {
  const q = titleParts(title).full.slice(0, 150); // ISBNdb's query limit
  if (!q) return null;
  if (Date.now() < isbndbPausedUntil) return 'later';
  let body: any;
  try {
    // "Herbert, Frank" is searched as "Frank Herbert".
    const who = author.trim().replace(/^([^,]+),\s*([^,]+)$/, '$2 $1').slice(0, 150);
    const params = new URLSearchParams({ text: q, ...(who && { author: who }), pageSize: '50' });
    const res = await http(`https://api2.isbndb.com/search/books?${params}`, {
      method: 'GET',
      headers: { authorization: key },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 404 || res.status === 400) return null; // nothing found / a query it won't take
    if (res.status === 429) isbndbPausedUntil = Date.now() + 60 * 1000;
    if (res.status !== 200) return 'later';
    body = await res.json();
  } catch {
    return 'later';
  }
  const matched: { b: any; score: number }[] = [];
  for (const b of Array.isArray(body?.data) ? body.data : []) {
    if (typeof b?.title !== 'string' || !b.isbn13) continue;
    const authors: (string | undefined)[] = Array.isArray(b.authors) && b.authors.length ? b.authors : [undefined];
    const score = Math.max(...authors.map((a) => scoreCandidate(title, author, { externalId: String(b.isbn13), title: b.title, author: a })));
    if (score >= THRESHOLD) matched.push({ b, score });
  }
  if (!matched.length) return null;
  matched.sort((x, y) => y.score - x.score); // stable: ISBNdb's own order breaks ties
  const first = (has: (b: any) => unknown) => matched.find(({ b }) => has(b))?.b;
  // An audiobook's "pages" are not a print length.
  const print = first((b) => Number.isInteger(b.pages) && b.pages > 0 && !/audio|\bcd\b|mp3|cassette/i.test(b.binding ?? ''));
  const top = print ?? matched[0].b;
  // The earliest of the equally good editions is the closest thing to a release year.
  const years = matched
    .filter((m) => m.score === matched[0].score)
    .map(({ b }) => parseInt(String(b.date_published ?? ''), 10))
    .filter((y) => y > 0);
  const thema = (first((b) => Array.isArray(b.thema))?.thema ?? []).filter((t: any) => t?.type === 'subject').map((t: any) => t.name);
  // Synopses arrive with markup ("<p>", "<br/>").
  const synopsis = String(first((b) => typeof b.synopsis === 'string' && b.synopsis.trim())?.synopsis ?? '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    id: String(top.isbn13),
    slug: null,
    title: top.title,
    author: typeof top.authors?.[0] === 'string' ? top.authors[0] : null,
    moods: [],
    genres: tidy(thema.length ? thema : first((b) => Array.isArray(b.subjects) && b.subjects.length)?.subjects, 6),
    content_warnings: [],
    rating: null,
    series: null,
    series_id: null,
    series_position: null,
    release_year: years.length ? Math.min(...years) : null,
    pages: print?.pages ?? null,
    // ponytail: ISBNdb may hand back a placeholder image and the URL can't tell; the free sources are asked first, so this only fills gaps.
    cover: first((b) => typeof b.image === 'string' && b.image)?.image ?? null,
    description: synopsis ? synopsis.slice(0, 6000) : null,
  };
}

/**
 * The book-metadata API to ask, or '' for none. It is metadata.dev unless told otherwise, so a
 * self-hosted server gets book details without finding a URL or a catalog key. It sends each
 * book's title and author to that service: METADATA_API=false turns it off. METADATA_API_URL
 * names a different API.
 */
export const DEFAULT_METADATA_API_URL = 'https://api.metadata.dev';
export const metadataApiUrl = (env: NodeJS.ProcessEnv): string =>
  /^(0|false|no|off)$/i.test(env.METADATA_API?.trim() ?? '') ? '' : env.METADATA_API_URL?.trim() || DEFAULT_METADATA_API_URL;

/** Keyed on the whole title, so "241 - Title" and "240 - Other Title" don't share an entry. */
export const cacheKey = (title: string, author: string) => `${normalizeText(titleParts(title).full)}|${normalizeAuthor(author)}`;

/** Shared, cached lookup: one Hardcover request per distinct book across all users. */
/** Hardcover's cached match for a title, without a lookup (null when none is cached). */
export function cachedHardcoverBook(db: DB, title: string, author: string): HardcoverBook | null {
  const hit = db.prepare('SELECT data FROM catalog_cache WHERE key = ?').get(cacheKey(title, author)) as { data: string | null } | undefined;
  return hit?.data ? (JSON.parse(hit.data) as HardcoverBook) : null;
}

export async function hardcoverBook(
  db: DB,
  http: HttpTransport,
  title: string,
  author: string,
  key: string,
  /** METADATA_API_URL: when set, that API says what the book is; Hardcover (with a key) adds what only it has. */
  api?: string,
  /** ISBNDB_API_KEY: fills what the source above lacks, or answers alone without one. */
  isbndb?: string,
  /** METADATA_API_KEY: optional key for the metadata API. */
  apiKey?: string
): Promise<HardcoverBook | null | 'later'> {
  const k = cacheKey(title, author);
  const hit = db.prepare('SELECT data, checked_at FROM catalog_cache WHERE key = ?').get(k) as
    | { data: string | null; checked_at: number }
    | undefined;
  if (hit && (hit.data || nowSeconds() - hit.checked_at < RETRY_AFTER)) {
    return hit.data ? (JSON.parse(hit.data) as HardcoverBook) : null;
  }
  const [meta, hc] = await Promise.all([
    api ? searchMetadataApi(http, title, author, api, apiKey) : null,
    key ? searchHardcover(http, title, author, key) : null,
  ]);
  if (meta === 'later' || hc === 'later') return 'later';
  // Both answered: the metadata API for what the book is (description, genres, cover, year),
  // Hardcover for what only it has (its id and link, the series and the book's place in it,
  // moods, content warnings, rating) and for the print page count.
  let found: HardcoverBook | null =
    hc && meta
      ? {
          ...hc,
          genres: meta.genres.length ? meta.genres : hc.genres,
          description: meta.description ?? hc.description,
          cover: meta.cover ?? hc.cover,
          release_year: meta.release_year ?? hc.release_year,
          pages: hc.pages ?? meta.pages,
          series: hc.series ?? meta.series,
          series_position: hc.series ? hc.series_position : meta.series_position,
        }
      : (hc ?? meta);
  if (isbndb && (!found || !found.pages || !found.cover || !found.description)) {
    const extra = await searchIsbndb(http, title, author, isbndb);
    // ponytail: a match from the first source is kept (and cached) without ISBNdb's gaps when ISBNdb is busy.
    if (extra === 'later' && !found) return 'later';
    if (extra && extra !== 'later') {
      found = found
        ? {
            ...found,
            pages: found.pages ?? extra.pages,
            cover: found.cover ?? extra.cover,
            description: found.description ?? extra.description,
            release_year: found.release_year ?? extra.release_year,
            genres: found.genres.length ? found.genres : extra.genres,
          }
        : extra;
    }
  }
  db.prepare(
    `INSERT INTO catalog_cache (key, data, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET data = excluded.data, checked_at = excluded.checked_at`
  ).run(k, found ? JSON.stringify(found) : null, nowSeconds());
  return found;
}

// ---- Next in series --------------------------------------------------------
export interface SeriesBook {
  position: number;
  title: string;
  author: string | null;
  year: number | null;
  slug: string | null;
  cover: string | null;
}
const SERIES_TTL = 7 * 86400;

// Hardcover's recommended "books in a series as the website shows them": one
// book per position (most popular), no merged duplicates, partials or compilations.
const SERIES_QUERY = `query ($id: Int!) {
  book_series(
    where: {series_id: {_eq: $id}, compilation: {_eq: false}, book: {canonical_id: {_is_null: true}, is_partial_book: {_eq: false}}}
    distinct_on: position
    order_by: [{position: asc}, {book: {users_count: desc}}]
  ) { position book { title slug release_year cached_contributors cached_image } }
}`;

async function fetchSeries(http: HttpTransport, seriesId: number, key: string): Promise<SeriesBook[] | 'later'> {
  if (!(await slot())) return 'later';
  let res;
  try {
    res = await http(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: key.startsWith('Bearer ') ? key : `Bearer ${key}`,
        'user-agent': 'CrossPoint Sync (https://github.com/crosspoint-reader/crosspoint-sync)',
      },
      body: JSON.stringify({ query: SERIES_QUERY, variables: { id: seriesId } }),
    });
  } catch {
    return 'later';
  }
  if (res.status === 429) pausedUntil = Date.now() + 10 * 60 * 1000;
  if (res.status !== 200) return 'later';
  const body: any = await res.json().catch(() => null);
  if (!body || body.errors?.length) return 'later';
  const out: SeriesBook[] = [];
  for (const r of body.data?.book_series ?? []) {
    const b = r?.book;
    if (typeof r?.position !== 'number' || typeof b?.title !== 'string') continue;
    const who = Array.isArray(b.cached_contributors) ? b.cached_contributors[0]?.author?.name : null;
    out.push({
      position: r.position,
      title: b.title,
      author: typeof who === 'string' ? who : null,
      year: typeof b.release_year === 'number' ? b.release_year : null,
      slug: typeof b.slug === 'string' ? b.slug : null,
      cover: typeof b.cached_image?.url === 'string' ? b.cached_image.url : null,
    });
  }
  return out;
}

/** The series' books in order, cached for a week across users. */
export async function seriesBooks(db: DB, http: HttpTransport, seriesId: number, key: string): Promise<SeriesBook[] | 'later'> {
  const k = `series:${seriesId}`;
  const hit = db.prepare('SELECT data, checked_at FROM catalog_cache WHERE key = ?').get(k) as
    | { data: string | null; checked_at: number }
    | undefined;
  if (hit?.data && nowSeconds() - hit.checked_at < SERIES_TTL) return JSON.parse(hit.data) as SeriesBook[];
  const list = await fetchSeries(http, seriesId, key);
  if (list === 'later') return hit?.data ? (JSON.parse(hit.data) as SeriesBook[]) : 'later';
  db.prepare(
    `INSERT INTO catalog_cache (key, data, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET data = excluded.data, checked_at = excluded.checked_at`
  ).run(k, JSON.stringify(list), nowSeconds());
  return list;
}

/** The book after `position`: the next whole-numbered entry (skipping novellas like 1.5), else whatever comes next. */
export function nextAfter(list: SeriesBook[], position: number): SeriesBook | null {
  const later = list.filter((b) => b.position > position).sort((a, b) => a.position - b.position);
  return later.find((b) => Number.isInteger(b.position)) ?? later[0] ?? null;
}
