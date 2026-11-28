import { crc32 } from 'node:zlib';
import { beforeEach, describe, expect, it } from 'vitest';
import { clearBookFusionEpubCache, epubXPath } from '../src/connectors/bookfusion-epub.js';
import { audiobookshelfConnector, clearAbsNoEpubCache } from '../src/connectors/audiobookshelf.js';
import type { HttpTransport } from '../src/connectors/types.js';

// Stored-ZIP EPUB fixture (same shape as bookfusion-position.test.ts).
function archive(files: Record<string, string>): Buffer {
  const local: Buffer[] = [], directory: Buffer[] = [];
  let offset = 0;
  for (const [path, source] of Object.entries(files)) {
    const name = Buffer.from(path), data = Buffer.from(source);
    const header = Buffer.alloc(30), central = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(data), 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc32(data), 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    local.push(header, name, data); directory.push(central, name);
    offset += header.length + name.length + data.length;
  }
  const end = Buffer.alloc(22), entries = Object.keys(files).length;
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries, 8); end.writeUInt16LE(entries, 10);
  end.writeUInt32LE(Buffer.concat(directory).length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...directory, end]);
}

function epub(): Buffer {
  return archive({
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'EPUB/package.opf': '<package><metadata/><manifest><item id="a" href="../Text/ch1.xhtml"/><item id="b" href="../Text/ch2.xhtml"/></manifest><guide/><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
    'Text/ch1.xhtml': '<html><head/><body><p>First</p></body></html>',
    'Text/ch2.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><head/><extra/><body><h1>Title</h1><p>Pre😀<em>bold</em> tail&amp;end</p></body></html>',
  });
}

const XPATH = '/body/DocFragment[2]/body/p[1]/text()[2].5';
const CFI = 'epubcfi(/8/4!/6/4/3:5)';
const CRED = { server: 'abs.test', token: 'k' };
const MATCH = { externalId: 'li_1', externalEdition: null, confidence: 1 };

/** Fake ABS: serves the EPUB (or 404s for audio-only) and records progress PATCHes. */
function absServer(opts: { ebook?: Buffer | null; progress?: unknown; itemDuration?: number } = {}) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const http: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const ok = (body: unknown) => ({ status: 200, text: async () => JSON.stringify(body), json: async () => body });
    if (url.endsWith('/api/items/li_1/ebook')) {
      if (!opts.ebook) return { status: 404, text: async () => 'Not Found', json: async () => null };
      const bytes = opts.ebook;
      return {
        status: 200, text: async () => '', json: async () => null,
        body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
      };
    }
    if (url.includes('/api/items/li_1')) return ok({ media: opts.itemDuration ? { duration: opts.itemDuration } : {} });
    if (url.includes('/api/me/progress/li_1')) return ok(init.method === 'GET' ? opts.progress ?? null : {});
    throw new Error(`Unexpected request: ${url}`);
  };
  const patches = () => calls.filter((c) => c.method === 'PATCH').map((c) => JSON.parse(c.body!));
  const ebookFetches = () => calls.filter((c) => c.url.endsWith('/ebook')).length;
  return { http, calls, patches, ebookFetches };
}

beforeEach(() => {
  clearBookFusionEpubCache();
  clearAbsNoEpubCache();
});

