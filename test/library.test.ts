import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { migrate, openDatabase } from '../src/db/db.js';
import { documentInfo } from '../src/models/cover.js';
import { parseEntry, readCapped, resetLibraryTemplates, sameBook } from '../src/models/library.js';
import type { HttpTransport } from '../src/connectors/types.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

const LIB = { LIBRARY_OPDS_URL: 'https://lib.test/opds', LIBRARY_OPDS_USERNAME: 'reader', LIBRARY_OPDS_PASSWORD: 'secret' };
const BASIC = `Basic ${Buffer.from('reader:secret').toString('base64')}`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

const atom = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">${body}</feed>`, {
    headers: { 'content-type': 'application/atom+xml' },
  });

// The root feed and search results the way Calibre-Web(-Automated) renders them.
const ROOT = atom(
  '<link rel="search" href="/opds/osd" type="application/opensearchdescription+xml"/>' +
    '<link type="application/atom+xml" rel="search" title="Search" href="/opds/search/{searchTerms}"/>'
);
const entry = (id: number, title: string, author: string, extra = '') =>
  `<entry><title>${title}</title><id>urn:uuid:${id}</id><author><name>${author}</name></author>` +
  '<published>2024-03-01T00:00:00+00:00</published>' +
  `<category scheme="http://www.bisg.org/standards/bisac_subject/index.html" term="Krimi" label="Krimi"/>${extra}` +
  `<link type="image/jpeg" href="/opds/cover/${id}" rel="http://opds-spec.org/image"/></entry>`;
const AUGE = entry(170, '241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner', '<summary>Während eines Camping-Wochenendes …</summary>');
const MEDUSA = entry(171, '240 - Die drei Fragezeichen und der Fluch der Medusa', 'Marco Sonnleitner');

/** A library that answers like Calibre-Web; anything else (Apple, Open Library) is recorded and answered empty. */
function library(results: string, calls: { url: string; auth?: string }[] = []): HttpTransport {
  return async (url, init) => {
    calls.push({ url, auth: init.headers?.authorization });
    if (url === 'https://lib.test/opds') return ROOT.clone();
    if (url.startsWith('https://lib.test/opds/search/')) return atom(results);
    if (url === 'https://lib.test/opds/cover/170') return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    if (url.includes('itunes')) {
      return Response.json({ results: [{ trackName: 'Die drei ??? und das weiße Auge', artistName: 'Marco Sonnleitner', artworkUrl100: 'https://apple.test/100x100bb.jpg' }] });
    }
    return Response.json({ docs: [] });
  };
}

function book(title: string, author: string) {
  const db = openDatabase(':memory:');
  migrate(db);
  db.prepare("INSERT INTO users (id, username, key_hash, created_at) VALUES (1, 'u', 'h', 0)").run();
  db.prepare('INSERT INTO documents (user_id, document, title, author, updated_at) VALUES (1, ?, ?, ?, 0)').run(DOC, title, author);
  return db;
}

beforeEach(() => resetLibraryTemplates());
afterEach(() => vi.unstubAllEnvs());

