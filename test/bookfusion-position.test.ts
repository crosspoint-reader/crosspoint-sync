import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookFusionEpub, clearBookFusionEpubCache, epubPosition } from '../src/connectors/bookfusion-epub.js';
import { bookfusionConnector } from '../src/connectors/bookfusion.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { upsertAccount } from '../src/connectors/store.js';
import { drainQueue } from '../src/connectors/runner.js';
import type { HttpTransport } from '../src/connectors/types.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

// Small stored ZIP fixtures keep the EPUB source visible in the tests.
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

function epub(body = '<h1>Title</h1><p>Pre😀<em>bold</em> tail&amp;end</p>'): Buffer {
  return archive({
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'EPUB/package.opf': '<package><metadata/><manifest><item id="a" href="../Text/ch%201.xhtml"/><item id="b" href="../Text/ch%202.xhtml"/></manifest><guide/><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
    'Text/ch 1.xhtml': '<html><head/><body><p>First</p></body></html>',
    'Text/ch 2.xhtml': `<html xmlns="http://www.w3.org/1999/xhtml"><head/><extra/><body>${body}</body></html>`,
  });
}

const XPATH = '/body/DocFragment[2]/body/p[1]/text()[2].5';
const providerHeaders = { authorization: 'Bearer test-token' };
function transport(bytes = epub()) {
  const calls: { url: string; init: Parameters<HttpTransport>[1] }[] = [];
  const http: HttpTransport = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/download')) return {
      status: 200, text: async () => '', json: async () => ({ url: 'https://books.s3.amazonaws.com/book.epub?signed=1' }),
    };
    if (url.startsWith('https://books.s3.amazonaws.com/')) return {
      status: 200, text: async () => '', json: async () => null,
      body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    };
    if (url.endsWith('/reading_position')) {
      const body = JSON.parse(init.body!);
      return {
        status: body.cfi && body.chapter_index != null && body.page_position_in_book != null ? 200 : 422,
        text: async () => '', json: async () => ({}),
      };
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  return { http, calls };
}

beforeEach(() => {
  clearBookFusionEpubCache();
  process.env.TOKEN_ENC_KEY = 'a'.repeat(64);
  resetEncryptionKeyCache();
});
afterEach(() => {
  clearBookFusionEpubCache();
  delete process.env.TOKEN_ENC_KEY;
  resetEncryptionKeyCache();
  vi.useRealTimers();
});

describe('BookFusion XPath conversion', () => {
  it('resolves package/body/element indices and exact text position from the EPUB', async () => {
    const position = await epubPosition(epub(), XPATH);
    expect(position.cfi).toBe('epubcfi(/8/4!/6/4/3:5)');
    expect(position.chapter_index).toBe(1);
    expect(position.page_position_in_book).toBeCloseTo((1 + 19 / 23) / 2, 12);
  });

  it('converts codepoint offsets to UTF-16 without splitting a surrogate pair', async () => {
    const position = await epubPosition(epub(), '/body/DocFragment[2]/body/p/text().4');
    expect(position.cfi).toBe('epubcfi(/8/4!/6/4/1:5)');
    expect(position.page_position_in_book).toBeCloseTo((1 + 10 / 23) / 2, 12);
  });

  it('uses absolute sibling indices rather than same-tag XPath indices', async () => {
    const position = await epubPosition(epub('<p>One</p><aside>Two</aside><p>Three</p>'), '/body/DocFragment[2]/body/p[2]');
    expect(position.cfi).toBe('epubcfi(/8/4!/6/6)');
    expect(position.page_position_in_book).toBeCloseTo((1 + 6 / 11) / 2, 12);
  });

  it('coalesces comment/CDATA/PI-separated text into the correct CFI text slot', async () => {
    const position = await epubPosition(epub('<p>ab<!--split-->cd<![CDATA[ef]]><?pi split?>gh<em>x</em>ij</p>'),
      '/body/DocFragment[2]/body/p/text()[4].1');
    expect(position.cfi).toBe('epubcfi(/8/4!/6/2/1:7)');
    expect(position.page_position_in_book).toBeCloseTo((1 + 7 / 11) / 2, 12);
  });

  it('handles a first-chapter shorthand and a chapter-start XPath without inventing a page', async () => {
    expect(await epubPosition(epub(), '/body/DocFragment/body')).toEqual({
      cfi: 'epubcfi(/8/2!/4)', chapter_index: 0, page_position_in_book: 0,
    });
  });

  it.each([
    '/body/DocFragment[3]/body/p', '/body/DocFragment[0]/body/p',
    '/body/DocFragment[2]/body/p[9]', '/body/DocFragment[2]/body/p/text().100',
    '/body/DocFragment[2]/body/p/text()[0].1', '/body/DocFragment[2]/body/p/text().1/em',
    'some-progress',
  ])('rejects unresolved positions: %s', async xpath => {
    await expect(epubPosition(epub(), xpath)).rejects.toBeInstanceOf(Error);
  });

  it('rejects oversized chapter XML before constructing its DOM', async () => {
    await expect(epubPosition(epub('x'.repeat(1024 * 1024)), XPATH)).rejects.toThrow('exceeds 1 MiB');
  });

  it('does not resolve external XML entities', async () => {
    const bytes = archive({ 'META-INF/container.xml': '<!DOCTYPE container [<!ENTITY x SYSTEM "file:///etc/passwd">]><container>&x;</container>' });
    await expect(epubPosition(bytes, XPATH)).rejects.toBeInstanceOf(Error);
  });
});

