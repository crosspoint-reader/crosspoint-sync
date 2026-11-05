import type { DB } from '../db/db.js';
import type { HttpTransport } from '../connectors/types.js';
import { fetchTransport } from '../connectors/registry.js';
import { documentMeta } from '../connectors/store.js';
import { extractTitleAuthor, scoreCandidate, type Candidate } from '../connectors/matching.js';
import { nowSeconds } from './sync.js';
import { cacheKey, cachedHardcoverBook, hardcoverBook, type HardcoverBook } from './hardcover-catalog.js';
import { keepManual } from './manual-details.js';

/**
 * Cover art and print page count from title/author. Covers use the same
 * sources as Mayberry's no-ISBN fallback: iTunes Search (entity=ebook, 600px
 * artwork) first, then Open Library. Page counts come from Open Library's
 * median across editions, then Google Books when GOOGLE_BOOKS_API_KEY is set
 * (keyless Google Books has no quota), then Amazon's "Print length" via
 * SearchAPI when SEARCHAPI_KEY is set (stats only, see sharedAmazonPages).
 * Only URLs and numbers are stored. A miss is remembered for RETRY_AFTER so we
 * don't hammer any of them.
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

// SearchAPI's Amazon engines (paid, SEARCHAPI_KEY): search for the ASIN, then
// read "Print length" off the product page. Two credits per book. Credits run
// out, so only stats ask (never a library cover), once per book per
// AMAZON_RETRY_AFTER across all users, within SEARCHAPI_DAILY_LIMIT credits a
// day, and not at all for a while after SearchAPI refuses us.
const AMAZON_RETRY_AFTER = 90 * 86400;
const PAUSE_AFTER_REFUSAL = 3600;
let pausedUntil = 0;
const amazonInFlight = new Map<string, Promise<number | null | 'later'>>();

// null: SearchAPI has no answer. Throws when it would not answer (out of
// credits, rate limited, down), so the book isn't remembered as a miss.
async function searchApi(http: HttpTransport, params: Record<string, string>, key: string): Promise<any> {
  const res = await http(`https://www.searchapi.io/api/v1/search?${new URLSearchParams({ amazon_domain: 'amazon.com', ...params })}`, {
    method: 'GET',
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 200) return res.json();
  if (res.status === 400 || res.status === 404) return null;
  throw new Error(`SearchAPI ${res.status}`);
}

/** Print length, null for a miss, 'later' when SearchAPI (or the budget) said no. */
async function amazonPages(
  http: HttpTransport,
  title: string,
  author: string,
  key: string,
  spend: () => boolean = () => true
): Promise<number | null | 'later'> {
  try {
    if (!spend()) return 'later';
    const search = await searchApi(http, { engine: 'amazon_search', q: `${title} ${author}`.trim() }, key);
    const hits: BookCandidate[] = (search?.organic_results ?? [])
      .filter((r: any) => r.asin && r.title)
      .map((r: any) => ({ externalId: r.asin, title: r.title, author: r.authors?.[0]?.name }));
    const asin = best(title, author, hits, () => true)?.externalId;
    if (!asin) return null;
    if (!spend()) return 'later';
    const product = await searchApi(http, { engine: 'amazon_product', asin }, key);
    const spec = (product?.product?.specifications ?? []).find(
      (x: any) => /print length/i.test(x?.name ?? '')
    );
    const pages = parseInt(String(spec?.value ?? '').replace(/,/g, ''), 10);
    return pages > 0 ? pages : null;
  } catch {
    return 'later';
  }
}

/** Counts a SearchAPI credit for today, or false when SEARCHAPI_DAILY_LIMIT is spent. */
function spendCredit(db: DB, env: NodeJS.ProcessEnv): boolean {
  const key = `searchapi:${new Date().toISOString().slice(0, 10)}`;
  const used = Number((db.prepare('SELECT data FROM catalog_cache WHERE key = ?').get(key) as { data: string } | undefined)?.data ?? 0);
  const limit = Number(env.SEARCHAPI_DAILY_LIMIT) || 0;
  if (limit && used >= limit) return false;
  db.prepare(
    `INSERT INTO catalog_cache (key, data, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET data = excluded.data, checked_at = excluded.checked_at`
  ).run(key, String(used + 1), nowSeconds());
  return true;
}