describe('the user\'s library as the first source', () => {
  it('shows the library\'s cover before the other sources, served by this server', async () => {
    for (const [k, v] of Object.entries(LIB)) vi.stubEnv(k, v);
    const calls: { url: string; auth?: string }[] = [];
    const { app } = makeTestApp({}, { connectorTransport: library(AUGE + MEDUSA, calls) });
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT', headers, body: JSON.stringify({
        document: DOC, progress: '/body/DocFragment[3]', percentage: 0.31, device: 'CrossPoint', device_id: 'x4',
        metadata: { title: '241 - Die drei Fragezeichen und das weiße Auge', authors: 'Marco Sonnleitner' },
      }),
    });

    const { url } = await (await app.request(`/api/v1/documents/${DOC}/cover`, { headers })).json();
    expect(url).toMatch(/^\/api\/v1\/library\/covers\/[0-9a-f]{32}$/);
    // The library was asked with its login; Apple's (also matching) cover wasn't taken.
    expect(calls.filter((c) => c.url.startsWith('https://lib.test')).every((c) => c.auth === BASIC)).toBe(true);
    expect(calls.map((c) => c.url)).toContain('https://lib.test/opds/search/241%20-%20Die%20drei%20Fragezeichen%20und%20das%20wei%C3%9Fe%20Auge');

    // The cover loads without the sync login (an <img> sends none), and only by its address.
    const img = await app.request(url);
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/jpeg');
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG);
    expect((await app.request('/api/v1/library/covers/0123456789abcdef0123456789abcdef')).status).toBe(404);
    expect((await app.request('/api/v1/library/covers/nope')).status).toBe(404);
  });

  it('takes the book\'s details from the library, and drops another source\'s different book', async () => {
    const db = book('007 - Die drei Fragezeichen und der Fluch des Rubins', 'Robert Arthur');
    const rubin = entry(179, '007 - Die drei Fragezeichen und der Fluch des Rubins', 'Robert Arthur', '<summary>Ein Rubin verschwindet.</summary>');
    const base = library(rubin);
    const http: HttpTransport = async (url, init) =>
      url.startsWith('https://meta.test/')
        ? Response.json({ books: [{ id: 't-1', title: 'The Secret of the Haunted Mirror', author: 'Robert Arthur', genres: ['Horror'],
            series: 'The Three Investigators', series_position: 21, description: 'A cursed mirror.', moods: ['dark'] }] })
        : base(url, init);
    await documentInfo(db, 1, DOC, http, { ...LIB, METADATA_API_URL: 'https://meta.test' }, { hardcover: true });
    const row = db.prepare('SELECT * FROM documents WHERE document = ?').get(DOC) as Record<string, unknown>;
    expect(row).toMatchObject({ description: 'Ein Rubin verschwindet.', genres: '["Krimi"]', release_year: 2024, series: null, hc_id: null, moods: null });
    expect(row.hc_checked_at).not.toBeNull();
  });

  it('drops another source\'s book with the same title by another author', async () => {
    const db = book('Foundryside', 'Robert Jackson Bennett');
    const base = library(entry(5, 'Foundryside', 'Robert Jackson Bennett'));
    const http: HttpTransport = async (url, init) =>
      url.startsWith('https://meta.test/')
        ? Response.json({ books: [{ id: 't-3', title: 'Foundryside', author: 'Somebody Else', moods: ['dark'], rating: 2.1, description: 'Not it.' }] })
        : base(url, init);
    await documentInfo(db, 1, DOC, http, { ...LIB, METADATA_API_URL: 'https://meta.test' }, { hardcover: true });
    expect(db.prepare('SELECT hc_id, moods, rating, description FROM documents').get()).toEqual({ hc_id: null, moods: null, rating: null, description: null });
  });

  it('keeps another source\'s details for the same book, under the library\'s', async () => {
    const db = book('Foundryside', 'Robert Jackson Bennett');
    const base = library(entry(5, 'Foundryside', 'Robert Jackson Bennett'));
    const http: HttpTransport = async (url, init) =>
      url.startsWith('https://meta.test/')
        ? Response.json({ books: [{ id: 't-2', title: 'Foundryside: A Novel', author: 'Robert Jackson Bennett', genres: ['Fantasy'],
            series: 'The Founders', series_position: 1, description: 'A heist.', moods: ['adventurous'], page_count: 500 }] })
        : base(url, init);
    await documentInfo(db, 1, DOC, http, { ...LIB, METADATA_API_URL: 'https://meta.test' }, { hardcover: true });
    const row = db.prepare('SELECT * FROM documents WHERE document = ?').get(DOC) as Record<string, unknown>;
    // The library has tags and no description: its genre wins, the rest comes from the other source.
    expect(row).toMatchObject({ genres: '["Krimi"]', description: 'A heist.', series: 'The Founders', series_position: 1, moods: '["Adventurous"]', hc_id: 't-2' });
  });

  it('falls back to the other sources for a book the library doesn\'t have, and remembers the miss', async () => {
    const db = book('Die drei Fragezeichen und das weiße Auge', 'Someone Else');
    const calls: { url: string }[] = [];
    const info = await documentInfo(db, 1, DOC, library(AUGE, calls), LIB);
    // The library's book has another author, so it isn't taken; Apple's fuzzy match still is.
    expect(info.cover).toBe('https://apple.test/600x600bb.jpg');
    const searches = () => calls.filter((c) => c.url.includes('/opds/search/')).length;
    const before = searches();
    db.prepare('UPDATE documents SET cover_checked_at = NULL').run();
    await documentInfo(db, 1, DOC, library(AUGE, calls), LIB);
    expect(searches()).toBe(before); // the library's miss is cached
  });

  it('leaves the book for later when the library can\'t be reached', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    const down: HttpTransport = async (url) => {
      if (url.startsWith('https://lib.test')) throw new Error('ECONNREFUSED');
      return Response.json({ results: [], docs: [] });
    };
    await documentInfo(db, 1, DOC, down, LIB, { hardcover: true });
    const row = db.prepare('SELECT hc_checked_at FROM documents').get() as { hc_checked_at: number | null };
    expect(row.hc_checked_at).toBeNull();
    expect(db.prepare("SELECT count(*) AS n FROM catalog_cache WHERE key LIKE 'library:%'").get()).toEqual({ n: 0 });
    // Back up: the library answers this time.
    await documentInfo(db, 1, DOC, library(AUGE), LIB, { hardcover: true });
    expect((db.prepare('SELECT cover_url FROM documents').get() as { cover_url: string }).cover_url).toMatch(/^\/api\/v1\/library\/covers\//);
  });

  it('finds the search through an OpenSearch description (Calibre content server style)', async () => {
    const db = book('Foundryside', 'Robert Jackson Bennett');
    const calls: string[] = [];
    const http: HttpTransport = async (url) => {
      calls.push(url);
      if (url === 'https://lib.test/opds') return atom('<link rel="search" type="application/opensearchdescription+xml" href="/opds/osd"/>');
      if (url === 'https://lib.test/opds/osd') {
        return new Response('<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/"><Url type="application/atom+xml" template="/opds/search?query={searchTerms}"/></OpenSearchDescription>');
      }
      if (url.startsWith('https://lib.test/opds/search?query=')) {
        return atom('<entry><title>Foundryside</title><id>urn:calibre:5</id><author><name>Robert Jackson Bennett</name></author>' +
          '<content type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">RATING: ★★★★<br/>SERIES: The Founders [1]<br/><p>A heist.</p></div></content></entry>');
      }
      return Response.json({ results: [], docs: [] });
    };
    await documentInfo(db, 1, DOC, http, LIB, { hardcover: true });
    expect(calls).toContain('https://lib.test/opds/search?query=Foundryside');
    expect(db.prepare('SELECT series, series_position FROM documents').get()).toEqual({ series: 'The Founders', series_position: 1 });
  });
});

