import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bookFusionEpub, clearBookFusionEpubCache, epubPosition, epubXPath } from '../src/connectors/bookfusion-epub.js';
import { bookfusionConnector } from '../src/connectors/bookfusion.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { saveMatch, upsertAccount } from '../src/connectors/store.js';
import { pollAll, pollConnector } from '../src/connectors/fanin.js';
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
      if (init.method === 'GET') return { status: 404, text: async () => '', json: async () => ({}) };
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
      const request = fake.calls.find(c => c.url.endsWith('/reading_position') && c.init.method === 'POST')!;
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


describe('BookFusion CFI conversion', () => {
  it.each([
    ['epubcfi(/8/4!/6/4/3:5)', XPATH],
    ['epubcfi(/8/4!/6/4/1:5)', '/body/DocFragment[2]/body/p[1]/text()[1].4'],
    ['epubcfi(/8/4[b]!/6/4/1)', '/body/DocFragment[2]/body/p[1]/text()[1].0'],
    ['epubcfi(/8/4!/6/4/1)', '/body/DocFragment[2]/body/p[1]/text()[1].0'],
    ['epubcfi(/8/4!/6/4)', '/body/DocFragment[2]/body/p[1]'],
    ['epubcfi(/8/2!/4)', '/body/DocFragment[1]/body'],
  ])('resolves %s and round-trips the position', async (cfi, xpath) => {
    expect(await epubXPath(epub(), cfi)).toBe(xpath);
    const roundtrip = await epubPosition(epub(), xpath);
    expect(await epubXPath(epub(), roundtrip.cfi)).toBe(xpath);
  });

  it('counts actual text nodes, including adjacent text and missing slots', async () => {
    const bytes = epub('<h1>Title</h1><p><em>x</em>ab<!--split-->cd<![CDATA[😀f]]><b>x</b>end</p>');
    const cfi = 'epubcfi(/8/4!/6/4/3:6)';
    const xpath = '/body/DocFragment[2]/body/p[1]/text()[3].1';
    expect(await epubXPath(bytes, cfi)).toBe(xpath);
    expect((await epubPosition(bytes, xpath)).cfi).toBe(cfi);
  });

  it('validates escaped IDs and accepts text assertions and side bias', async () => {
    const bytes = epub('<p id="a]!/;b">hello</p>');
    expect(await epubXPath(bytes, 'epubcfi(/8/4!/6/2[a^]!/^;b]/1:2[he,llo;s=b])'))
      .toBe('/body/DocFragment[2]/body/p[1]/text()[1].2');
  });

  it.each([
    'epubcfi(/8/4!/6/4/1:4)', // Inside the emoji surrogate pair.
    'epubcfi(/8/4!/6/4/1:99)', 'epubcfi(/8/4!/6/4/5:0)',
    'epubcfi(/8/4!/6/4[wrong])', 'epubcfi(/6/4!/6/4)',
    'epubcfi(/8/6!/6/4)', 'epubcfi(/8/4!/2)',
    'epubcfi(/8/4!/6/4/1:0/2)', 'epubcfi(/8/4!/6/4:4)',
    'epubcfi(/8/4!/6/4,/1:0,/1:2)', 'epubcfi(/8/4!/6/4@1:2)',
    'epubcfi(/8/4!/6/4[unterminated)', 'not a cfi',
  ])('rejects invalid or unsupported CFI without guessing: %s', async cfi => {
    await expect(epubXPath(epub(), cfi)).rejects.toBeInstanceOf(Error);
  });
});

const REMOTE_CFI = 'epubcfi(/8/4!/6/4/3:5)';
const START = Date.parse('2026-09-13T20:00:00Z');
function inboundTransport(percentage = 60, cfi: string | null = REMOTE_CFI, at = START + 60_000) {
  const fake = transport();
  const reads: string[] = [];
  const http: HttpTransport = async (url, init) => {
    if (url.endsWith('/reading_position') && init.method === 'GET') {
      reads.push(url);
      return { status: 200, text: async () => '', json: async () => ({
        percentage, cfi, updated_at: new Date(at).toISOString(),
      }) };
    }
    return fake.http(url, init);
  };
  return { ...fake, http, reads };
}

