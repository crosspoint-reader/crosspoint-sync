import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { crc32 } from 'node:zlib';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import type { HttpTransport, OutboundEvent } from '../src/connectors/types.js';
import { drainQueue } from '../src/connectors/runner.js';
import { clearReadestSearches, readestBase, readestConnector } from '../src/connectors/readest.js';
import { SAVE_CREDENTIAL } from '../src/connectors/types.js';
import { clearBookFusionEpubCache } from '../src/connectors/bookfusion-epub.js';

function fakeTransport() {
  const calls: { url: string; method: string; headers?: Record<string, string>; body?: string }[] = [];
  const handlers: { match: string; status: number; body: unknown }[] = [];
  const t: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body });
    const h = [...handlers].reverse().find((x) => url.includes(x.match));
    const answer = typeof h?.body === 'function' ? h.body(init.body ? JSON.parse(init.body) : null) : { status: h?.status ?? 200, body: h?.body ?? {} };
    const { status, body } = answer as { status: number; body: unknown };
    if (Buffer.isBuffer(body)) {
      return { status, text: async () => '', json: async () => null, body: new ReadableStream({ start(cl) { cl.enqueue(body); cl.close(); } }) };
    }
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body };
  };
  return { transport: t, calls, on: (m: string, s: number, b: unknown) => handlers.push({ match: m, status: s, body: b }) };
}

const SERVER = 'https://web.readest.com/api/crosspoint';
const SESSION = { access_token: 'at-1', refresh_token: 'rt-1', expires_at: Math.floor(Date.now() / 1000) + 3600 };
const CRED = { server: SERVER, key: 'k'.repeat(64), keyId: 'uuid', username: 'reader@example.com', ...SESSION };

// Readest's sign-in: the user approves the session code; the link approves a second code itself for the reader key.
function signIn(fake: ReturnType<typeof fakeTransport>) {
  let codes = 0;
  fake.on('/device/code', 200, () => ({ status: 200, body: {
    device_code: `dc-${++codes}`, user_code: codes === 1 ? 'BCDF-GHJK' : 'LMNP-QRST', verification_uri: 'https://web.readest.com/link',
    verification_uri_complete: 'https://web.readest.com/link?code=BCDF-GHJK', expires_in: 600, interval: 5,
  } }));
  fake.on('/device/approve', 200, { ok: true });
  fake.on('/device/token', 200, (req: { device_code: string; grant?: string }) => req.grant === 'session'
    ? { status: 200, body: { ...SESSION, token_type: 'bearer', expires_in: 3600, user: { id: 'u1', email: CRED.username } } }
    : { status: 200, body: { access_token: CRED.key, token_type: 'bearer', id: 'uuid', username: CRED.username } });
  fake.on('/users/auth', 200, { authorized: 'OK' });
}

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
// Visible chapter 2 text: "Title" 0-4, "Pre" 5-7, "bold" 8-11, " tail" 12-16.
const EPUB = archive({
  'META-INF/container.xml': '<container><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  'EPUB/package.opf': '<package><metadata/><manifest><item id="a" href="ch1.xhtml"/><item id="b" href="ch2.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
  'EPUB/ch1.xhtml': '<html><head/><body><p>First</p></body></html>',
  'EPUB/ch2.xhtml': '<html xmlns="http://www.w3.org/1999/xhtml"><head/><body><h1>Title</h1><p>Pre<em>bold</em> tail</p></body></html>',
});
const BOOK = 'b'.repeat(32);
const library = (books: unknown[]) => ({ books, configs: [], notes: [] });
const libraryBook = (over: Record<string, unknown> = {}) => ({
  book_hash: BOOK, meta_hash: 'meta-1', title: 'Piranesi', author: 'Susanna Clarke', format: 'EPUB',
  uploaded_at: '2026-01-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', deleted_at: null, ...over,
});
function bookFiles(fake: ReturnType<typeof fakeTransport>) {
  fake.on(`/api/crosspoint/books/${BOOK}`, 200, { downloadUrl: 'https://files.readest.test/book.epub?sig=1' });
  fake.on('https://files.readest.test/', 200, EPUB);
}
const highlightEvent = (over: Partial<NonNullable<OutboundEvent['highlight']>> = {}): OutboundEvent => ({
  kind: 'highlight', document: DOC, timestamp: 1_760_000_100,
  highlight: { text: 'bold tail', note: 'nice', spine: 1, startOffset: 8, endOffset: 17, chapter: 'Two', highlightedAt: 1_760_000_000, ...over },
});
const MATCH = { externalId: DOC, confidence: 1, title: 'Piranesi', author: 'Susanna Clarke' };
const XPOINTER = '/body/DocFragment[8]/body/p[4]/text()[1].96';
const progressEvent = (over: Partial<OutboundEvent> = {}): OutboundEvent => ({
  kind: 'progress',
  document: DOC,
  percentage: 0.42,
  progress: XPOINTER,
  timestamp: 1_760_000_000,
  ...over,
});
const body = (call: { body?: string }) => JSON.parse(call.body ?? '{}');

