import crypto from 'node:crypto';
import { DOMParser, type Element } from '@xmldom/xmldom';
import type { DB } from '../db/db.js';
import type { HttpTransport } from '../connectors/types.js';
import { coreTitle, normalizeAuthor, normalizeText } from '../connectors/matching.js';
import { nowSeconds } from './sync.js';

/**
 * The user's own library as the first source for book details and covers.
 *
 * LIBRARY_OPDS_URL names an OPDS catalog (Calibre's content server, Calibre-Web,
 * Calibre-Web-Automated, Kavita, Komga ...), with LIBRARY_OPDS_USERNAME and
 * LIBRARY_OPDS_PASSWORD for one behind HTTP Basic auth. The catalog is searched by
 * the title the reader sent, and an entry counts only when its title and author are
 * the same as the book's (after normalizing case, accents and punctuation): the
 * reader sends the EPUB's own metadata, which is what the library holds, so there is
 * no fuzzy guessing. Library covers usually need the login, so this server fetches
 * each one once and serves it itself under an unguessable address.
 */

export interface LibraryConfig {
  url: string;
  username: string;
  password: string;
}

export interface LibraryBook {
  id: string;
  title: string;
  author: string | null;
  description: string | null;
  genres: string[];
  series: string | null;
  series_position: number | null;
  release_year: number | null;
  /** The library's own cover link (absolute; may need the login). */
  cover: string | null;
}

/** A found book is kept until the library is asked again after this long; a miss for a day. */
const HIT_TTL = 7 * 86400;
const MISS_TTL = 86400;
const MAX_COVER_BYTES = 5 * 1024 * 1024;
const OPDS_IMAGE = 'http://opds-spec.org/image';
const OPDS_THUMBNAIL = 'http://opds-spec.org/image/thumbnail';

export function libraryConfig(env: NodeJS.ProcessEnv = process.env): LibraryConfig | null {
  const url = env.LIBRARY_OPDS_URL?.trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return { url, username: env.LIBRARY_OPDS_USERNAME ?? '', password: env.LIBRARY_OPDS_PASSWORD ?? '' };
}