async function linkedReader(percentage = 0.2, progress = '/body/DocFragment[1]/body', http: HttpTransport = transport().http) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(START);
  const { app, db } = makeTestApp({}, { connectorTransport: http });
  const { headers } = await registerUser(app);
  upsertAccount(db, 1, 'bookfusion', { access_token: 'test-token' }, null);
  upsertAccount(db, 1, 'kosync', { server: 'mirror.test', username: 'u', password: 'p' }, null);
  const res = await app.request('/syncs/progress', {
    method: 'PUT', headers, body: JSON.stringify({ document: DOC, progress, percentage,
      device_id: 'reader', metadata: { bookfusion_id: '36835' }, position: { pctQ: 200000, spine: 0, page: 2, pages: 10 } }),
  });
  expect(res.status).toBe(200);
  db.prepare('DELETE FROM connector_queue').run();
  vi.setSystemTime(START + 120_000);
  return { app, db, headers };
}

describe('BookFusion inbound sync', () => {
  it('polls exact matches into the existing KOSync API and mirrors the exact XPath without an echo', async () => {
    const { app, db, headers } = await linkedReader();
    try {
      const fake = inboundTransport();
      expect(await pollConnector(db, 1, 'bookfusion', fake.http)).toBe(1);
      const got = await (await app.request(`/syncs/progress/${DOC}`, { headers })).json();
      expect(got).toMatchObject({ device_id: 'bookfusion', progress: XPATH, percentage: 0.6 });
      const row = db.prepare("SELECT position,updated_at FROM progress WHERE device_id='bookfusion'").get();
      expect(row).toEqual({ position: null, updated_at: (START + 60_000) / 1000 });
      const queued = db.prepare('SELECT connector_id,payload FROM connector_queue').all() as { connector_id: string; payload: string }[];
      expect(queued.map(q => q.connector_id)).toEqual(['kosync']);
      expect(JSON.parse(queued[0].payload)).toMatchObject({ progress: XPATH, percentage: 0.6, position: null });
      expect(await pollConnector(db, 1, 'bookfusion', fake.http)).toBe(0);
      expect(fake.calls.filter(c => c.url.endsWith('/download'))).toHaveLength(1);
    } finally { db.close(); }
  });

  it('does not suppress a real page advance within the old 0.5% echo tolerance', async () => {
    const { db } = await linkedReader(0.6);
    try {
      expect(await pollConnector(db, 1, 'bookfusion', inboundTransport(60.01).http)).toBe(1);
    } finally { db.close(); }
  });

  it('remembers an echo timestamp without broadcasting it again', async () => {
    const { db } = await linkedReader(0.6, XPATH);
    try {
      expect(await pollConnector(db, 1, 'bookfusion', inboundTransport().http)).toBe(0);
      expect(db.prepare('SELECT COUNT(*) n FROM connector_queue').get()).toEqual({ n: 0 });
      expect(db.prepare("SELECT updated_at FROM progress WHERE device_id='bookfusion'").get())
        .toEqual({ updated_at: (START + 60_000) / 1000 });
    } finally { db.close(); }
  });

  it('does not replace a newer device upload with an older remote position', async () => {
    const { db } = await linkedReader();
    try {
      const fake = inboundTransport(60, REMOTE_CFI, START - 60_000);
      expect(await pollConnector(db, 1, 'bookfusion', fake.http)).toBe(0);
      expect(fake.calls).toHaveLength(0); // No EPUB needed for a stale source timestamp.
    } finally { db.close(); }
  });

  it('rechecks progress after an upload arrives during the provider request', async () => {
    const { app, db, headers } = await linkedReader();
    try {
      const fake = inboundTransport();
      const http: HttpTransport = async (url, init) => {
        if (url.endsWith('/reading_position')) await app.request('/syncs/progress', {
          method: 'PUT', headers, body: JSON.stringify({ document: DOC, progress: '/body/DocFragment[2]/body',
            percentage: 0.9, device_id: 'reader' }),
        });
        return fake.http(url, init);
      };
      expect(await pollConnector(db, 1, 'bookfusion', http)).toBe(0);
      expect(db.prepare("SELECT COUNT(*) n FROM progress WHERE device_id='bookfusion'").get()).toEqual({ n: 0 });
    } finally { db.close(); }
  });

  it('does not import exact positions into a manually matched edition', async () => {
    const { db } = await linkedReader();
    try {
      saveMatch(db, 1, 'bookfusion', DOC, { externalId: '36835', confidence: 1 }, 'manual');
      const fake = inboundTransport();
      expect(await pollConnector(db, 1, 'bookfusion', fake.http)).toBe(0);
      expect(fake.reads).toHaveLength(0);
    } finally { db.close(); }
  });

  it('isolates a failed book and retries it even after another book succeeds', async () => {
    const { db } = await linkedReader();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      saveMatch(db, 1, 'bookfusion', 'second', { externalId: 'second', confidence: 1 }, 'sidecar');
      let fail = true;
      const fake = inboundTransport();
      const http: HttpTransport = async (url, init) => {
        if (fail && url.includes('/36835/reading_position')) return { status: 503, text: async () => '', json: async () => ({}) };
        return fake.http(url, init);
      };
      expect(await pollConnector(db, 1, 'bookfusion', http)).toBe(1);
      fail = false;
      expect(await pollConnector(db, 1, 'bookfusion', http)).toBe(1);
    } finally { log.mockRestore(); db.close(); }
  });

  it.each([null, 'epubcfi(/8/4!/6/99)'])('never substitutes a sample for an unresolved remote CFI: %s', async cfi => {
    const { db } = await linkedReader();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await pollConnector(db, 1, 'bookfusion', inboundTransport(60, cfi).http)).toBe(0);
      expect(db.prepare("SELECT COUNT(*) n FROM progress WHERE device_id='bookfusion'").get()).toEqual({ n: 0 });
    } finally { log.mockRestore(); db.close(); }
  });

  it('does not import a result after the match is changed while polling', async () => {
    const { db } = await linkedReader();
    try {
      const fake = inboundTransport();
      const http: HttpTransport = async (url, init) => {
        saveMatch(db, 1, 'bookfusion', DOC, { externalId: 'different', confidence: 1 }, 'manual');
        return fake.http(url, init);
      };
      expect(await pollConnector(db, 1, 'bookfusion', http)).toBe(0);
    } finally { db.close(); }
  });

  it('stops polling an expired account and exposes the reauthorization requirement', async () => {
    const { db } = await linkedReader();
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      let calls = 0;
      const http: HttpTransport = async () => {
        calls++;
        return { status: 401, text: async () => '', json: async () => ({}) };
      };
      expect(await pollConnector(db, 1, 'bookfusion', http)).toBe(0);
      expect(db.prepare("SELECT status FROM connector_accounts WHERE connector_id='bookfusion'").get())
        .toEqual({ status: 'needs_reauth' });
      expect(await pollConnector(db, 1, 'bookfusion', http)).toBe(0);
      expect(calls).toBe(1);
    } finally { log.mockRestore(); db.close(); }
  });

  it('allows a fresh upload after checking an older BookFusion position', async () => {
    const fake = inboundTransport(60, REMOTE_CFI, START - 60_000);
    expect(await bookfusionConnector.push({ access_token: 't' }, { externalId: '7', confidence: 1, fromSidecar: true },
      { kind: 'progress', document: DOC, percentage: 0.7, progress: XPATH, timestamp: START / 1000 }, fake.http))
      .toEqual({ ok: true });
    expect(fake.calls.filter(c => c.url.endsWith('/reading_position') && c.init.method === 'POST')).toHaveLength(1);
  });

  it('does not send a delayed queued upload over a newer BookFusion position', async () => {
    const fake = inboundTransport();
    expect(await bookfusionConnector.push({ access_token: 't' }, { externalId: '7', confidence: 1, fromSidecar: true },
      { kind: 'progress', document: DOC, percentage: 0.2, progress: XPATH, timestamp: START / 1000 }, fake.http))
      .toEqual({ ok: true });
    expect(fake.calls.some(c => c.url.endsWith('/reading_position') && c.init.method === 'POST')).toBe(false);
  });
});


