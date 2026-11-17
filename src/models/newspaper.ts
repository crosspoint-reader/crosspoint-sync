import { Readability } from '@mozilla/readability';
import { DOMParser } from '@xmldom/xmldom';
import { parseHTML } from 'linkedom';
import type { DB } from '../db/db.js';
import type { HttpTransport } from '../connectors/types.js';
import { escapeXml } from '../connectors/kindle-fiona.js';
import { buildZip } from '../kindle-zip.js';
import { renderCover } from '../render/crosspaper-cover.js';

/**
 * Personal newspaper: pages the user saved plus new items from their RSS
 * feeds, bundled into one EPUB per day. Only sanitized article text is kept
 * (no images, no files), and it is dropped once an issue ages out.
 */

export const MAX_FEEDS = 30;
const ISSUE_MAX = 40; // articles per paper; the rest wait for tomorrow
const FIRST_ITEMS = 5; // taken from a feed when it is first added
const NEW_ITEMS = 10; // taken per feed per refresh
const STALE_SECONDS = 30 * 60;
const KEEP_DAYS = 14;
const MIN_TEXT = 200; // shorter than this is not an article
const FULL_TEXT = 1200; // a feed item this long is used as is, without fetching the page

export class NewspaperError extends Error {}

const now = () => Math.floor(Date.now() / 1000);
const textLength = (xhtml: string) => xhtml.replace(/<[^>]+>/g, '').trim().length;