/** amazonPages cached across users by title/author; concurrent asks share one lookup. */
async function sharedAmazonPages(
  db: DB,
  http: HttpTransport,
  title: string,
  author: string,
  env: NodeJS.ProcessEnv
): Promise<number | null | 'later'> {
  const book = cacheKey(title, author);
  const key = `amazon:${book}`;
  const hit = db.prepare('SELECT data, checked_at FROM catalog_cache WHERE key = ?').get(key) as
    | { data: string; checked_at: number }
    | undefined;
  const cached = hit ? (JSON.parse(hit.data) as { pages: number | null }).pages : null;
  if (hit && (cached || nowSeconds() - hit.checked_at < AMAZON_RETRY_AFTER)) return cached;
  if (!env.SEARCHAPI_KEY || nowSeconds() < pausedUntil) return 'later';
  let lookup = amazonInFlight.get(key);
  if (!lookup) {
    lookup = amazonPages(http, title, author, env.SEARCHAPI_KEY, () => spendCredit(db, env))
      .then((pages) => {
        if (pages === 'later') {
          pausedUntil = nowSeconds() + PAUSE_AFTER_REFUSAL;
          return pages;
        }
        db.prepare(
          `INSERT INTO catalog_cache (key, data, checked_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET data = excluded.data, checked_at = excluded.checked_at`
        ).run(key, JSON.stringify({ pages }), nowSeconds());
        // Other readers of the book get it from the shared lookup, no stats view needed.
        if (pages) {
          db.prepare("UPDATE catalog_cache SET data = json_set(data, '$.pages', ?) WHERE key = ?").run(pages, `info:${book}`);
        }
        return pages;
      })
      .finally(() => amazonInFlight.delete(key));
    amazonInFlight.set(key, lookup);
  }
  return lookup;
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
  // `known` (Hardcover's) fills in after the free sources, before the keyed/paid ones.
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
  if (!pages && env.SEARCHAPI_KEY) {
    const amazon = await amazonPages(http, title, author, env.SEARCHAPI_KEY);
    if (amazon !== 'later') pages = amazon;
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
  // SearchAPI is paid: documentInfo asks it separately, and only for stats.
  const info = await findBookInfo(http, title, author, { ...env, SEARCHAPI_KEY: '' }, known);
  db.prepare(
    `INSERT INTO catalog_cache (key, data, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET data = excluded.data, checked_at = excluded.checked_at`
  ).run(key, JSON.stringify(info), nowSeconds());
  return info;
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
    hc?.id ?? null, hc?.slug ?? null, json(hc?.moods), json(hc?.genres), json(hc?.content_warnings), hc?.rating ?? null,
    hc?.series ?? null, hc?.series_id ?? null, hc?.series_position ?? null, hc?.release_year ?? null,
    hc?.description ?? null, nowSeconds(), userId, document
  );
}

/** Cached cover URL + print page count for a document, resolving on first ask.
 *  With HARDCOVER_API_KEY set, also fills the document's Hardcover details once.
 *  With `paid`, a page count the free sources miss is asked of SearchAPI. */
export async function documentInfo(
  db: DB,
  userId: number,
  document: string,
  http: HttpTransport = fetchTransport,
  env: NodeJS.ProcessEnv = process.env,
  // Hardcover lookups are throttled to ~1/s, so only the background enricher asks for them.
  // SearchAPI costs credits, so only stats (which need page counts) ask for it.
  { hardcover = false, paid = false }: { hardcover?: boolean; paid?: boolean } = {}
): Promise<BookInfo> {
  const row = db
    .prepare('SELECT cover_url, page_count, cover_checked_at, pages_checked_at, hc_checked_at, hc_id FROM documents WHERE user_id = ? AND document = ?')
    .get(userId, document) as
    | {
        cover_url: string | null;
        page_count: number | null;
        cover_checked_at: number | null;
        pages_checked_at: number | null;
        hc_checked_at: number | null;
        hc_id: string | null;
      }
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
  // A book matched earlier: its Hardcover details are in the cache, no lookup needed.
  if (!hc && want && row.hc_id) hc = cachedHardcoverBook(db, want.title, want.author);
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
  if (paid && !info.pages && want && env.SEARCHAPI_KEY && !pagesCheckedRecently(row.pages_checked_at)) {
    const pages = await sharedAmazonPages(db, http, want.title, want.author, env);
    if (pages !== 'later') {
      info = { ...info, pages };
      db.prepare(
        'UPDATE documents SET page_count = COALESCE(page_count, ?), pages_checked_at = ? WHERE user_id = ? AND document = ?'
      ).run(pages, nowSeconds(), userId, document);
    }
  }
  return info;
}

const pagesCheckedRecently = (at: number | null) => at != null && nowSeconds() - at < AMAZON_RETRY_AFTER;

/** Oldest time a paid page lookup counts as current: stats re-ask for books checked before it. */
export const pagesCheckedSince = () => nowSeconds() - AMAZON_RETRY_AFTER;

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