describe('keeping covers in line with the library', () => {
  const augeDb = () => book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
  const cover = (db: ReturnType<typeof book>) => (db.prepare('SELECT cover_url FROM documents').get() as { cover_url: string | null }).cover_url;

  it('replaces a cover found while the library was down once it answers', async () => {
    const db = book('Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    const down: HttpTransport = async (url, init) => {
      if (url.startsWith('https://lib.test')) throw new Error('ECONNREFUSED');
      return library('')(url, init);
    };
    await documentInfo(db, 1, DOC, down, LIB);
    expect(cover(db)).toBe('https://apple.test/600x600bb.jpg');
    await documentInfo(db, 1, DOC, library(AUGE.replace('241 - ', '')), LIB, { hardcover: true });
    expect(cover(db)).toMatch(/^\/api\/v1\/library\/covers\//);
  });

  it('brings an existing book\'s automatic cover and details in line, but keeps a cover picked by hand', async () => {
    const db = augeDb();
    const now = Math.floor(Date.now() / 1000);
    // Looked up before the library was set up: another source's cover and a wrong book's details.
    db.prepare(
      `UPDATE documents SET cover_url = 'https://meta.test/wrong.jpg', cover_checked_at = ?, hc_checked_at = ?, hc_id = 't-9',
         description = 'Another book.', genres = '["Horror"]'`
    ).run(now, now);
    await documentInfo(db, 1, DOC, library(AUGE), LIB, { hardcover: true });
    expect(cover(db)).toMatch(/^\/api\/v1\/library\/covers\//);
    expect(db.prepare('SELECT description, genres, hc_id FROM documents').get()).toEqual({
      description: 'Während eines Camping-Wochenendes …', genres: '["Krimi"]', hc_id: null,
    });

    const manual = augeDb();
    manual.prepare("UPDATE documents SET cover_url = 'https://mine.test/cover.jpg', cover_manual = 1, cover_checked_at = ?, hc_checked_at = ?").run(now, now);
    await documentInfo(manual, 1, DOC, library(AUGE), LIB, { hardcover: true });
    expect(cover(manual)).toBe('https://mine.test/cover.jpg');
  });

  it('marks a cover picked in the app as manual, and the background enricher leaves it', async () => {
    for (const [k, v] of Object.entries(LIB)) vi.stubEnv(k, v);
    const { app, db } = makeTestApp({}, { connectorTransport: library(AUGE) });
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT', headers, body: JSON.stringify({ document: DOC, progress: 'x', percentage: 0.1, device: 'X4', device_id: 'x4',
        metadata: { title: '241 - Die drei Fragezeichen und das weiße Auge', authors: 'Marco Sonnleitner' } }),
    });
    await app.request(`/api/v1/documents/${DOC}/info`, { method: 'PUT', headers, body: JSON.stringify({ cover_url: 'https://mine.test/cover.jpg' }) });
    await documentInfo(db, 1, DOC, library(AUGE), LIB, { hardcover: true });
    expect(cover(db)).toBe('https://mine.test/cover.jpg');
    // Cleared again: the library's cover comes back.
    await app.request(`/api/v1/documents/${DOC}/info`, { method: 'PUT', headers, body: JSON.stringify({ cover_url: null }) });
    const { url } = await (await app.request(`/api/v1/documents/${DOC}/cover`, { headers })).json();
    expect(url).toMatch(/^\/api\/v1\/library\/covers\//);
  });

  it('shows library covers on a public profile, under the base path', async () => {
    for (const [k, v] of Object.entries(LIB)) vi.stubEnv(k, v);
    const server = makeTestApp({ basePath: '/reading' }, { connectorTransport: library(AUGE) });
    const app = { request: (p: string, init?: RequestInit) => server.app.request(`/reading${p}`, init) } as unknown as typeof server.app;
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT', headers, body: JSON.stringify({ document: DOC, progress: 'x', percentage: 0.3, device: 'X4', device_id: 'x4',
        metadata: { title: '241 - Die drei Fragezeichen und das weiße Auge', authors: 'Marco Sonnleitner' } }),
    });
    const { url } = await (await app.request(`/api/v1/documents/${DOC}/cover`, { headers })).json();
    const { slug } = await (await app.request('/api/v1/profile', { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) })).json();
    const page = await (await app.request(`/u/${slug}`)).text();
    expect(page).toContain(`<img src="/reading${url}"`);
    expect((await app.request(url)).status).toBe(200);
  });
});

