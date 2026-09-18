import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { crc32 } from 'node:zlib';
import { DOMParser, onErrorStopParsing, type Element, type Node } from '@xmldom/xmldom';
import { fromBufferPromise, type Entry } from 'yauzl';
import { ConnectorOperationError, type HttpTransport } from './types.js';

const MAX_ARCHIVE = 32 * 1024 * 1024;
const MAX_XML = 1024 * 1024;
const CACHE_TTL = 15 * 60 * 1000;
const cache = new Map<string, { bytes: Buffer; expires: number }>();

export function clearBookFusionEpubCache(): void { cache.clear(); }

function invalid(reason: string): never {
  throw new ConnectorOperationError(`BookFusion position: ${reason}`, false);
}

function checkStatus(status: number, authenticated = true): void {
  if (status >= 200 && status < 300) return;
  throw new ConnectorOperationError(
    `BookFusion EPUB download failed (${status})`, status === 429 || status >= 500 || (!authenticated && status === 403),
    authenticated && (status === 401 || status === 403)
  );
}

/** Cache only archives, bounded across all accounts. Tokens never appear in cache keys. */
export async function bookFusionEpub(
  token: string, bookId: string, headers: Record<string, string>, http: HttpTransport
): Promise<Buffer> {
  const key = createHash('sha256').update(JSON.stringify([token, bookId])).digest('hex');
  for (const [id, entry] of cache) if (entry.expires <= Date.now()) cache.delete(id);
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.bytes;
  }
  const signal = AbortSignal.timeout(30_000);
  const link = await http(`https://www.bookfusion.com/api/user/books/${encodeURIComponent(bookId)}/download`, {
    method: 'POST', headers, body: '{}', signal,
  });
  checkStatus(link.status);
  const data = await link.json() as { url?: unknown };
  if (typeof data?.url !== 'string') invalid('download URL missing');
  const url = new URL(data.url);
  // Download URLs come from BookFusion; never forward its bearer token to storage.
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') ||
      !['bookfusion.com', 'amazonaws.com', 'cloudfront.net'].some(
        host => url.hostname === host || url.hostname.endsWith(`.${host}`)
      )) invalid('unsupported EPUB download host');
  const res = await http(url.href, { method: 'GET', signal, redirect: 'error' });
  checkStatus(res.status, false);
  if (!res.body) invalid('EPUB response has no body');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_ARCHIVE) invalid('EPUB exceeds 32 MiB');
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks, size);
  let retained = [...cache.values()].reduce((sum, entry) => sum + entry.bytes.length, 0);
  for (const [id, entry] of cache) {
    if (retained + size <= MAX_ARCHIVE && cache.size < 32) break;
    retained -= entry.bytes.length;
    cache.delete(id);
  }
  cache.set(key, { bytes, expires: Date.now() + CACHE_TTL });
  return bytes;
}

function children(node: Node): Node[] { return Array.from(node.childNodes ?? []); }
function elements(node: Node): Element[] {
  return children(node).filter((child): child is Element => child.nodeType === 1);
}
function text(node: Node): boolean { return node.nodeType === 3 || node.nodeType === 4; }
function child(node: Node, name: string): Element {
  const found = elements(node).find(element => element.localName === name);
  return found ?? invalid(`missing ${name} element`);
}

