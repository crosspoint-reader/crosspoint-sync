import { crc32 } from 'node:zlib';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { audiobookshelfConnector } from '../src/connectors/audiobookshelf.js';
import { enqueueAlignment, enqueueMissing, runAlignmentJob } from '../src/connectors/abs-align.js';
import { saveMatch, upsertAccount } from '../src/connectors/store.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { loadAlignment, msAtOffset, saveAlignment } from '../src/models/audio-alignment.js';
import type { HttpTransport } from '../src/connectors/types.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY = 'c'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });

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

const CHAPTER_ONE = 'The quick brown fox jumps over the lazy dog near the river';
const CHAPTER_TWO = 'Later that evening the lighthouse keeper counted every passing ship';

function epub(): Buffer {
  return archive({
    'META-INF/container.xml': '<container><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
    'EPUB/package.opf': '<package><metadata/><manifest><item id="a" href="../Text/ch1.xhtml"/><item id="b" href="../Text/ch2.xhtml"/></manifest><guide/><spine><itemref idref="a"/><itemref idref="b"/></spine></package>',
    'Text/ch1.xhtml': `<html><head/><body><p>${CHAPTER_ONE}</p></body></html>`,
    'Text/ch2.xhtml': `<html><head/><body><p>${CHAPTER_TWO}</p></body></html>`,
  });
}

const ITEM = {
  media: {
    duration: 20,
    audioFiles: [
      { ino: 11, duration: 10, metadata: { path: 'Book/01.mp3' } },
      { ino: 12, duration: 10, metadata: { path: 'Book/02.mp3' } },
    ],
  },
};

function ok(body: unknown) {
  return { status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

it('queues one job per book and skips books that are already aligned', async () => {
  const { app, db } = makeTestApp();
  const { username } = await registerUser(app);
  const { id } = db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number };
  enqueueAlignment(db, id, 'audiobookshelf', 'li_1', DOC);
  enqueueAlignment(db, id, 'audiobookshelf', 'li_1', DOC);
  expect(db.prepare('SELECT COUNT(*) AS n FROM audio_align_jobs').get()).toEqual({ n: 1 });
  // Other connectors never queue, and an aligned book stops queueing.
  enqueueAlignment(db, id, 'jellyfin', 'x', DOC);
  expect(db.prepare('SELECT COUNT(*) AS n FROM audio_align_jobs').get()).toEqual({ n: 1 });
  saveAlignment(db, id, 'audiobookshelf', 'li_1', DOC, {
    durationMs: 1, spineLengths: [1], samples: [[0, 0], [1, 1]], words: 1, coverage: 1, source: 'test',
  });
  db.prepare('DELETE FROM audio_align_jobs').run();
  enqueueAlignment(db, id, 'audiobookshelf', 'li_1', DOC);
  expect(db.prepare('SELECT COUNT(*) AS n FROM audio_align_jobs').get()).toEqual({ n: 0 });
});

it('backfills jobs for books matched before alignments existed', async () => {
  const { app, db } = makeTestApp();
  const { username } = await registerUser(app);
  const { id } = db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number };
  saveMatch(db, id, 'audiobookshelf', DOC, { externalId: 'li_9', externalEdition: '20', confidence: 1 }, 'manual');
  saveMatch(db, id, 'jellyfin', 'film', { externalId: 'jf_1', externalEdition: null, confidence: 1 }, 'manual');
  enqueueMissing(db);
  enqueueMissing(db);
  expect(db.prepare('SELECT user_id, connector_id, external_id, document, status FROM audio_align_jobs').all())
    .toEqual([{ user_id: id, connector_id: 'audiobookshelf', external_id: 'li_9', document: DOC, status: 'pending' }]);
});