const KEY = { TOKEN_ENC_KEY: 'a'.repeat(64) };
beforeEach(() => { Object.assign(process.env, KEY); resetEncryptionKeyCache(); clearBookFusionEpubCache(); clearReadestSearches(); });
afterEach(() => { vi.useRealTimers(); delete process.env.TOKEN_ENC_KEY; delete process.env.READEST_URL; resetEncryptionKeyCache(); });

describe('readest connector (unit)', () => {
  it('points at Readest unless READEST_URL says otherwise', () => {
    expect(readestBase({})).toBe('https://web.readest.com');
    expect(readestBase({ READEST_URL: 'http://localhost:3000/' })).toBe('http://localhost:3000');
  });

  it('maps each sign-in poll answer', async () => {
    const fake = fakeTransport();
    fake.on('/device/token', 400, { error: 'authorization_pending' });
    expect((await readestConnector.pollLink!('dc', fake.transport)).status).toBe('pending');
    fake.on('/device/token', 400, { error: 'expired_token' });
    expect((await readestConnector.pollLink!('dc', fake.transport)).status).toBe('expired');
    fake.on('/device/token', 500, { error: 'server_error' });
    expect((await readestConnector.pollLink!('dc', fake.transport)).status).toBe('pending');
    expect(body(fake.calls[0])).toEqual({ device_code: 'dc', grant: 'session' });
  });

  it('keeps the session once approved, and approves a reader key with it', async () => {
    const fake = fakeTransport();
    signIn(fake);
    expect(await readestConnector.pollLink!('dc-0', fake.transport)).toEqual({
      status: 'ok', credential: CRED, accountLabel: 'Readest (reader@example.com)',
    });
    const approve = fake.calls.find((c) => c.url.endsWith('/device/approve'))!;
    expect(approve.headers?.authorization).toBe('Bearer at-1');
    expect(body(approve)).toEqual({ user_code: 'BCDF-GHJK' });
    expect(body(fake.calls.at(-1)!)).toEqual({ device_code: 'dc-1' });
  });

  it('says to start again when the reader key cannot be issued', async () => {
    const fake = fakeTransport();
    signIn(fake);
    fake.on('/device/approve', 404, { error: 'Code not found or expired' });
    expect(await readestConnector.pollLink!('dc-0', fake.transport)).toMatchObject({ status: 'error', error: expect.stringContaining('Start again') });
  });

  it('sends the md5 of the key, as KOSync clients do', async () => {
    const fake = fakeTransport();
    await readestConnector.push(CRED, MATCH, progressEvent(), fake.transport);
    expect(fake.calls[0].headers?.['x-auth-key']).toBe(crypto.createHash('md5').update(CRED.key).digest('hex'));
  });

  it('sends the XPointer with the book metadata, and skips a position without one', async () => {
    const fake = fakeTransport();
    expect(await readestConnector.push(CRED, MATCH, progressEvent(), fake.transport)).toEqual({ ok: true });
    expect(fake.calls[0]).toMatchObject({ method: 'PUT', url: `${SERVER}/syncs/progress` });
    expect(body(fake.calls[0])).toEqual({
      document: DOC, progress: XPOINTER, percentage: 0.42, device: 'CrossPoint Sync', device_id: 'crosspoint-sync',
      metadata: { title: 'Piranesi', authors: 'Susanna Clarke' },
    });
    expect(await readestConnector.push(CRED, MATCH, progressEvent({ progress: '0.42' }), fake.transport)).toEqual({ ok: true });
    expect(fake.calls).toHaveLength(1);
  });

  it('asks to link again on 401 and retries a rate limit or server error', async () => {
    const fake = fakeTransport();
    fake.on('/syncs/progress', 401, {});
    expect(await readestConnector.push(CRED, MATCH, progressEvent(), fake.transport)).toMatchObject({ needsReauth: true, retryable: false });
    fake.on('/syncs/progress', 429, {});
    expect(await readestConnector.push(CRED, MATCH, progressEvent(), fake.transport)).toMatchObject({ retryable: true });
    fake.on('/syncs/progress', 500, {});
    expect(await readestConnector.push(CRED, MATCH, progressEvent(), fake.transport)).toMatchObject({ retryable: true });
  });

  it('brings back Readest\'s XPointer as a forward-only place, and nothing for an unknown book', async () => {
    const fake = fakeTransport();
    fake.on(`/syncs/progress/${DOC}`, 200, {
      document: DOC, progress: XPOINTER, percentage: 0.5, device: 'Readest', device_id: 'readest', timestamp: 1_760_000_000,
    });
    expect(await readestConnector.pullProgress!(CRED, MATCH, fake.transport, 0)).toEqual({
      externalId: DOC, percentage: 0.5, progress: XPOINTER, finished: false, updatedAtMs: 1_760_000_000_000, furthestReadOnly: true,
    });
    fake.on(`/syncs/progress/${DOC}`, 404, { message: 'Not found' });
    expect(await readestConnector.pullProgress!(CRED, MATCH, fake.transport, 0)).toBeNull();
  });
});