/** The login goes only to the library's own address, never to a host its catalog links to. */
function headers(cfg: LibraryConfig, url: string, accept: string): Record<string, string> {
  const h: Record<string, string> = { accept };
  if (cfg.username && new URL(url).origin === new URL(cfg.url).origin) {
    h.authorization = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString('base64')}`;
  }
  return h;
}

const ATOM = 'application/atom+xml, application/xml;q=0.9, */*;q=0.5';

async function getXml(http: HttpTransport, cfg: LibraryConfig, url: string): Promise<Element> {
  const res = await http(url, { method: 'GET', headers: headers(cfg, url, ATOM), signal: AbortSignal.timeout(15000) });
  if (res.status !== 200) throw new Error(`library answered ${res.status}`);
  const doc = new DOMParser({ onError: () => {} }).parseFromString(await res.text(), 'text/xml');
  if (!doc.documentElement) throw new Error('library sent no XML');
  return doc.documentElement;
}

const byName = (el: Element, name: string): Element[] =>
  Array.from(el.getElementsByTagName('*')).filter((e) => (e.localName ?? e.nodeName) === name) as Element[];
const children = (el: Element, name: string): Element[] =>
  Array.from(el.childNodes).filter((n) => n.nodeType === 1 && ((n as Element).localName ?? n.nodeName) === name) as Element[];
const text = (el: Element | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

// The search URL template, found once per catalog: a search link straight in the root feed
// (Calibre-Web, Calibre's content server) or one inside its OpenSearch description.
const templates = new Map<string, string>();

async function searchTemplate(http: HttpTransport, cfg: LibraryConfig): Promise<string> {
  const known = templates.get(cfg.url);
  if (known) return known;
  const root = await getXml(http, cfg, cfg.url);
  const links = children(root, 'link').filter((l) => l.getAttribute('rel') === 'search');
  let template: string | null = null;
  const direct = links.find((l) => /atom\+xml/i.test(l.getAttribute('type') ?? '') && l.getAttribute('href')?.includes('{searchTerms}'));
  if (direct) template = new URL(direct.getAttribute('href')!, cfg.url).href;
  const osd = links.find((l) => /opensearchdescription/i.test(l.getAttribute('type') ?? ''));
  if (!template && osd) {
    const osdUrl = new URL(osd.getAttribute('href')!, cfg.url).href;
    const desc = await getXml(http, cfg, osdUrl);
    const url = byName(desc, 'Url').find((u) => /atom\+xml/i.test(u.getAttribute('type') ?? '')) ?? byName(desc, 'Url')[0];
    if (url?.getAttribute('template')) template = new URL(url.getAttribute('template')!, osdUrl).href;
  }
  if (!template) throw new Error('library catalog has no search');
  // Braces are escaped by URL(); put the placeholder back.
  template = template.replace(/%7BsearchTerms%7D/gi, '{searchTerms}');
  templates.set(cfg.url, template);
  return template;
}

/** Test seam: forget discovered search templates. */
export function resetLibraryTemplates(): void {
  templates.clear();
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}

/** One OPDS entry as a book. Calibre's content server puts series and tags into the content. */
export function parseEntry(entry: Element, base: string): LibraryBook | null {
  const title = text(children(entry, 'title')[0]);
  if (!title) return null;
  const authors = children(entry, 'author').map((a) => text(children(a, 'name')[0])).filter(Boolean);
  const content = text(children(entry, 'content')[0]);
  const summary = text(children(entry, 'summary')[0]) || stripHtml(content);
  let series: string | null = null;
  let position: number | null = null;
  // Calibre content server: "SERIES: The Founders [1]" inside the content.
  const m = /SERIES:\s*(.+?)\s*\[(\d+(?:\.\d+)?)\]/.exec(stripHtml(content));
  if (m) {
    series = m[1];
    position = Number(m[2]);
  }
  const genres = children(entry, 'category')
    .filter((c) => !(c.getAttribute('scheme') ?? '').startsWith('custom_column:'))
    .map((c) => c.getAttribute('label') || c.getAttribute('term') || '')
    .filter(Boolean);
  const year = /^(\d{4})/.exec(text(children(entry, 'published')[0]) || text(children(entry, 'issued')[0]) || '')?.[1];
  const links = children(entry, 'link');
  const image = links.find((l) => l.getAttribute('rel') === OPDS_IMAGE) ?? links.find((l) => l.getAttribute('rel') === OPDS_THUMBNAIL);
  const href = image?.getAttribute('href');
  return {
    id: text(children(entry, 'id')[0]) || title,
    title,
    author: authors.length ? authors.join(' & ') : null,
    description: summary || null,
    genres,
    series,
    series_position: position,
    // Calibre-Web prints an unknown publication date as year 0101.
    release_year: year && Number(year) > 1000 ? Number(year) : null,
    cover: href ? new URL(href, base).href : null,
  };
}

const compact = (s: string) => s.replace(/ /g, '');

/** A shared author: "James S.A. Corey" and "James S. A. Corey" or "Corey, James S. A."; one of several. */
export function sameAuthor(a: string | null | undefined, b: string | null | undefined): boolean {
  const split = (s: string) => s.split(/\s*(?:&|;|\band\b|\bund\b)\s*/i).map((x) => compact(normalizeAuthor(x))).filter(Boolean);
  if (!a?.trim() || !b?.trim()) return false;
  const theirs = split(b);
  return split(a).some((x) => theirs.includes(x));
}

/**
 * The same book: the same title, or the same apart from a subtitle on one side only ("Foundryside" and
 * "Foundryside: A Novel", but not "Series: Book One" and "Series: Book Two"), and a shared author. A book
 * or entry without an author never matches: a title alone is too often shared.
 */
export function sameBook(title: string, author: string, book: LibraryBook): boolean {
  if (!sameAuthor(author, book.author)) return false;
  const want = normalizeText(title);
  const theirs = normalizeText(book.title);
  if (!want || !theirs) return false;
  return want === theirs || want === normalizeText(coreTitle(book.title)) || normalizeText(coreTitle(title)) === theirs;
}

async function search(http: HttpTransport, cfg: LibraryConfig, query: string): Promise<LibraryBook[]> {
  const url = (await searchTemplate(http, cfg)).replace('{searchTerms}', encodeURIComponent(query));
  const feed = await getXml(http, cfg, url);
  return children(feed, 'entry').map((e) => parseEntry(e, url)).filter((b): b is LibraryBook => b !== null);
}

// Keyed on the catalog too: another LIBRARY_OPDS_URL or login must not reuse this one's answers.
const catalogId = (cfg: LibraryConfig) => crypto.createHash('sha256').update(`${cfg.url}\n${cfg.username}`).digest('hex').slice(0, 12);
const cacheKey = (cfg: LibraryConfig, title: string, author: string) =>
  `library:${catalogId(cfg)}:${normalizeText(title)}|${normalizeAuthor(author)}`;

/**
 * The library's entry for a book, or null when the library doesn't have it, or 'later'
 * when the library can't be asked right now (no miss is recorded then). Cached across
 * users like the other lookups.
 */
export async function libraryBook(
  db: DB,
  http: HttpTransport,
  title: string,
  author: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<LibraryBook | null | 'later'> {
  const cfg = libraryConfig(env);
  if (!cfg || !title.trim()) return null;
  const key = cacheKey(cfg, title, author);
  const hit = db.prepare('SELECT data, checked_at FROM catalog_cache WHERE key = ?').get(key) as
    | { data: string | null; checked_at: number }
    | undefined;
  if (hit && nowSeconds() - hit.checked_at < (hit.data ? HIT_TTL : MISS_TTL)) {
    return hit.data ? (JSON.parse(hit.data) as LibraryBook) : null;
  }
  let found: LibraryBook | null = null;
  try {
    const queries = [...new Set([title.trim(), coreTitle(title)].filter(Boolean))];
    for (const q of queries) {
      found = (await search(http, cfg, q)).find((b) => sameBook(title, author, b)) ?? null;
      if (found) break;
    }
  } catch {
    return hit?.data ? (JSON.parse(hit.data) as LibraryBook) : 'later';
  }
  db.prepare(
    `INSERT INTO catalog_cache (key, data, checked_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET data = excluded.data, checked_at = excluded.checked_at`
  ).run(key, found ? JSON.stringify(found) : null, nowSeconds());
  return found;
}

/** Where a stored library cover is served, relative to the server's address. */
export const LIBRARY_COVERS = '/api/v1/library/covers/';
export const libraryCoverPath = (id: string) => `${LIBRARY_COVERS}${id}`;
export const isLibraryCoverPath = (url: string | null | undefined): url is string => !!url && /^\/api\/v1\/library\/covers\/[0-9a-f]{32}$/.test(url);

/** The body, or null as soon as it is larger than `max` (the download is stopped then). */
export async function readCapped(res: Awaited<ReturnType<HttpTransport>>, max: number): Promise<Buffer | null> {
  const declared = Number(res.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) {
    const all = Buffer.from(await res.text(), 'binary');
    return all.length > max ? null : all;
  }
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts);
}

/**
 * The library's cover, fetched with the library's login once and kept here; returns the
 * server-relative path to show it at, or null when it can't be had.
 */
export async function storeLibraryCover(
  db: DB,
  http: HttpTransport,
  source: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<string | null> {
  const known = db.prepare('SELECT id FROM library_covers WHERE source = ?').get(source) as { id: string } | undefined;
  if (known) return libraryCoverPath(known.id);
  const cfg = libraryConfig(env);
  if (!cfg) return null;
  try {
    const res = await http(source, { method: 'GET', headers: headers(cfg, source, 'image/*'), signal: AbortSignal.timeout(15000) });
    const type = res.headers?.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
    if (res.status !== 200 || !/^image\/(jpeg|png|gif|webp)$/.test(type)) return null;
    const data = await readCapped(res, MAX_COVER_BYTES);
    if (!data?.length) return null;
    const id = crypto.randomBytes(16).toString('hex');
    db.prepare(
      `INSERT INTO library_covers (id, source, content_type, data, fetched_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source) DO NOTHING`
    ).run(id, source, type, data, nowSeconds());
    const row = db.prepare('SELECT id FROM library_covers WHERE source = ?').get(source) as { id: string };
    return libraryCoverPath(row.id);
  } catch {
    return null;
  }
}

/** A stored library cover by its id. */
export function libraryCover(db: DB, id: string): { content_type: string; data: Uint8Array } | null {
  if (!/^[0-9a-f]{32}$/.test(id)) return null;
  return (db.prepare('SELECT content_type, data FROM library_covers WHERE id = ?').get(id) as
    | { content_type: string; data: Uint8Array }
    | undefined) ?? null;
}