function xml(bytes: Buffer, xhtml = false): Element {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le'
    : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be'
    : bytes.toString('ascii', 0, 160).match(/^<\?xml\s[^>]*encoding=["']([^"']+)/)?.[1] ?? 'utf-8';
  const source = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  if ((source.match(/</g)?.length ?? 0) > 50_000) invalid('XML has too many nodes');
  const root = new DOMParser({ onError: onErrorStopParsing }).parseFromString(
    source, xhtml ? 'application/xhtml+xml' : 'application/xml'
  ).documentElement;
  return root ?? invalid('XML root missing');
}

export interface BookFusionPosition {
  chapter_index: number;
  page_position_in_book: number;
  cfi: string;
}

interface Chapter {
  opf: Element;
  spine: Element;
  spineItems: Element[];
  index: number;
  html: Element;
  body: Element;
}

async function withChapter<T>(
  bytes: Buffer,
  select: (opf: Element, spine: Element, items: Element[]) => number,
  resolve: (chapter: Chapter) => T
): Promise<T> {
  const zip = await fromBufferPromise(bytes, { lazyEntries: true, strictFileNames: true });
  try {
    const entries = new Map<string, Entry>();
    for await (const entry of zip.eachEntry()) {
      if (entries.size >= 10_000) invalid('EPUB has too many entries');
      if (entries.has(entry.fileName)) invalid('duplicate EPUB entry');
      entries.set(entry.fileName, entry);
    }
    async function read(path: string): Promise<Buffer> {
      const entry = entries.get(path) ?? invalid('EPUB entry missing');
      if (entry.uncompressedSize > MAX_XML) invalid('EPUB XML exceeds 1 MiB');
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > MAX_XML) invalid('EPUB XML exceeds 1 MiB');
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks, size);
      if (crc32(data) !== entry.crc32) invalid('EPUB entry checksum mismatch');
      return data;
    }
    const container = xml(await read('META-INF/container.xml'));
    const rootfiles = elements(child(container, 'rootfiles'));
    const rootfile = rootfiles.find(e => e.getAttribute('media-type') === 'application/oebps-package+xml')
      ?? rootfiles[0] ?? invalid('EPUB package missing');
    const opfPath = rootfile.getAttribute('full-path') ?? invalid('EPUB package path missing');
    const opf = xml(await read(opfPath));
    const spine = child(opf, 'spine');
    const spineItems = elements(spine).filter(e => e.localName === 'itemref');
    const index = select(opf, spine, spineItems);
    if (!Number.isSafeInteger(index) || index < 0 || index >= spineItems.length) invalid('chapter out of range');
    const item = elements(child(opf, 'manifest')).find(
      e => e.localName === 'item' && e.getAttribute('id') === spineItems[index].getAttribute('idref')
    ) ?? invalid('spine item missing from manifest');
    const href = item.getAttribute('href') ?? invalid('chapter path missing');
    const chapterPath = posix.join(posix.dirname(opfPath), decodeURIComponent(href.split('#')[0]));
    const html = xml(await read(chapterPath), true);
    const body = child(html, 'body');
    return resolve({ opf, spine, spineItems, index, html, body });
  } finally { zip.close(); }
}

/** Resolve the device's XPath in the actual EPUB, including absolute sibling indices. */
export async function epubPosition(bytes: Buffer, xpath: string): Promise<BookFusionPosition> {
  const match = /^\/body\/DocFragment(?:\[(\d+)\])?\/body(?:\/(.*))?$/.exec(xpath);
  if (!match || xpath.length > 4096) invalid('expected a KOReader XPath');
  return withChapter(bytes, () => Number(match[1] ?? 1) - 1, ({ opf, spine, spineItems, index, html, body }) => {
    const steps = [2 * (elements(html).indexOf(body) + 1)];
    let target: Node = body;
    let offset = 0;
    let cfiOffset = 0;
    let textStep: number | undefined;
    for (const [i, part] of (match[2] ? match[2].split('/') : []).entries()) {
      const textMatch = /^text\(\)(?:\[(\d+)\])?(?:\.(\d+))?$/.exec(part);
      if (textMatch) {
        if (i !== match[2]!.split('/').length - 1) invalid('text must end the XPath');
        const nodes = children(target);
        const selected = nodes.filter(text)[Number(textMatch[1] ?? 1) - 1] ?? invalid('text node missing');
        const codepoints = Number(textMatch[2] ?? 0);
        let count = 0;
        for (const character of selected.nodeValue ?? '') {
          if (count === codepoints) break;
          offset += character.length; // CFI uses UTF-16; CrossPoint XPath offsets count codepoints.
          count++;
        }
        if (!Number.isSafeInteger(codepoints) || count !== codepoints) invalid('text offset out of range');
        textStep = 1;
        // Comments/CDATA can split text nodes without creating a new CFI text slot.
        for (const node of nodes) {
          if (node === selected) break;
          if (node.nodeType === 1) { textStep += 2; cfiOffset = 0; }
          else if (text(node)) cfiOffset += node.nodeValue?.length ?? 0;
        }
        cfiOffset += offset;
        target = selected;
      } else {
        const element = /^([\w:.-]+)(?:\[(\d+)\])?$/.exec(part);
        if (!element) invalid('unsupported XPath step');
        const siblings = elements(target);
        const found = siblings.filter(e => e.localName === element[1].split(':').pop())[Number(element[2] ?? 1) - 1];
        if (!found) invalid('XPath element missing');
        steps.push(2 * (siblings.indexOf(found) + 1));
        target = found;
      }
    }
    let total = 0;
    let before = -1;
    // Iterative traversal avoids a call-stack limit on nested XHTML.
    for (let node: Node | null = body; node;) {
      if (node === target) before = total + offset;
      if (text(node)) total += node.nodeValue?.length ?? 0;
      if (node.firstChild) { node = node.firstChild; continue; }
      while (node !== body && !node.nextSibling) node = node.parentNode!;
      node = node === body ? null : node.nextSibling;
    }
    if (before < 0 || before > total) invalid('XPath text position out of range');
    const packageStep = 2 * (elements(opf).indexOf(spine) + 1);
    const itemStep = 2 * (elements(spine).indexOf(spineItems[index]) + 1);
    const suffix = textStep === undefined ? '' : `/${textStep}:${cfiOffset}`;
    return {
      chapter_index: index,
      page_position_in_book: (index + (total ? before / total : 0)) / spineItems.length,
      cfi: `epubcfi(/${packageStep}/${itemStep}!/${steps.join('/')}${suffix})`,
    };
  });
}