describe('audiobookshelf ebook position (push)', () => {
  it('uses the supplementary ebook when the item has no primary one (Audiobooks only libraries)', async () => {
    const bytes = epub();
    const calls: string[] = [];
    const patches: any[] = [];
    const http: HttpTransport = async (url, init) => {
      calls.push(url);
      const ok = (body: unknown) => ({ status: 200, text: async () => JSON.stringify(body), json: async () => body });
      if (init.method === 'PATCH') { patches.push(JSON.parse(init.body!)); return ok({}); }
      if (url.endsWith('/api/items/li_1/ebook')) return { status: 404, text: async () => 'Not Found', json: async () => null };
      if (url.endsWith('/api/items/li_1?expanded=1')) {
        return ok({ media: {}, libraryFiles: [
          { ino: '1', fileType: 'audio', metadata: { filename: 'book.m4b' } },
          { ino: '2', fileType: 'ebook', metadata: { filename: 'book.epub' } },
        ] });
      }
      if (url.endsWith('/api/items/li_1/file/2')) {
        return {
          status: 200, text: async () => '', json: async () => null,
          body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
        };
      }
      if (url.includes('/api/me/progress/li_1')) return ok({});
      throw new Error(`Unexpected request: ${url}`);
    };
    const r = await audiobookshelfConnector.push(
      CRED, MATCH, { kind: 'progress', document: 'd', percentage: 0.16, progress: XPATH, timestamp: 1 }, http
    );
    expect(r.ok).toBe(true);
    expect(calls).toContain('https://abs.test/api/items/li_1/file/2');
    expect(patches[0]).toMatchObject({ ebookLocation: CFI });
  });

  it('resolves the device XPath to a CFI in the ABS EPUB and sends ebookLocation', async () => {
    const abs = absServer({ ebook: epub() });
    const r = await audiobookshelfConnector.push(
      CRED, MATCH, { kind: 'progress', document: 'd', percentage: 0.16, progress: XPATH, timestamp: 1 }, abs.http
    );
    expect(r.ok).toBe(true);
    const [body] = abs.patches();
    expect(body).toMatchObject({ progress: 0.16, ebookProgress: 0.16, ebookLocation: CFI });
    expect(body.isFinished).toBeUndefined();
    // The EPUB request carries the ABS bearer token.
    expect(abs.calls.find((c) => c.url.endsWith('/ebook'))?.url).toBe('https://abs.test/api/items/li_1/ebook');
  });

  it('round-trips: the CFI sent to ABS maps back to the same XPath', async () => {
    const abs = absServer({ ebook: epub() });
    await audiobookshelfConnector.push(
      CRED, MATCH, { kind: 'progress', document: 'd', percentage: 0.5, progress: XPATH, timestamp: 1 }, abs.http
    );
    expect(await epubXPath(epub(), abs.patches()[0].ebookLocation)).toBe(XPATH);
  });

  it('still pushes progress for audio-only items, and stops asking for an EPUB that is not there', async () => {
    const abs = absServer({ ebook: null, itemDuration: 1000 });
    const ev = { kind: 'progress' as const, document: 'd', percentage: 0.5, progress: XPATH, timestamp: 1 };
    expect((await audiobookshelfConnector.push(CRED, MATCH, ev, abs.http)).ok).toBe(true);
    expect((await audiobookshelfConnector.push(CRED, MATCH, ev, abs.http)).ok).toBe(true);
    const [first] = abs.patches();
    expect(first).toMatchObject({ progress: 0.5, ebookProgress: 0.5, currentTime: 500, duration: 1000 });
    expect(first.ebookLocation).toBeUndefined();
    expect(abs.ebookFetches()).toBe(1); // second push skipped the known-missing EPUB
  });

  it('sends only ebookProgress when the device sent no XPath', async () => {
    const abs = absServer({ ebook: epub() });
    await audiobookshelfConnector.push(CRED, MATCH, { kind: 'progress', document: 'd', percentage: 0.3, timestamp: 1 }, abs.http);
    const [body] = abs.patches();
    expect(body).toMatchObject({ progress: 0.3, ebookProgress: 0.3 });
    expect(body.ebookLocation).toBeUndefined();
    expect(abs.ebookFetches()).toBe(0);
  });

  it('an XPath that does not resolve in this EPUB still saves the percentage', async () => {
    const abs = absServer({ ebook: epub() });
    const r = await audiobookshelfConnector.push(
      CRED, MATCH, { kind: 'progress', document: 'd', percentage: 0.4, progress: '/body/DocFragment[9]/body/p[1]', timestamp: 1 }, abs.http
    );
    expect(r.ok).toBe(true);
    const [body] = abs.patches();
    expect(body).toMatchObject({ progress: 0.4, ebookProgress: 0.4 });
    expect(body.ebookLocation).toBeUndefined();
  });

  it('finishing marks the ebook finished without a resume location', async () => {
    const abs = absServer({ ebook: epub() });
    await audiobookshelfConnector.push(
      CRED, MATCH, { kind: 'finished', document: 'd', percentage: 1, progress: XPATH, timestamp: 1 }, abs.http
    );
    const [body] = abs.patches();
    expect(body).toMatchObject({ progress: 1, ebookProgress: 1, isFinished: true });
    expect(body.ebookLocation).toBeUndefined();
  });
});

describe('audiobookshelf ebook position (pull)', () => {
  it('reads ABS reader progress for ebook-only items and maps its CFI to an exact XPath', async () => {
    const abs = absServer({
      ebook: epub(),
      progress: { libraryItemId: 'li_1', duration: 0, progress: 0, ebookProgress: 0.42, ebookLocation: CFI, isFinished: false, lastUpdate: 2000 },
    });
    const change = await audiobookshelfConnector.pullProgress!(CRED, MATCH, abs.http, 1000);
    expect(change).toEqual({ externalId: 'li_1', percentage: 0.42, finished: false, progress: XPATH, updatedAtMs: 2000 });
  });

  it('keeps the listening position for items with audio', async () => {
    const abs = absServer({
      ebook: epub(),
      progress: { libraryItemId: 'li_1', duration: 1000, currentTime: 600, progress: 0.6, ebookProgress: 0.1, ebookLocation: CFI, isFinished: false, lastUpdate: 2000 },
    });
    const change = await audiobookshelfConnector.pullProgress!(CRED, MATCH, abs.http, 1000);
    expect(change).toEqual({ externalId: 'li_1', percentage: 0.6, finished: false, updatedAtMs: 2000 });
    expect(abs.ebookFetches()).toBe(0);
  });

  it('falls back to the percentage when the CFI cannot be placed', async () => {
    const abs = absServer({
      ebook: epub(),
      progress: { libraryItemId: 'li_1', duration: 0, ebookProgress: 0.7, ebookLocation: 'epubcfi(/8/40!/6/2)', isFinished: false, lastUpdate: 2000 },
    });
    const change = await audiobookshelfConnector.pullProgress!(CRED, MATCH, abs.http, 1000);
    expect(change).toEqual({ externalId: 'li_1', percentage: 0.7, finished: false, updatedAtMs: 2000 });
  });
});