describe('library lookups over time', () => {
  it('tries a cover again after a failed download', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    const base = library(AUGE);
    const broken: HttpTransport = async (url, init) => (url.endsWith('/opds/cover/170') ? new Response('busy', { status: 503 }) : base(url, init));
    await documentInfo(db, 1, DOC, broken, LIB, { hardcover: true });
    expect(db.prepare('SELECT cover_url, library_match FROM documents').get()).toEqual({ cover_url: null, library_match: 0 });
    db.prepare('UPDATE documents SET library_checked_at = library_checked_at - 86400').run(); // a day later
    await documentInfo(db, 1, DOC, base, LIB, { hardcover: true });
    expect((db.prepare('SELECT cover_url FROM documents').get() as { cover_url: string }).cover_url).toMatch(/^\/api\/v1\/library\/covers\//);
  });

  it('doesn\'t reuse another catalog\'s answers', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    const calls: { url: string }[] = [];
    await documentInfo(db, 1, DOC, library('', calls), LIB, { hardcover: true }); // a miss in the first catalog
    db.prepare('UPDATE documents SET library_checked_at = NULL').run();
    const other = { ...LIB, LIBRARY_OPDS_USERNAME: 'someone-else' };
    await documentInfo(db, 1, DOC, library(AUGE, calls), other, { hardcover: true });
    expect(calls.filter((c) => c.url.includes('/opds/search/')).length).toBeGreaterThan(1);
    expect((db.prepare('SELECT library_match FROM documents').get() as { library_match: number }).library_match).toBe(1);
  });
});

