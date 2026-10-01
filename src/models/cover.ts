import type { DB } from '../db/db.js';
import type { HttpTransport } from '../connectors/types.js';
import { fetchTransport } from '../connectors/registry.js';
import { documentMeta } from '../connectors/store.js';
import { extractTitleAuthor, scoreCandidate, type Candidate } from '../connectors/matching.js';
import { nowSeconds } from './sync.js';
import { hardcoverBook, type HardcoverBook } from './hardcover-catalog.js';

/**
 * Cover art and print page count from title/author. Covers use the same
 * sources as Mayberry's no-ISBN fallback: iTunes Search (entity=ebook, 600px
 * artwork) first, then Open Library. Page counts come from Open Library's
 * median across editions, then Google Books when GOOGLE_BOOKS_API_KEY is set
 * (keyless Google Books has no quota), then Amazon's "Print length" via
 * SearchAPI when SEARCHAPI_KEY is set. Only URLs and numbers are stored.
 * A miss is remembered for RETRY_AFTER so we don't hammer any of them.
 */
const RETRY_AFTER = 7 * 86400;
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

async function itunes(http: HttpTransport, title: string, author: string): Promise<BookCandidate[]> {
  const q = new URLSearchParams({ term: `${title} ${author}`.trim(), entity: 'ebook', limit: '10', country: 'us' });
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

// SearchAPI's Amazon engines (paid, SEARCHAPI_KEY): search for the ASIN, then
// read "Print length" off the product page. Two credits per book, misses only.
async function searchApi(http: HttpTransport, params: Record<string, string>, key: string): Promise<any> {
  const res = await http(`https://www.searchapi.io/api/v1/search?${new URLSearchParams({ amazon_domain: 'amazon.com', ...params })}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20000),
  });
  return res.status === 200 ? res.json() : null;
}

async function amazonPages(http: HttpTransport, title: string, author: string, key: string): Promise<number | null> {
  try {
    const search = await searchApi(http, { engine: 'amazon_search', q: `${title} ${author}`.trim() }, key);
    const hits: BookCandidate[] = (search?.organic_results ?? [])
      .filter((r: any) => r.asin && r.title)
      .map((r: any) => ({ externalId: r.asin, title: r.title, author: r.authors?.[0]?.name }));
    const asin = best(title, author, hits, () => true)?.externalId;
    if (!asin) return null;
    const product = await searchApi(http, { engine: 'amazon_product', asin }, key);
    const spec = (product?.product?.specifications ?? []).find(
      (x: any) => /print length/i.test(x?.name ?? '')
    );
    const pages = parseInt(String(spec?.value ?? '').replace(/,/g, ''), 10);
    return pages > 0 ? pages : null;
  } catch {
    return null;
  }
}

export async function findBookInfo(
  http: HttpTransport,
  title: string,
  author: string,
  env: NodeJS.ProcessEnv = process.env,
  known: { cover?: string | null; pages?: number | null } = {}
): Promise<BookInfo> {
  const [apple, ol] = await Promise.all([safe(itunes(http, title, author)), safe(openLibrary(http, title, author))]);
  // `known` (Hardcover's) fills in after the free sources, before the keyed/paid ones.
  const cover = best(title, author, apple, (c) => c.url)?.url ?? best(title, author, ol, (c) => c.url)?.url ?? known.cover ?? null;
  let pages = best(title, author, ol, (c) => c.pages)?.pages ?? known.pages ?? null;
  if (!pages && env.GOOGLE_BOOKS_API_KEY) {
    pages = best(title, author, await safe(googleBooks(http, title, author, env.GOOGLE_BOOKS_API_KEY)), (c) => c.pages)?.pages ?? null;
  }
  if (!pages && env.SEARCHAPI_KEY) pages = await amazonPages(http, title, author, env.SEARCHAPI_KEY);
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

/** Store Hardcover's details on a document (a miss just records the check). */
function saveHardcover(db: DB, userId: number, document: string, hc: HardcoverBook | null): void {
  const json = (v: string[] | undefined) => (v?.length ? JSON.stringify(v) : null);
  db.prepare(
    `UPDATE documents SET hc_id = ?, hc_slug = ?, moods = ?, genres = ?, content_warnings = ?, rating = ?,
       series = ?, hc_series_id = ?, series_position = ?, release_year = ?, hc_checked_at = ? WHERE user_id = ? AND document = ?`
  ).run(
    hc?.id ?? null, hc?.slug ?? null, json(hc?.moods), json(hc?.genres), json(hc?.content_warnings), hc?.rating ?? null,
    hc?.series ?? null, hc?.series_id ?? null, hc?.series_position ?? null, hc?.release_year ?? null, nowSeconds(), userId, document
  );
}

/** Cached cover URL + print page count for a document, resolving on first ask.
 *  With HARDCOVER_API_KEY set, also fills the document's Hardcover details once. */
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
    .prepare('SELECT cover_url, page_count, cover_checked_at, hc_checked_at FROM documents WHERE user_id = ? AND document = ?')
    .get(userId, document) as
    | { cover_url: string | null; page_count: number | null; cover_checked_at: number | null; hc_checked_at: number | null }
    | undefined;
  if (!row) return { cover: null, pages: null }; // no metadata, nothing to search on
  const want = extractTitleAuthor(documentMeta(db, userId, document));
  let hc: HardcoverBook | null = null;
  if (hardcover && want && env.HARDCOVER_API_KEY && row.hc_checked_at == null) {
    const found = await hardcoverBook(db, http, want.title, want.author, env.HARDCOVER_API_KEY);
    if (found !== 'later') {
      saveHardcover(db, userId, document, found);
      hc = found;
    }
  }
  const cached = { cover: row.cover_url, pages: row.page_count };
  if ((row.cover_url && row.page_count) || (row.cover_checked_at && nowSeconds() - row.cover_checked_at < RETRY_AFTER)) {
    return cached;
  }
  const found = want
    ? await findBookInfo(http, want.title, want.author, env, { cover: hc?.cover, pages: hc?.pages })
    : { cover: null, pages: null };
  const info = { cover: row.cover_url ?? found.cover, pages: row.page_count ?? found.pages };
  db.prepare(
    'UPDATE documents SET cover_url = ?, page_count = ?, cover_checked_at = ? WHERE user_id = ? AND document = ?'
  ).run(info.cover, info.pages, nowSeconds(), userId, document);
  return info;
}

// Books still waiting on Hardcover details, filled in the background a few at a
// time (lookups are throttled, so this never holds up a request).
const enriching = new Set<number>();
export function enrichSoon(db: DB, userId: number, http: HttpTransport = fetchTransport, env: NodeJS.ProcessEnv = process.env, limit = 10): void {
  if (!env.HARDCOVER_API_KEY || enriching.has(userId)) return;
  const docs = db
    .prepare(
      `SELECT document FROM documents WHERE user_id = ? AND hc_checked_at IS NULL
         AND (title IS NOT NULL OR filename IS NOT NULL) ORDER BY updated_at DESC LIMIT ?`
    )
    .all(userId, limit) as { document: string }[];
  if (!docs.length) return;
  enriching.add(userId);
  (async () => {
    for (const d of docs) await documentInfo(db, userId, d.document, http, env, { hardcover: true }).catch(() => null);
  })().finally(() => enriching.delete(userId));
}