function httpUrl(href: string | null | undefined, base?: string): string | null {
  try {
    const url = new URL(String(href ?? '').trim(), base);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch { return null; }
}

// ---- HTML to EPUB-safe XHTML -------------------------------------------------
// A whitelist serializer: whatever the page contained, the output is well
// formed and holds only plain reading markup.

const KEEP = new Set(['p', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'ul', 'ol', 'li', 'pre', 'code', 'em', 'strong', 'i', 'b', 'a', 'br', 'hr', 'sup', 'sub']);
const AS_DIV = new Set(['div', 'section', 'article', 'main', 'aside', 'table', 'tr', 'figcaption', 'dl', 'dt', 'dd']);
const DROP = new Set(['script', 'style', 'noscript', 'iframe', 'svg', 'form', 'button', 'nav', 'template', 'head', 'img', 'picture', 'video', 'audio', 'figure', 'object', 'embed']);

interface HtmlNode { nodeType: number; localName?: string; textContent: string | null; childNodes: Iterable<HtmlNode>; getAttribute?(name: string): string | null }

function serialize(node: HtmlNode, base: string): string {
  if (node.nodeType === 3) return escapeXml(node.textContent ?? '');
  if (node.nodeType !== 1) return '';
  const tag = (node.localName ?? '').toLowerCase();
  if (DROP.has(tag)) return '';
  const inner = [...node.childNodes].map((child) => serialize(child, base)).join('');
  const name = tag === 'h1' ? 'h2' : AS_DIV.has(tag) ? 'div' : tag;
  if (name === 'br' || name === 'hr') return `<${name}/>`;
  if (name === 'a') {
    const href = httpUrl(node.getAttribute?.('href'), base);
    return href ? `<a href="${escapeXml(href)}">${inner}</a>` : inner;
  }
  if (name === 'div') return inner.trim() ? `<div>${inner}</div>` : '';
  if (KEEP.has(name)) return `<${name}>${inner}</${name}>`;
  return tag === 'td' || tag === 'th' ? `${inner} ` : inner;
}

export function toXhtml(html: string, base: string): string {
  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  return serialize(document.body as unknown as HtmlNode, base);
}

// ---- Pages -------------------------------------------------------------------

export interface Extracted { title: string; byline: string; content: string }

/** The readable article in a web page, or null when there isn't one. */
export function extractArticle(html: string, url: string): Extracted | null {
  const { document } = parseHTML(html);
  let article;
  try { article = new Readability(document as unknown as Document).parse(); } catch { return null; }
  if (!article?.content) return null;
  const content = toXhtml(article.content, url);
  if (textLength(content) < MIN_TEXT) return null;
  const site = article.siteName?.trim() || new URL(url).hostname.replace(/^www\./, '');
  return {
    title: article.title?.trim() || site,
    byline: [article.byline?.trim(), site].filter(Boolean).join(', '),
    content,
  };
}

async function fetchText(http: HttpTransport, url: string): Promise<string> {
  const res = await http(url, { method: 'GET' });
  if (res.status < 200 || res.status >= 300) throw new NewspaperError(`The site answered ${res.status}.`);
  return res.text();
}

// ---- Feeds -------------------------------------------------------------------

export interface FeedItem { url: string; title: string; byline: string; html: string }
export interface Feed { title: string; items: FeedItem[] }

interface XmlNode { nodeType: number; nodeName: string; textContent: string | null; childNodes: ArrayLike<XmlNode>; getAttribute?(name: string): string | null }

const children = (el: XmlNode, name: string) => Array.from(el.childNodes).filter((n) => n.nodeType === 1 && n.nodeName === name);
const childText = (el: XmlNode, ...names: string[]) => {
  for (const name of names) {
    const text = children(el, name)[0]?.textContent?.trim();
    if (text) return text;
  }
  return '';
};

/** RSS 2.0, RSS 1.0 (RDF) or Atom. Null when the document is not a feed. */
export function parseFeed(xml: string, base: string): Feed | null {
  let root: XmlNode | null;
  try { root = new DOMParser({ onError: () => {} }).parseFromString(xml, 'text/xml').documentElement as unknown as XmlNode | null; }
  catch { return null; }
  if (!root) return null;
  if (root.nodeName === 'feed') {
    return {
      title: childText(root, 'title'),
      items: children(root, 'entry').flatMap((entry) => {
        const links = children(entry, 'link');
        const link = links.find((l) => (l.getAttribute?.('rel') ?? 'alternate') === 'alternate') ?? links[0];
        const url = httpUrl(link?.getAttribute?.('href'), base);
        const author = children(entry, 'author')[0];
        return url ? [{ url, title: childText(entry, 'title'), byline: author ? childText(author, 'name') : '', html: childText(entry, 'content', 'summary') }] : [];
      }),
    };
  }
  if (root.nodeName !== 'rss' && root.nodeName !== 'rdf:RDF') return null;
  const channel = children(root, 'channel')[0];
  if (!channel) return null;
  // RSS 1.0 lists items beside the channel, RSS 2.0 inside it.
  return {
    title: childText(channel, 'title'),
    items: [...children(channel, 'item'), ...children(root, 'item')].flatMap((item) => {
      const url = httpUrl(childText(item, 'link') || childText(item, 'guid'), base);
      return url ? [{ url, title: childText(item, 'title'), byline: childText(item, 'dc:creator', 'author'), html: childText(item, 'content:encoded', 'description') }] : [];
    }),
  };
}

/** Load a feed; a site's home page works too when it advertises one. */
async function loadFeed(http: HttpTransport, url: string): Promise<{ url: string; feed: Feed }> {
  const body = await fetchText(http, url);
  const feed = parseFeed(body, url);
  if (feed) return { url, feed };
  const { document } = parseHTML(body);
  const advertised = httpUrl(document.querySelector('link[rel="alternate"][type*="rss"], link[rel="alternate"][type*="atom"]')?.getAttribute('href'), url);
  const found = advertised && advertised !== url ? parseFeed(await fetchText(http, advertised), advertised) : null;
  if (!advertised || !found) throw new NewspaperError("Couldn't find an RSS feed at that address.");
  return { url: advertised, feed: found };
}

// ---- Storage -----------------------------------------------------------------

const insertArticle = (db: DB, userId: number, feedId: number | null, section: string, url: string, a: Extracted) =>
  db.prepare(
    `INSERT INTO news_articles (user_id, feed_id, url, title, byline, section, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, url) DO UPDATE SET feed_id = excluded.feed_id, title = excluded.title, byline = excluded.byline,
       section = excluded.section, content = excluded.content, issue = NULL, created_at = excluded.created_at`
  ).run(userId, feedId, url, a.title.slice(0, 300), a.byline.slice(0, 300), section, a.content, now());

/** Save one web page for the next paper. */
export async function saveArticle(db: DB, userId: number, input: string, http: HttpTransport): Promise<{ title: string }> {
  const url = httpUrl(input);
  if (!url) throw new NewspaperError('Enter a web address starting with http:// or https://.');
  const article = extractArticle(await fetchText(http, url), url);
  if (!article) throw new NewspaperError("Couldn't find an article on that page.");
  insertArticle(db, userId, null, 'Saved', url, article);
  return { title: article.title };
}

/** A feed item's article: its own full text, else the linked page, else its summary. */
async function itemArticle(item: FeedItem, http: HttpTransport): Promise<Extracted | null> {
  const own = toXhtml(item.html, item.url);
  const fromFeed = { title: item.title || item.url, byline: item.byline, content: own };
  if (textLength(own) >= FULL_TEXT) return fromFeed;
  try {
    const page = extractArticle(await fetchText(http, item.url), item.url);
    if (page) return { ...page, title: item.title || page.title };
  } catch { /* fall back to the summary */ }
  return textLength(own) >= MIN_TEXT ? fromFeed : null;
}

async function pullFeed(db: DB, userId: number, feed: { id: number; title: string }, items: FeedItem[], take: number, http: HttpTransport): Promise<void> {
  const seen = db.prepare('SELECT 1 FROM news_articles WHERE user_id = ? AND url = ?');
  const fresh = items.filter((item, i) => items.findIndex((o) => o.url === item.url) === i && !seen.get(userId, item.url)).slice(0, take);
  const articles = await Promise.all(fresh.map((item) => itemArticle(item, http)));
  fresh.forEach((item, i) => {
    // An item with nothing readable is still recorded (empty), so it is not fetched again.
    insertArticle(db, userId, feed.id, feed.title, item.url, articles[i] ?? { title: item.title || item.url, byline: '', content: '' });
  });
}

export async function addFeed(db: DB, userId: number, input: string, http: HttpTransport): Promise<{ id: number; url: string; title: string }> {
  const typed = httpUrl(input);
  if (!typed) throw new NewspaperError('Enter a web address starting with http:// or https://.');
  const count = db.prepare('SELECT COUNT(*) AS n FROM news_feeds WHERE user_id = ?').get(userId) as { n: number };
  if (count.n >= MAX_FEEDS) throw new NewspaperError(`You can follow up to ${MAX_FEEDS} feeds.`);
  const { url, feed } = await loadFeed(http, typed);
  const title = (feed.title || new URL(url).hostname).slice(0, 200);
  const existing = db.prepare('SELECT id FROM news_feeds WHERE user_id = ? AND url = ?').get(userId, url) as { id: number } | undefined;
  if (existing) return { id: existing.id, url, title };
  const id = Number(db.prepare('INSERT INTO news_feeds (user_id, url, title, fetched_at) VALUES (?, ?, ?, ?)').run(userId, url, title, now()).lastInsertRowid);
  await pullFeed(db, userId, { id, title }, feed.items, FIRST_ITEMS, http);
  return { id, url, title };
}

const refreshing = new Map<number, Promise<void>>();

/** Pull new items from feeds not checked in the last half hour. Concurrent calls share one run. */
// ponytail: feeds are fetched when the user opens the page or builds a paper; move to a background poller if builds get slow.
export function refreshFeeds(db: DB, userId: number, http: HttpTransport): Promise<void> {
  let run = refreshing.get(userId);
  if (!run) {
    run = (async () => {
      const cutoff = new Date(Date.now() - KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
      db.prepare("UPDATE news_articles SET content = '' WHERE user_id = ? AND issue < ? AND content != ''").run(userId, cutoff);
      const feeds = db.prepare('SELECT id, url, title FROM news_feeds WHERE user_id = ? AND fetched_at < ?')
        .all(userId, now() - STALE_SECONDS) as unknown as { id: number; url: string; title: string }[];
      await Promise.all(feeds.map(async (feed) => {
        db.prepare('UPDATE news_feeds SET fetched_at = ? WHERE id = ?').run(now(), feed.id);
        try {
          const parsed = parseFeed(await fetchText(http, feed.url), feed.url);
          if (parsed) await pullFeed(db, userId, feed, parsed.items, NEW_ITEMS, http);
        } catch { /* one broken feed must not hold up the paper */ }
      }));
    })().finally(() => refreshing.delete(userId));
    refreshing.set(userId, run);
  }
  return run;
}

// ---- The paper ---------------------------------------------------------------

export interface IssueArticle { title: string; byline: string; section: string; url: string; content: string }

/**
 * Close out past days: anything still waiting that was added before today joins
 * the edition of the day it was added. Runs whenever the paper is read, so no
 * scheduler is needed and a day nobody fetched still gets its edition.
 * `offset` is the reader's minutes behind UTC.
 */
export function rollUp(db: DB, userId: number, today: string, offset: number): void {
  db.prepare(
    `UPDATE news_articles SET issue = date(created_at - ? * 60, 'unixepoch')
     WHERE user_id = ? AND issue IS NULL AND content != '' AND date(created_at - ? * 60, 'unixepoch') < ?`
  ).run(offset, userId, offset, today);
}

/** Articles in an issue. For today's date, waiting articles join it first (saved pages before feed items). */
export function issueArticles(db: DB, userId: number, date: string, claim: boolean): IssueArticle[] {
  if (claim) {
    const have = db.prepare("SELECT COUNT(*) AS n FROM news_articles WHERE user_id = ? AND issue = ? AND content != ''").get(userId, date) as { n: number };
    db.prepare(
      `UPDATE news_articles SET issue = ? WHERE id IN (
         SELECT id FROM news_articles WHERE user_id = ? AND issue IS NULL AND content != ''
         ORDER BY feed_id IS NOT NULL, created_at, id LIMIT ?)`
    ).run(date, userId, Math.max(0, ISSUE_MAX - have.n));
  }
  return db.prepare(
    `SELECT title, byline, section, url, content FROM news_articles
     WHERE user_id = ? AND issue = ? AND content != '' ORDER BY feed_id IS NOT NULL, section, created_at, id`
  ).all(userId, date) as unknown as IssueArticle[];
}

const page = (title: string, body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="en" lang="en"><head><meta charset="UTF-8"/><title>${escapeXml(title)}</title></head><body>${body}</body></html>`;

/** The paper's name, everywhere it is shown. */
export const PAPER_NAME = 'CrossPaper';
export const issueTitle = (date: string) => `CrossPaper ${date}`;

/** One EPUB (3, with an NCX for older readers): a cover, a contents page, then a chapter per article. */
export function buildEpub(date: string, articles: IssueArticle[]): Buffer {
  const title = issueTitle(date);
  const sections = [...new Set(articles.map((a) => a.section))];
  const file = (i: number) => `a${i + 1}.xhtml`;
  const contents = sections.map((section) =>
    `<li><span>${escapeXml(section)}</span><ol>${articles.map((a, i) => a.section === section ? `<li><a href="${file(i)}">${escapeXml(a.title)}</a></li>` : '').join('')}</ol></li>`
  ).join('');
  const nav = page(title, `<h1>${escapeXml(title)}</h1><nav epub:type="toc"><ol>${contents}</ol></nav>`);
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>\n<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1"><head><meta name="dtb:uid" content="crosspoint-newspaper-${date}"/></head><docTitle><text>${escapeXml(title)}</text></docTitle><navMap>${
    articles.map((a, i) => `<navPoint id="n${i + 1}" playOrder="${i + 1}"><navLabel><text>${escapeXml(a.title)}</text></navLabel><content src="${file(i)}"/></navPoint>`).join('')
  }</navMap></ncx>`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>\n<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">crosspoint-newspaper-${date}</dc:identifier><dc:title>${escapeXml(title)}</dc:title><dc:creator>CrossPoint</dc:creator><dc:language>en</dc:language><dc:date>${date}</dc:date><meta property="dcterms:modified">${date}T00:00:00Z</meta><meta name="cover" content="cover"/></metadata><manifest><item id="cover" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>${
    articles.map((_, i) => `<item id="a${i + 1}" href="${file(i)}" media-type="application/xhtml+xml"/>`).join('')
  }</manifest><spine toc="ncx"><itemref idref="nav"/>${articles.map((_, i) => `<itemref idref="a${i + 1}"/>`).join('')}</spine></package>`;
  const entry = (name: string, text: string) => ({ name, data: Buffer.from(text, 'utf8') });
  return buildZip([
    entry('mimetype', 'application/epub+zip'), // must be first and uncompressed; buildZip stores everything
    entry('META-INF/container.xml', '<?xml version="1.0"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'),
    entry('OEBPS/content.opf', opf),
    { name: 'OEBPS/cover.jpg', data: renderCover({ name: PAPER_NAME, date }) },
    entry('OEBPS/nav.xhtml', nav),
    entry('OEBPS/toc.ncx', ncx),
    ...articles.map((a, i) => entry(`OEBPS/${file(i)}`, page(a.title,
      `<h1>${escapeXml(a.title)}</h1>${a.byline ? `<p><em>${escapeXml(a.byline)}</em></p>` : ''}${a.content}<hr/><p><a href="${escapeXml(a.url)}">${escapeXml(a.url)}</a></p>`))),
  ]);
}