describe('cover downloads', () => {
  const big = new Uint8Array(1024);
  it('stops at the size limit, whether the server says so or not', async () => {
    expect(await readCapped(new Response(big, { headers: { 'content-length': '1024' } }), 100)).toBeNull();
    let pulled = 0;
    const endless = new ReadableStream<Uint8Array>({ pull: (c) => { pulled++; c.enqueue(big); } });
    expect(await readCapped({ status: 200, body: endless, text: async () => '', json: async () => null }, 4096)).toBeNull();
    expect(pulled).toBeLessThan(10);
    expect(await readCapped(new Response(big), 4096)).toHaveLength(1024);
  });
});

describe('library matching', () => {
  const parse = (xml: string) => parseEntry(new DOMParser().parseFromString(xml, 'text/xml').documentElement!, 'https://lib.test/opds/search/x')!;

  it('reads an entry, with an absolute cover link', () => {
    const b = parse(AUGE.replace('<entry>', '<entry xmlns="http://www.w3.org/2005/Atom">'));
    expect(b).toMatchObject({ title: '241 - Die drei Fragezeichen und das weiße Auge', author: 'Marco Sonnleitner', genres: ['Krimi'],
      release_year: 2024, cover: 'https://lib.test/opds/cover/170' });
  });

  it('sends the library\'s login to the library only', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    const calls: { url: string; auth?: string }[] = [];
    const base = library(AUGE.replace('href="/opds/cover/170"', 'href="https://cdn.test/170.jpg"'), calls);
    const http: HttpTransport = async (url, init) =>
      url === 'https://cdn.test/170.jpg' ? (calls.push({ url, auth: init.headers?.authorization }), new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })) : base(url, init);
    await documentInfo(db, 1, DOC, http, LIB);
    expect(calls.find((c) => c.url === 'https://cdn.test/170.jpg')).toEqual({ url: 'https://cdn.test/170.jpg', auth: undefined });
    expect((db.prepare('SELECT cover_url FROM documents').get() as { cover_url: string }).cover_url).toMatch(/^\/api\/v1\/library\/covers\//);
  });

  it('matches the same title and author only', () => {
    const lib = { id: '1', title: 'Leviathan Wakes', author: 'James S. A. Corey', description: null, genres: [], series: null, series_position: null, release_year: null, cover: null };
    expect(sameBook('Leviathan Wakes', 'James S.A. Corey', lib)).toBe(true);
    expect(sameBook('leviathan wakes', 'Corey, James S. A.', lib)).toBe(true);
    expect(sameBook('Leviathan Wakes: The Expanse 1', 'James S. A. Corey', lib)).toBe(true);
    expect(sameBook('Leviathan Wakes', 'Someone Else', lib)).toBe(false);
    expect(sameBook('Caliban\'s War', 'James S. A. Corey', lib)).toBe(false);
    expect(sameBook('Leviathan Wakes', 'Daniel Abraham & Ty Franck', { ...lib, author: 'Daniel Abraham & Ty Franck' })).toBe(true);
    // Without an author on either side, a title alone isn't enough.
    expect(sameBook('Leviathan Wakes', 'James S. A. Corey', { ...lib, author: null })).toBe(false);
    expect(sameBook('Leviathan Wakes', '', { ...lib, author: null })).toBe(false);
    // A subtitle may differ on one side only: two books of one series aren't the same book.
    const series = { ...lib, title: 'The Expanse: Caliban\'s War' };
    expect(sameBook('The Expanse: Leviathan Wakes', 'James S. A. Corey', series)).toBe(false);
    expect(sameBook('The Expanse', 'James S. A. Corey', series)).toBe(true);
  });
});