interface CfiStep { number: number; id?: string; offset?: number; }

function cfiPaths(cfi: string): CfiStep[][] {
  if (cfi.length > 4096 || !cfi.startsWith('epubcfi(') || !cfi.endsWith(')')) invalid('expected an EPUB CFI');
  const inner = cfi.slice(8, -1);
  const token = /\/([1-9]\d*)(?:\[((?:\^[\s\S]|[^\]\^])*)\])?(?::(\d+)(?:\[((?:\^[\s\S]|[^\]\^])*)\])?)?/y;
  const paths: CfiStep[][] = [[]];
  // A range CFI is parent,start,end; a reading position is the range start.
  const range: CfiStep[][] = [];
  for (let at = 0; at < inner.length;) {
    if (inner[at] === '!' && paths.length === 1 && paths[0].length && !range.length) {
      paths.push([]); at++; continue;
    }
    if (inner[at] === ',' && paths.length === 2 && range.length < 2) {
      range.push([]); at++; continue;
    }
    token.lastIndex = at;
    const step = token.exec(inner);
    if (!step) invalid('unsupported CFI step');
    const number = Number(step[1]), offset = step[3] === undefined ? undefined : Number(step[3]);
    if (!Number.isSafeInteger(number) || (offset !== undefined && !Number.isSafeInteger(offset))) invalid('CFI step out of range');
    // Parameters such as side bias do not identify an element. Unescape ID assertions.
    const id = step[2]?.match(/^(?:\^[\s\S]|[^;])*/)?.[0].replace(/\^([\s\S])/g, '$1');
    (range.length ? range[range.length - 1] : paths[paths.length - 1]).push({ number, id: id || undefined, offset });
    at = token.lastIndex;
  }
  if (range.length) {
    if (range.length !== 2 || !range[0].length || !range[1].length) invalid('expected a complete CFI range');
    paths[1].push(...range[0]);
  }
  if (paths.length !== 2 || paths[0].length !== 2 || !paths[1].length) invalid('expected a chapter CFI');
  return paths;
}

function cfiElement(parent: Node, step: CfiStep): Element {
  if (step.number % 2 || step.offset !== undefined) invalid('expected a CFI element');
  const element = elements(parent)[step.number / 2 - 1] ?? invalid('CFI element missing');
  // BookFusion uses the manifest idref as the assertion on spine itemrefs.
  const idref = element.localName === 'itemref' ? element.getAttribute('idref') : null;
  if (step.id && element.getAttribute('id') !== step.id && element.getAttribute('xml:id') !== step.id && idref !== step.id) {
    invalid('CFI ID assertion mismatch');
  }
  return element;
}

/** Resolve a point CFI to the same codepoint-based XPath understood by CrossPoint. */
export async function epubXPath(bytes: Buffer, cfi: string): Promise<string> {
  const [packagePath, contentPath] = cfiPaths(cfi);
  return withChapter(bytes, (opf, spine, items) => {
    if (cfiElement(opf, packagePath[0]) !== spine) invalid('CFI does not reference the spine');
    return items.indexOf(cfiElement(spine, packagePath[1]));
  }, ({ index, html, body }) => {
    if (cfiElement(html, contentPath[0]) !== body) invalid('CFI does not reference the body');
    const path = [`/body/DocFragment[${index + 1}]/body`];
    let target: Node = body;
    for (const [i, step] of contentPath.slice(1).entries()) {
      if (step.number % 2 === 0) {
        const element = cfiElement(target, step);
        const siblings = elements(target).filter(e => e.localName === element.localName);
        path.push(`${element.localName}[${siblings.indexOf(element) + 1}]`);
        target = element;
      } else {
        if (i !== contentPath.length - 2 || step.id) invalid('text must end the CFI');
        let slot = 1, textIndex = 0, remaining = step.offset ?? 0;
        let found = false;
        for (const node of children(target)) {
          if (node.nodeType === 1) { slot += 2; continue; }
          if (!text(node)) continue;
          textIndex++;
          if (slot !== step.number) continue;
          const value = node.nodeValue ?? '';
          if (remaining > value.length) { remaining -= value.length; continue; }
          if (remaining > 0 && /[\uD800-\uDBFF]/.test(value[remaining - 1]) &&
              /[\uDC00-\uDFFF]/.test(value[remaining] ?? '')) invalid('CFI splits a surrogate pair');
          path.push(`text()[${textIndex}].${Array.from(value.slice(0, remaining)).length}`);
          found = true;
          break;
        }
        if (!found) invalid('CFI text offset out of range');
      }
    }
    return path.join('/');
  });
}