describe('readest connector highlights', () => {
  it('places a clipping in Readest\'s copy of the book and saves it as a note', async () => {
    const fake = fakeTransport();
    bookFiles(fake);
    fake.on('/api/sync?since=0&type=books&book=', 200, library([libraryBook({ book_hash: DOC })]));
    fake.on(`/api/crosspoint/books/${DOC}`, 200, { downloadUrl: 'https://files.readest.test/book.epub?sig=1' });
    fake.on('/api/sync', 200, (req: unknown) => req ? { status: 200, body: library([]) } : { status: 200, body: library([libraryBook({ book_hash: DOC })]) });
    expect(await readestConnector.push(CRED, MATCH, highlightEvent(), fake.transport)).toEqual({ ok: true });
    const post = fake.calls.find((c) => c.method === 'POST' && c.url === 'https://web.readest.com/api/sync')!;
    expect(post.headers?.authorization).toBe('Bearer at-1');
    const note = body(post).notes[0];
    expect(note).toEqual({
      bookHash: DOC, metaHash: 'meta-1', id: expect.stringMatching(/^[0-9a-f]{7}$/), type: 'annotation',
      cfi: 'epubcfi(/6/4!/4/4,/2/1:0,/3:5)',
      xpointer0: '/body/DocFragment[2]/body/p[1]/em[1]/text()[1].0', xpointer1: '/body/DocFragment[2]/body/p[1]/text()[2].5',
      text: 'bold tail', note: 'nice', style: 'highlight', color: 'yellow',
      createdAt: 1_760_000_000_000, updatedAt: 1_760_000_100_000,
    });
    // The same clipping sent again keeps its id, so Readest updates it.
    await readestConnector.push(CRED, MATCH, highlightEvent({ note: 'edited' }), fake.transport);
    const again = fake.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/api/sync')).at(-1)!;
    expect(body(again).notes[0]).toMatchObject({ id: note.id, note: 'edited' });
  });

  it('finds a rewritten copy by title and first author', async () => {
    const fake = fakeTransport();
    bookFiles(fake);
    fake.on('/api/sync', 200, (req: unknown) => ({ status: 200, body: req ? library([]) : library([
      libraryBook({ book_hash: 'c'.repeat(32), uploaded_at: null }),
      libraryBook({ title: 'Piranesi', author: 'Susanna Clarke, Someone Else' }),
    ]) }));
    expect(await readestConnector.push(CRED, MATCH, highlightEvent(), fake.transport)).toEqual({ ok: true });
    const post = fake.calls.find((c) => c.method === 'POST')!;
    expect(body(post).notes[0].bookHash).toBe(BOOK);
  });

  it('gives up on a book that is not in the Readest library, and on text that is not at its position', async () => {
    const fake = fakeTransport();
    fake.on('/api/sync', 200, library([]));
    fake.on(`/api/crosspoint/books/${DOC}`, 404, { error: 'Book not found' });
    expect(await readestConnector.push(CRED, MATCH, highlightEvent(), fake.transport)).toMatchObject({
      ok: false, retryable: false, error: expect.stringContaining('not in your Readest library'),
    });
    bookFiles(fake);
    fake.on('/api/sync', 200, library([libraryBook()]));
    expect(await readestConnector.push(CRED, MATCH, highlightEvent({ text: 'something else' }), fake.transport)).toMatchObject({ ok: false, retryable: false });
    expect(fake.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('places a clipping in a file Readest holds before its library entry exists', async () => {
    const fake = fakeTransport();
    fake.on('/api/sync', 200, library([]));
    fake.on(`/api/crosspoint/books/${DOC}`, 200, { downloadUrl: 'https://files.readest.test/book.epub?sig=1' });
    fake.on('https://files.readest.test/', 200, EPUB);
    expect(await readestConnector.push(CRED, MATCH, highlightEvent(), fake.transport)).toEqual({ ok: true });
    const note = body(fake.calls.find((c) => c.method === 'POST')!).notes[0];
    expect(note).toMatchObject({ bookHash: DOC, text: 'bold tail', cfi: 'epubcfi(/6/4!/4/4,/2/1:0,/3:5)' });
    expect(note).not.toHaveProperty('metaHash');
  });

  it('refreshes an expired session once and saves the rotated tokens', async () => {
    const fake = fakeTransport();
    bookFiles(fake);
    fake.on('/api/sync', 200, library([libraryBook()]));
    fake.on('/auth/v1/token?grant_type=refresh_token', 200, { access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 });
    let saved = 0;
    const cred = { ...CRED, access_token: 'old', refresh_token: 'rt-old', expires_at: 1, [SAVE_CREDENTIAL]: () => { saved++; } };
    expect(await readestConnector.push(cred, MATCH, highlightEvent(), fake.transport)).toEqual({ ok: true });
    const refresh = fake.calls.filter((c) => c.url.includes('/auth/v1/token'));
    expect(refresh).toHaveLength(1);
    expect(body(refresh[0])).toEqual({ refresh_token: 'rt-old' });
    expect(refresh[0].headers?.apikey).toMatch(/^eyJ/);
    expect(cred).toMatchObject({ access_token: 'at-2', refresh_token: 'rt-2' });
    expect(saved).toBe(1);
    expect(fake.calls.filter((c) => c.url.includes('/api/sync')).every((c) => c.headers?.authorization === 'Bearer at-2')).toBe(true);
  });

  it('asks to link again when Readest revokes the session', async () => {
    const fake = fakeTransport();
    fake.on('/auth/v1/token', 400, { error: 'invalid_grant' });
    const cred = { ...CRED, refresh_token: 'rt-revoked', expires_at: 1 };
    expect(await readestConnector.push(cred, MATCH, highlightEvent(), fake.transport)).toMatchObject({ ok: false, needsReauth: true });
  });
});

// Readest's own note rows, as GET /api/sync returns them.
const readestNote = (over: Record<string, unknown> = {}) => ({
  book_hash: BOOK, meta_hash: 'meta-1', id: 'n1', type: 'annotation', style: 'highlight', color: 'yellow',
  cfi: 'epubcfi(/6/4!/4/4,/2/1:0,/3:5)', text: 'bold tail', note: 'from Readest',
  created_at: '2025-10-09T08:53:20.000Z', updated_at: '2025-10-09T08:53:20.000Z', deleted_at: null, ...over,
});
function readestLibrary(fake: ReturnType<typeof fakeTransport>, notes: unknown[]) {
  bookFiles(fake);
  fake.on('/api/sync', 200, library([libraryBook()]));
  fake.on('type=notes', 200, { books: [], configs: [], notes });
}

describe('readest connector highlight pull', () => {
  it('brings back a Readest highlight as chapter offsets in its copy of the book', async () => {
    const fake = fakeTransport();
    readestLibrary(fake, [readestNote()]);
    expect(await readestConnector.pullHighlights!(CRED, MATCH, fake.transport, () => false)).toEqual([{
      text: 'bold tail', note: 'from Readest', chapter: null, spine: 1, startOffset: 8, endOffset: 17, createdAt: 1_760_000_000,
    }]);
    // Nothing under our own hash, so the library copy with the same title is asked next.
    expect(fake.calls.filter((c) => c.url.includes('type=notes')).map((c) => c.url)).toEqual([
      `https://web.readest.com/api/sync?since=0&type=notes&book=${DOC}`,
      `https://web.readest.com/api/sync?since=0&type=notes&book=${BOOK}`,
    ]);
    expect(fake.calls.find((c) => c.url.includes('type=notes'))!.headers?.authorization).toBe('Bearer at-1');
  });

  it('reads highlights stored under the file\'s own hash without a library entry', async () => {
    const fake = fakeTransport();
    fake.on(`/api/crosspoint/books/${DOC}`, 200, { downloadUrl: 'https://files.readest.test/book.epub?sig=1' });
    fake.on('https://files.readest.test/', 200, EPUB);
    fake.on('/api/sync', 200, library([]));
    fake.on('type=notes', 200, { books: [], configs: [], notes: [readestNote({ book_hash: DOC })] });
    expect(await readestConnector.pullHighlights!(CRED, MATCH, fake.transport, () => false)).toEqual([
      expect.objectContaining({ text: 'bold tail', spine: 1, startOffset: 8, endOffset: 17 }),
    ]);
  });

  it('imports highlights from both the file\'s own copy and the library copy', async () => {
    const fake = fakeTransport();
    readestLibrary(fake, []);
    fake.on(`/api/crosspoint/books/${DOC}`, 200, { downloadUrl: 'https://files.readest.test/book.epub?sig=1' });
    fake.on(`type=notes&book=${DOC}`, 200, { books: [], configs: [], notes: [readestNote({ book_hash: DOC })] });
    fake.on(`type=notes&book=${BOOK}`, 200, { books: [], configs: [], notes: [readestNote({ id: 'n2', cfi: 'epubcfi(/6/4!/4/4,/1:0,/1:3)', text: 'Pre' })] });
    const got = await readestConnector.pullHighlights!(CRED, MATCH, fake.transport, () => false);
    expect(got.map((h) => h.text).sort()).toEqual(['Pre', 'bold tail']);
  });

  it('still imports the library copy when the file\'s own copy cannot be downloaded', async () => {
    const fake = fakeTransport();
    readestLibrary(fake, []);
    fake.on(`/api/crosspoint/books/${DOC}`, 404, { error: 'Book not found' });
    fake.on(`type=notes&book=${DOC}`, 200, { books: [], configs: [], notes: [readestNote({ book_hash: DOC, text: 'Pre', cfi: 'epubcfi(/6/4!/4/4,/1:0,/1:3)' })] });
    fake.on(`type=notes&book=${BOOK}`, 200, { books: [], configs: [], notes: [readestNote()] });
    expect((await readestConnector.pullHighlights!(CRED, MATCH, fake.transport, () => false)).map((h) => h.text)).toEqual(['bold tail']);
    // A server error still fails the pull, so it is retried.
    fake.on(`/api/crosspoint/books/${DOC}`, 503, {});
    await expect(readestConnector.pullHighlights!(CRED, MATCH, fake.transport, () => false)).rejects.toThrow('503');
  });

  it('skips a highlight whose position covers more text than the highlight', async () => {
    const fake = fakeTransport();
    // The range covers "Pre bold tail"; the note says only "Pre".
    readestLibrary(fake, [readestNote({ cfi: 'epubcfi(/6/4!/4/4,/1:0,/3:5)', text: 'Pre' })]);
    expect(await readestConnector.pullHighlights!(CRED, MATCH, fake.transport, () => false)).toEqual([]);
  });

  it('does not download the book again for a highlight it could not place, until it is edited', async () => {
    const fake = fakeTransport();
    readestLibrary(fake, [readestNote({ text: 'something else' })]);
    const downloads = () => fake.calls.filter((c) => c.url.startsWith('https://files.readest.test/')).length;
    await readestConnector.pullHighlights!(CRED, MATCH, fake.transport, () => false);
    clearBookFusionEpubCache();
    await readestConnector.pullHighlights!(CRED, MATCH, fake.transport, () => false);
    expect(downloads()).toBe(1);
    fake.on('type=notes', 200, { books: [], configs: [], notes: [readestNote({ updated_at: '2026-01-02T00:00:00Z' })] });
    expect(await readestConnector.pullHighlights!(CRED, MATCH, fake.transport, () => false)).toHaveLength(1);
    expect(downloads()).toBe(2);
  });

  it('leaves out known, deleted, other-copy and misplaced highlights, and bookmarks', async () => {
    const fake = fakeTransport();
    readestLibrary(fake, [
      readestNote({ id: 'known', text: 'Pre' , cfi: 'epubcfi(/6/4!/4/4,/1:0,/1:3)' }),
      readestNote({ id: 'gone', deleted_at: '2026-01-01T00:00:00Z' }),
      readestNote({ id: 'other', book_hash: 'c'.repeat(32) }),
      readestNote({ id: 'moved', text: 'something else' }),
      readestNote({ id: 'mark', type: 'bookmark' }),
      readestNote({ id: 'broken', cfi: 'epubcfi(/6/99!/4)' }),
    ]);
    expect(await readestConnector.pullHighlights!(CRED, MATCH, fake.transport, (t) => t === 'Pre')).toEqual([]);
    // Nothing left to place, so the EPUB is never fetched for the skipped ones alone.
    const none = fakeTransport();
    readestLibrary(none, [readestNote({ deleted_at: '2026-01-01T00:00:00Z' })]);
    expect(await readestConnector.pullHighlights!(CRED, MATCH, none.transport, () => false)).toEqual([]);
    expect(none.calls.some((c) => c.url.startsWith('https://files.readest.test/'))).toBe(false);
  });

  it('leaves the spaces a Readest selection took in out of the clipping', async () => {
    const fake = fakeTransport();
    // " tail" is 12-17 in chapter 2; Readest took in the space before it.
    readestLibrary(fake, [readestNote({ cfi: 'epubcfi(/6/4!/4/4,/3:0,/3:5)', text: ' tail' })]);
    expect(await readestConnector.pullHighlights!(CRED, MATCH, fake.transport, () => false)).toEqual([
      expect.objectContaining({ text: 'tail', startOffset: 13, endOffset: 17 }),
    ]);
  });

  it('lists the Readest library at most once an hour for a book Readest does not have', async () => {
    const fake = fakeTransport();
    fake.on('/api/sync', 200, library([]));
    const listings = () => fake.calls.filter((c) => c.url.endsWith('?since=0&type=books')).length;
    const cred = { ...CRED, expires_at: Math.floor(Date.now() / 1000) + 24 * 3600 };
    await readestConnector.pullHighlights!(cred, MATCH, fake.transport, () => false);
    await readestConnector.pullHighlights!(cred, MATCH, fake.transport, () => false);
    expect(listings()).toBe(1);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61 * 60_000 });
    await readestConnector.pullHighlights!(cred, MATCH, fake.transport, () => false);
    expect(listings()).toBe(2);
  });

  it('brings back nothing for a book that is not in the Readest library', async () => {
    const fake = fakeTransport();
    fake.on('/api/sync', 200, library([]));
    expect(await readestConnector.pullHighlights!(CRED, MATCH, fake.transport, () => false)).toEqual([]);
    expect(fake.calls.filter((c) => c.url.includes('type=notes'))).toHaveLength(1);
    expect(fake.calls.some((c) => c.url.startsWith('https://files.readest.test/'))).toBe(false);
  });
});

describe('readest connector (end to end)', () => {
  it('links by device code, then forwards a device sync', async () => {
    const fake = fakeTransport();
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);

    signIn(fake);
    const begin = await app.request('/api/v1/connectors/readest/link/begin', { method: 'POST', headers });
    expect(begin.status).toBe(200);
    const { device_code } = await begin.json();
    const poll = await app.request('/api/v1/connectors/readest/link/poll', { method: 'POST', headers, body: JSON.stringify({ device_code }) });
    expect((await poll.json()).linked).toBe(true);

    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: XPOINTER, percentage: 0.5, device_id: 'd1', metadata: { title: 'Piranesi', authors: 'Susanna Clarke' } }),
    });
    await drainQueue(db, fake.transport, 10);
    const sent = fake.calls.find((c) => c.url === `${SERVER}/syncs/progress`);
    expect(body(sent!)).toMatchObject({ document: DOC, progress: XPOINTER, percentage: 0.5, metadata: { title: 'Piranesi' } });

    // Readest further along: the device gets that place, and an older one never pulls it back.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 60_000 });
    const read = async () => (await (await app.request(`/syncs/progress/${DOC}`, { headers })).json()) as { percentage: number; progress: string };
    const ahead = '/body/DocFragment[12]/body/p[1]/text()[1].0';
    fake.on(`/syncs/progress/${DOC}`, 200, { document: DOC, progress: ahead, percentage: 0.7, device: 'Readest', device_id: 'readest', timestamp: Math.floor(Date.now() / 1000) });
    expect(await read()).toMatchObject({ percentage: 0.7, progress: ahead });
    fake.on(`/syncs/progress/${DOC}`, 200, { document: DOC, progress: '/body/DocFragment[2]/body/p[1]', percentage: 0.1, device: 'Readest', device_id: 'readest', timestamp: Math.floor(Date.now() / 1000) + 5 });
    expect((await read()).percentage).toBe(0.7);
  });

  it('sends a clipping the reader uploads to Readest as a highlight', async () => {
    const fake = fakeTransport();
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    signIn(fake);
    const { device_code } = await (await app.request('/api/v1/connectors/readest/link/begin', { method: 'POST', headers })).json();
    await app.request('/api/v1/connectors/readest/link/poll', { method: 'POST', headers, body: JSON.stringify({ device_code }) });
    bookFiles(fake);
    fake.on('/api/sync', 200, library([libraryBook()]));

    await app.request('/syncs/progress', {
      method: 'PUT', headers,
      body: JSON.stringify({ document: DOC, progress: XPOINTER, percentage: 0.5, device_id: 'd1', metadata: { title: 'Piranesi', authors: 'Susanna Clarke' } }),
    });
    const put = await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT', headers,
      body: JSON.stringify({ items: [{
        id: 'c0ffee0011223344', spine: 1, start_page: 1, end_page: 1, pages: 2, start_word: 1, end_word: 2, words: 2,
        chapter: 'Two', text: 'bold tail', note: 'nice', created_at: 1_760_000_000, layout_signature: 1, start_offset: 8, end_offset: 17,
      }] }),
    });
    expect(put.status).toBe(200);
    await drainQueue(db, fake.transport, 10);
    const post = fake.calls.find((c) => c.method === 'POST' && c.url === 'https://web.readest.com/api/sync');
    expect(body(post!).notes[0]).toMatchObject({ bookHash: BOOK, text: 'bold tail', note: 'nice', cfi: 'epubcfi(/6/4!/4/4,/2/1:0,/3:5)' });
  });

  it('imports a Readest highlight as a clipping when the reader syncs', async () => {
    const fake = fakeTransport();
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    signIn(fake);
    const { device_code } = await (await app.request('/api/v1/connectors/readest/link/begin', { method: 'POST', headers })).json();
    await app.request('/api/v1/connectors/readest/link/poll', { method: 'POST', headers, body: JSON.stringify({ device_code }) });
    readestLibrary(fake, [readestNote()]);
    await app.request('/syncs/progress', {
      method: 'PUT', headers,
      body: JSON.stringify({ document: DOC, progress: XPOINTER, percentage: 0.5, device_id: 'd1', metadata: { title: 'Piranesi', authors: 'Susanna Clarke' } }),
    });
    // A progress read refreshes the book from Readest, highlights included.
    await app.request(`/syncs/progress/${DOC}`, { headers });
    const clips = await (await app.request(`/api/v1/clippings/${DOC}`, { headers })).json();
    expect(clips.items).toEqual([expect.objectContaining({ text: 'bold tail', note: 'from Readest', spine: 1, start_offset: 8, end_offset: 17 })]);
    // A second read finds it known and adds nothing, and nothing is sent back to Readest.
    await app.request(`/syncs/progress/${DOC}`, { headers });
    expect((await (await app.request(`/api/v1/clippings/${DOC}`, { headers })).json()).items).toHaveLength(1);
    expect(fake.calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/sync'))).toBe(false);

    // Deleted on the reader: Readest still has it, but it stays deleted here.
    const id = clips.items[0].id;
    await app.request(`/api/v1/clippings/${DOC}`, { method: 'PUT', headers, body: JSON.stringify({ items: [{ id, deleted: 1 }] }) });
    await app.request(`/syncs/progress/${DOC}`, { headers });
    expect((await (await app.request(`/api/v1/clippings/${DOC}`, { headers })).json()).items).toEqual([
      expect.objectContaining({ id, deleted: 1 }),
    ]);
  });

  it('revokes the reader key and signs the session out on unlink, and the old ones on a new link', async () => {
    const fake = fakeTransport();
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const link = async () => {
      const { device_code } = await (await app.request('/api/v1/connectors/readest/link/begin', { method: 'POST', headers })).json();
      await app.request('/api/v1/connectors/readest/link/poll', { method: 'POST', headers, body: JSON.stringify({ device_code }) });
    };
    signIn(fake);
    fake.on('/keys/', 200, { revoked: true });
    fake.on('/auth/v1/logout', 204, '');
    const revoked = () => fake.calls.filter((c) => c.method === 'DELETE' || c.url.includes('/auth/v1/logout'));
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    await link();
    expect(revoked()).toHaveLength(0);
    await link(); // a new link replaces the old key and session
    await settle();
    expect(revoked().map((c) => c.url)).toEqual([`${SERVER}/keys/uuid`, 'https://vbsyxfusjjqdxkjqlysc.supabase.co/auth/v1/logout?scope=local']);

    const res = await app.request('/api/v1/connectors/readest', { method: 'DELETE', headers });
    expect(await res.json()).toEqual({ id: 'readest', linked: false });
    await settle();
    expect(revoked()).toHaveLength(4);
    const logout = revoked().at(-1)!;
    expect(logout.headers?.authorization).toBe('Bearer at-1');
    expect(logout.headers?.apikey).toMatch(/^eyJ/);
  });
});

describe('readest revoke', () => {
  it('refreshes an expired session to sign it out, and counts a session already gone as done', async () => {
    const fake = fakeTransport();
    fake.on('/keys/', 200, { revoked: true });
    fake.on('/auth/v1/token', 200, { access_token: 'at-fresh', refresh_token: 'rt-fresh', expires_in: 3600 });
    fake.on('/auth/v1/logout', 204, '');
    await readestConnector.revoke!({ ...CRED, refresh_token: 'rt-expired', expires_at: 1 }, fake.transport);
    expect(fake.calls.find((c) => c.url.includes('/logout'))?.headers?.authorization).toBe('Bearer at-fresh');

    fake.on('/auth/v1/token', 400, { error: 'invalid_grant' });
    await expect(readestConnector.revoke!({ ...CRED, refresh_token: 'rt-revoked', expires_at: 1 }, fake.transport)).resolves.toBeUndefined();
  });

  it('says what Readest could not revoke', async () => {
    const fake = fakeTransport();
    fake.on('/keys/', 500, { error: 'Could not revoke key' });
    fake.on('/auth/v1/logout', 204, '');
    await expect(readestConnector.revoke!(CRED, fake.transport)).rejects.toThrow('reader key (500)');
  });
});