describe('BookFusion download and delivery', () => {
  it('converts an existing firmware payload through KOSync, sidecar matching, and the queue', async () => {
    const { app, db } = makeTestApp();
    try {
      const { username, headers } = await registerUser(app);
      const { id } = db.prepare('SELECT id FROM users WHERE username = ?').get(username) as { id: number };
      upsertAccount(db, id, 'bookfusion', { access_token: 'test-token' }, null);
      const res = await app.request('/syncs/progress', {
        method: 'PUT', headers,
        body: JSON.stringify({ document: DOC, progress: XPATH, percentage: 0.070252,
          device_id: 'reader', metadata: { bookfusion_id: '36835' },
          position: { pctQ: 70252, spine: 1, page: 68, pages: 165 } }),
      });
      expect(res.status).toBe(200);
      const fake = transport();
      expect(await drainQueue(db, fake.http)).toBe(1);
      const request = fake.calls.find(c => c.url.endsWith('/reading_position'))!;
      expect(JSON.parse(request.init.body!)).toMatchObject({
        cfi: 'epubcfi(/8/4!/6/4/3:5)', chapter_index: 1, percentage: 7.0252,
      });
      expect(JSON.parse(request.init.body!).page_position_in_book).toBeCloseTo((1 + 19 / 23) / 2, 12);
      expect(db.prepare('SELECT status FROM connector_queue WHERE user_id = ?').get(id)).toEqual({ status: 'done' });
      const storage = fake.calls[1];
      expect(storage.init.headers).toBeUndefined();
      expect(storage.init.redirect).toBe('error');
    } finally { db.close(); }
  });

  it('never posts an estimated position when the XPath cannot be resolved', async () => {
    const fake = transport();
    await expect(bookfusionConnector.push({ access_token: 't' }, { externalId: '7', confidence: 1, fromSidecar: true },
      { kind: 'progress', document: DOC, percentage: 0.5, progress: '/body/DocFragment[2]/body/missing', timestamp: 1 },
      fake.http)).rejects.toMatchObject({ retryable: false });
    expect(fake.calls.some(c => c.url.endsWith('/reading_position'))).toBe(false);
  });

  it('caches archives per credential and book, and expires them', async () => {
    vi.useFakeTimers();
    const fake = transport();
    await bookFusionEpub('a', '7', providerHeaders, fake.http);
    await bookFusionEpub('a', '7', providerHeaders, fake.http);
    expect(fake.calls).toHaveLength(2);
    await bookFusionEpub('b', '7', providerHeaders, fake.http);
    expect(fake.calls).toHaveLength(4);
    vi.setSystemTime(Date.now() + 16 * 60 * 1000);
    await bookFusionEpub('a', '7', providerHeaders, fake.http);
    expect(fake.calls).toHaveLength(6);
  });

  it.each(['http://books.s3.amazonaws.com/a', 'https://127.0.0.1/a', 'https://bookfusion.com.evil.test/a']) (
    'rejects an unsafe storage URL: %s', async url => {
      let calls = 0;
      const http: HttpTransport = async () => {
        calls++;
        return { status: 200, text: async () => '', json: async () => ({ url }) };
      };
      await expect(bookFusionEpub('a', '7', providerHeaders, http)).rejects.toThrow('download host');
      expect(calls).toBe(1);
    }
  );

  it('keeps transient download failures retryable', async () => {
    const http: HttpTransport = async () => ({ status: 503, text: async () => '', json: async () => ({}) });
    await expect(bookFusionEpub('a', '7', providerHeaders, http)).rejects.toMatchObject({ retryable: true, needsReauth: false });
  });
});
