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

/** Resolve the device's XPath in the actual EPUB, including absolute sibling indices. */
export async function epubPosition(bytes: Buffer, xpath: string): Promise<BookFusionPosition> {
  const match = /^\/body\/DocFragment(?:\[(\d+)\])?\/body(?:\/(.*))?$/.exec(xpath);
  if (!match || xpath.length > 4096) invalid('expected a KOReader XPath');
  const index = Number(match[1] ?? 1) - 1;
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
    if (!Number.isSafeInteger(index) || index < 0 || index >= spineItems.length) invalid('chapter out of range');
    const item = elements(child(opf, 'manifest')).find(
      e => e.localName === 'item' && e.getAttribute('id') === spineItems[index].getAttribute('idref')
    ) ?? invalid('spine item missing from manifest');
    const href = item.getAttribute('href') ?? invalid('chapter path missing');
    const chapterPath = posix.join(posix.dirname(opfPath), decodeURIComponent(href.split('#')[0]));
    const html = xml(await read(chapterPath), true);
    const body = child(html, 'body');
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
  } finally { zip.close(); }
}