it('treats an item without an EPUB as a permanent failure', async () => {
  const http: HttpTransport = async (url) => {
    if (url.endsWith('/ebook')) return { status: 404, json: async () => null, text: async () => '' } as any;
    if (url.includes('/api/items/li_2')) return ok({ media: { duration: 10, audioFiles: [{ ino: 1, duration: 10 }] } });
    throw new Error(`Unexpected request: ${url}`);
  };
  const { app, db } = makeTestApp();
  const { username } = await registerUser(app);
  const { id } = db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number };
  upsertAccount(db, id, 'audiobookshelf', { server: 'abs.test', token: 'k' }, null);
  const job = { user_id: id, connector_id: 'audiobookshelf', external_id: 'li_2', document: DOC, attempts: 0 };
  const error = await runAlignmentJob(db, { provider: 'local', url: 'http://aligner', apiKey: '', model: 'm', maxBytes: 1e9 }, job, http)
    .then(() => null, (e: unknown) => e);
  // The worker marks jobs like this failed instead of retrying for a day.
  expect(error).toMatchObject({ name: 'ConnectorOperationError', retryable: false });
});

it('aligns transcribed audio with the EPUB and seeks the audiobook to the reader word', async () => {
  const patches: any[] = [];
  const http: HttpTransport = async (url, init) => {
    if (url.endsWith('/ebook')) return { status: 200, json: async () => null, text: async () => '', body: new Blob([epub()]).stream() } as any;
    if (url.includes('/api/items/li_1')) return ok(ITEM);
    if (url.includes('/api/me/progress/li_1')) {
      if (init.method === 'PATCH') patches.push(JSON.parse(init.body!));
      return ok({});
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  // The aligner sidecar reports word times relative to each audio file.
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    if (!String(url).includes('/transcribe')) throw new Error(`unexpected fetch ${url}`);
    const body = JSON.parse(String(init?.body)) as { url: string };
    const words = body.url.includes('/11')
      ? CHAPTER_ONE.split(' ').map((word, i) => ({ word, start_ms: i * 400, end_ms: i * 400 + 400 }))
      : CHAPTER_TWO.split(' ').map((word, i) => ({ word, start_ms: i * 400, end_ms: i * 400 + 400 }));
    return new Response(JSON.stringify({ words }), { status: 200 });
  }) as typeof fetch;

  const { app, db } = makeTestApp();
  const { username } = await registerUser(app);
  const { id } = db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number };
  upsertAccount(db, id, 'audiobookshelf', { server: 'abs.test', token: 'k' }, null);
  saveMatch(db, id, 'audiobookshelf', DOC, { externalId: 'li_1', externalEdition: '20', confidence: 1 }, 'manual');

  const job = {
    user_id: id, connector_id: 'audiobookshelf', external_id: 'li_1', document: DOC, attempts: 0,
  };
  await runAlignmentJob(db, { provider: 'local', url: 'http://aligner', apiKey: '', model: 'm', maxBytes: 1e9 }, job, http, fetchImpl);

  const alignment = loadAlignment(db, id, 'audiobookshelf', 'li_1')!;
  expect(alignment.source).toBe('local');
  expect(alignment.spineLengths).toEqual([Array.from(CHAPTER_ONE).length, Array.from(CHAPTER_TWO).length]);
  expect(alignment.durationMs).toBe(20_000);

  // The reader stops 5 words into chapter two: 'Later that evening the lighthouse'.
  const offset = Array.from(CHAPTER_ONE).length + 'Later that evening the lighthouse'.length;
  // Anchors are 4-word n-grams, so a position inside one lands within a spoken word.
  expect(msAtOffset(alignment, offset)).toBeGreaterThanOrEqual(11_200);
  expect(msAtOffset(alignment, offset)).toBeLessThanOrEqual(12_000);

  await audiobookshelfConnector.push(
    { server: 'abs.test', token: 'k' },
    { externalId: 'li_1', externalEdition: '20', confidence: 1 },
    { kind: 'progress', document: DOC, percentage: offset / (Array.from(CHAPTER_ONE).length + Array.from(CHAPTER_TWO).length), progress: '/body/DocFragment[2]/body/p[1]/text()[1].40', timestamp: 1 },
    http,
    { db, userId: id, document: DOC }
  );
  expect(patches.at(-1)).toMatchObject({ duration: 20 });
  expect(patches.at(-1)!.currentTime).toBeGreaterThan(11.2);
  expect(patches.at(-1)!.currentTime).toBeLessThanOrEqual(12.8);
  expect(patches.at(-1)!.ebookLocation).toMatch(/^epubcfi\(/);
});