describe('BookFusion refresh on progress GET', () => {
  it.each(['/syncs/progress/', '/api/v1/progress/'])('refreshes before answering %s', async endpoint => {
    const fake = inboundTransport();
    const { app, db, headers } = await linkedReader(0.2, '/body/DocFragment[1]/body', fake.http);
    try {
      saveMatch(db, 1, 'bookfusion', 'unrelated', { externalId: 'other-book', confidence: 1 }, 'sidecar');
      expect(await pollAll(db, fake.http)).toBe(0);
      expect(fake.reads).toHaveLength(0); // No BookFusion background polling.
      const response = await app.request(endpoint + DOC, { headers });
      expect(response.status).toBe(200);
      const body = await response.json();
      const position = endpoint.startsWith('/api/') ? body.devices[0] : body;
      expect(position).toMatchObject({ device_id: 'bookfusion', percentage: 0.6, progress: XPATH });
      expect(fake.reads).toHaveLength(1);
      expect(fake.reads[0]).toContain('/36835/reading_position');
      await app.request(endpoint + DOC, { headers });
      expect(fake.reads).toHaveLength(2); // A fresh GET checks for a fresh provider update.
    } finally { db.close(); }
  });

  it('shares one refresh across concurrent legacy and extended GETs', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fake = inboundTransport();
    let lookups = 0;
    const http: HttpTransport = async (url, init) => {
      if (url.endsWith('/reading_position')) { lookups++; await gate; }
      return fake.http(url, init);
    };
    const { app, db, headers } = await linkedReader(0.2, '/body/DocFragment[1]/body', http);
    try {
      const first = app.request('/syncs/progress/' + DOC, { headers });
      const second = app.request('/api/v1/progress/' + DOC, { headers });
      await vi.waitFor(() => expect(lookups).toBe(1));
      release();
      expect((await first).status).toBe(200);
      expect((await second).status).toBe(200);
      expect(lookups).toBe(1);
    } finally { release(); db.close(); }
  });

  it.each(['unlinked', 'disabled', 'manual', 'unmatched'])('does not call BookFusion for %s books/accounts', async state => {
    const fake = inboundTransport();
    const { app, db, headers } = await linkedReader(0.2, '/body/DocFragment[1]/body', fake.http);
    try {
      if (state === 'unlinked') db.prepare("DELETE FROM connector_accounts WHERE connector_id='bookfusion'").run();
      if (state === 'disabled') db.prepare("UPDATE connector_accounts SET enabled=0 WHERE connector_id='bookfusion'").run();
      if (state === 'manual') db.prepare("UPDATE connector_matches SET source='manual'").run();
      if (state === 'unmatched') db.prepare('DELETE FROM connector_matches').run();
      const response = await app.request('/syncs/progress/' + DOC, { headers });
      expect(response.status).toBe(200);
      expect((await response.json()).percentage).toBe(0.2);
      expect(fake.reads).toHaveLength(0);
    } finally { db.close(); }
  });

  it('returns 502 on provider failure, preserves progress, and retries on the next GET', async () => {
    const fake = inboundTransport();
    let failed = true;
    const http: HttpTransport = (url, init) => failed
      ? Promise.resolve({ status: 503, text: async () => '', json: async () => ({}) })
      : fake.http(url, init);
    const { app, db, headers } = await linkedReader(0.2, '/body/DocFragment[1]/body', http);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await app.request('/syncs/progress/' + DOC, { headers })).status).toBe(502);
      expect(db.prepare("SELECT COUNT(*) n FROM progress WHERE device_id='bookfusion'").get()).toEqual({ n: 0 });
      failed = false;
      const response = await app.request('/syncs/progress/' + DOC, { headers });
      expect(response.status).toBe(200);
      expect((await response.json()).percentage).toBe(0.6);
    } finally { log.mockRestore(); db.close(); }
  });

  it('limits the entire refresh and prevents late completion from updating progress', async () => {
    let release!: () => void;
    let signal: AbortSignal | undefined;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fake = inboundTransport();
    const http: HttpTransport = async (url, init) => {
      signal = init.signal;
      await gate; // Deliberately ignores abort, to exercise the late-result guard.
      return fake.http(url, init);
    };
    const { app, db, headers } = await linkedReader(0.2, '/body/DocFragment[1]/body', http);
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(START + 120_000);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const pending = app.request('/syncs/progress/' + DOC, { headers });
      await vi.advanceTimersByTimeAsync(0);
      expect(signal).toBeDefined();
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await pending).status).toBe(504);
      expect(signal?.aborted).toBe(true);
      release();
      await vi.advanceTimersByTimeAsync(0);
      expect(db.prepare("SELECT COUNT(*) n FROM progress WHERE device_id='bookfusion'").get()).toEqual({ n: 0 });
      expect(fake.calls).toHaveLength(0); // No download may start after expiration.
    } finally { release(); log.mockRestore(); db.close(); }
  });
});
