import type { DB } from '../db/db.js';
import type { HttpTransport } from '../connectors/types.js';
import { coreTitle, normalizeAuthor, normalizeText, scoreCandidate } from '../connectors/matching.js';
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
function tidy(list: unknown, max: number): string[] {
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
        variables: { q: `${coreTitle(title)} ${author}`.trim() },
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
    const score = scoreCandidate(title, author, { externalId: book.id, title: book.title, author: book.author ?? undefined });
    if (score >= THRESHOLD && (!top || score > top.score)) top = { book, score };
  }
  return top?.book ?? null;
}

const cacheKey = (title: string, author: string) => `${normalizeText(coreTitle(title))}|${normalizeAuthor(author)}`;

/** Shared, cached lookup: one Hardcover request per distinct book across all users. */
export async function hardcoverBook(
  db: DB,
  http: HttpTransport,
  title: string,
  author: string,
  key: string
): Promise<HardcoverBook | null | 'later'> {
  const k = cacheKey(title, author);
  const hit = db.prepare('SELECT data, checked_at FROM catalog_cache WHERE key = ?').get(k) as
    | { data: string | null; checked_at: number }
    | undefined;
  if (hit && (hit.data || nowSeconds() - hit.checked_at < RETRY_AFTER)) {
    return hit.data ? (JSON.parse(hit.data) as HardcoverBook) : null;
  }
  const found = await searchHardcover(http, title, author, key);
  if (found === 'later') return 'later';
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
