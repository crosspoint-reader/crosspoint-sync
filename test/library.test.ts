import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DOMParser } from '@xmldom/xmldom';
import { migrate, openDatabase } from '../src/db/db.js';
import { documentInfo } from '../src/models/cover.js';
import { parseEntry, readCapped, resetLibraryState, sameBook } from '../src/models/library.js';
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

beforeEach(() => resetLibraryState());
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

  it('checks another source\'s answer against the reader\'s title too', async () => {
    const db = book('Saga: Book One', 'Jane Doe');
    const base = library(entry(6, 'Saga', 'Jane Doe')); // the library holds it without the subtitle
    const http: HttpTransport = async (url, init) =>
      url.startsWith('https://meta.test/')
        ? Response.json({ books: [{ id: 't-6', title: 'Saga: Book Two', author: 'Jane Doe', moods: ['dark'], rating: 4.5 }] })
        : base(url, init);
    await documentInfo(db, 1, DOC, http, { ...LIB, METADATA_API_URL: 'https://meta.test' }, { hardcover: true });
    expect(db.prepare('SELECT hc_id, moods, rating FROM documents').get()).toEqual({ hc_id: null, moods: null, rating: null });
  });

  it('drops another source\'s other volume of a series by the same author', async () => {
    const db = book('Saga: Book One', 'Jane Doe');
    const base = library(entry(6, 'Saga: Book One', 'Jane Doe'));
    const http: HttpTransport = async (url, init) =>
      url.startsWith('https://meta.test/')
        ? Response.json({ books: [{ id: 't-5', title: 'Saga: Book Two', author: 'Jane Doe', moods: ['dark'], rating: 4.5 }] })
        : base(url, init);
    await documentInfo(db, 1, DOC, http, { ...LIB, METADATA_API_URL: 'https://meta.test' }, { hardcover: true });
    expect(db.prepare('SELECT hc_id, moods, rating FROM documents').get()).toEqual({ hc_id: null, moods: null, rating: null });
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
    expect(before).toBeGreaterThan(0);
    // Due again for the book (as after a day), but the library's miss is still cached: no new search.
    db.prepare('UPDATE documents SET cover_checked_at = NULL, library_checked_at = NULL').run();
    await documentInfo(db, 1, DOC, library(AUGE, calls), LIB, { hardcover: true });
    expect(searches()).toBe(before);
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
    // Back up a while later (past the pause after a failure): the library answers this time.
    resetLibraryState();
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
    resetLibraryState(); // a while later, past the pause after a failure
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

  it('asks the library again after the title or author is edited', async () => {
    for (const [k, v] of Object.entries(LIB)) vi.stubEnv(k, v);
    const { app, db } = makeTestApp({}, { connectorTransport: library(AUGE + MEDUSA) });
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT', headers, body: JSON.stringify({ document: DOC, progress: 'x', percentage: 0.1, device: 'X4', device_id: 'x4',
        metadata: { title: '241 - Die drei Fragezeichen und das weisse Auge', authors: 'Marco Sonnleitner' } }), // a typo: no match
    });
    await documentInfo(db, 1, DOC, library(AUGE + MEDUSA), LIB, { hardcover: true });
    expect(db.prepare('SELECT library_match FROM documents').get()).toEqual({ library_match: 0 });
    await app.request(`/api/v1/documents/${DOC}/info`, { method: 'PUT', headers, body: JSON.stringify({ title: '241 - Die drei Fragezeichen und das weiße Auge' }) });
    await documentInfo(db, 1, DOC, library(AUGE + MEDUSA), LIB, { hardcover: true });
    expect(db.prepare('SELECT library_match FROM documents').get()).toEqual({ library_match: 1 });
    expect((db.prepare('SELECT cover_url FROM documents').get() as { cover_url: string }).cover_url).toMatch(/^\/api\/v1\/library\/covers\//);
    // Corrected to a book the library doesn't have: its cover goes with the old identity.
    await app.request(`/api/v1/documents/${DOC}/info`, { method: 'PUT', headers, body: JSON.stringify({ author: 'Somebody Else' }) });
    expect(db.prepare('SELECT cover_url FROM documents').get()).toEqual({ cover_url: null });
  });

  it('doesn\'t overwrite a cover picked while the library was being asked', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    const base = library(AUGE);
    const http: HttpTransport = async (url, init) => {
      if (url.endsWith('/opds/cover/170')) {
        // The user picks a cover in the app meanwhile.
        db.prepare("UPDATE documents SET cover_url = 'https://mine.test/cover.jpg', cover_manual = 1").run();
      }
      return base(url, init);
    };
    const info = await documentInfo(db, 1, DOC, http, LIB, { hardcover: true });
    expect(info.cover).toBe('https://mine.test/cover.jpg');
    expect(db.prepare('SELECT cover_url, cover_manual FROM documents').get()).toEqual({ cover_url: 'https://mine.test/cover.jpg', cover_manual: 1 });
  });

  it('keeps a cover picked by hand when two copies of a book are merged', async () => {
    const { mergeDocuments } = await import('../src/models/merge.js');
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    const alias = 'f'.repeat(32);
    db.prepare("UPDATE documents SET cover_url = '/api/v1/library/covers/0123456789abcdef0123456789abcdef', cover_manual = 0").run();
    db.prepare("INSERT INTO documents (user_id, document, title, cover_url, cover_manual, updated_at) VALUES (1, ?, 'x', 'https://mine.test/cover.jpg', 1, 0)").run(alias);
    mergeDocuments(db, 1, alias, DOC, Math.floor(Date.now() / 1000));
    expect(db.prepare('SELECT cover_url, cover_manual FROM documents WHERE document = ?').get(DOC)).toEqual({ cover_url: 'https://mine.test/cover.jpg', cover_manual: 1 });
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
    // Meanwhile the other sources' cover is shown.
    expect(db.prepare('SELECT cover_url, library_match FROM documents').get()).toEqual({ cover_url: 'https://apple.test/600x600bb.jpg', library_match: 0 });
    db.prepare('UPDATE documents SET library_checked_at = library_checked_at - 86400').run(); // a day later
    await documentInfo(db, 1, DOC, base, LIB, { hardcover: true });
    expect((db.prepare('SELECT cover_url FROM documents').get() as { cover_url: string }).cover_url).toMatch(/^\/api\/v1\/library\/covers\//);
  });

  it('brings a matched book up to date a week later, e.g. from another catalog', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    await documentInfo(db, 1, DOC, library(AUGE), LIB, { hardcover: true });
    const first = (db.prepare('SELECT cover_url FROM documents').get() as { cover_url: string }).cover_url;
    const other = { ...LIB, LIBRARY_OPDS_URL: 'https://lib2.test/opds' };
    const lib2: HttpTransport = async (url, init) =>
      library(AUGE.replace('Während eines Camping-Wochenendes …', 'Aus dem zweiten Katalog.'))(url.replace('lib2.test', 'lib.test'), init);
    await documentInfo(db, 1, DOC, lib2, other, { hardcover: true });
    expect(db.prepare('SELECT cover_url, description FROM documents').get()).toEqual({ cover_url: first, description: 'Während eines Camping-Wochenendes …' });
    db.prepare('UPDATE documents SET library_checked_at = library_checked_at - 7 * 86400').run();
    await documentInfo(db, 1, DOC, lib2, other, { hardcover: true });
    expect(db.prepare('SELECT description FROM documents').get()).toEqual({ description: 'Aus dem zweiten Katalog.' });
  });

  it('gives a cover changed in the library a new address, and keeps covers per catalog', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    let picture = JPEG;
    let fetched = 0;
    const base = library(AUGE);
    const http: HttpTransport = async (url, init) => {
      if (url !== 'https://lib.test/opds/cover/170') return base(url, init);
      fetched++;
      return new Response(picture, { headers: { 'content-type': 'image/jpeg' } });
    };
    const cover = () => (db.prepare('SELECT cover_url FROM documents').get() as { cover_url: string }).cover_url;
    await documentInfo(db, 1, DOC, http, LIB, { hardcover: true });
    const first = cover();
    // A week later the library has a new picture at the same link.
    picture = new Uint8Array([0xff, 0xd8, 9, 9, 9, 0xff, 0xd9]);
    db.prepare('UPDATE documents SET library_checked_at = library_checked_at - 7 * 86400').run();
    await documentInfo(db, 1, DOC, http, LIB, { hardcover: true });
    expect(cover()).not.toBe(first);
    const { storeLibraryCover } = await import('../src/models/library.js');
    // The same link under another login is fetched again, not taken from the first catalog.
    const before = fetched;
    await storeLibraryCover(db, http, 'https://lib.test/opds/cover/170', { ...LIB, LIBRARY_OPDS_USERNAME: 'other' });
    expect(fetched).toBe(before + 1);
    // An unchanged picture keeps its address.
    expect(await storeLibraryCover(db, http, 'https://lib.test/opds/cover/170', LIB, { refresh: true })).toBe(cover());
  });

  it('leaves a library that failed alone for a while, and keeps the book due until it answers', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    await documentInfo(db, 1, DOC, library(AUGE), LIB, { hardcover: true });
    db.prepare("UPDATE catalog_cache SET checked_at = checked_at - 8 * 86400 WHERE key LIKE 'library:%'").run(); // the answer expired
    let asked = 0;
    const down: HttpTransport = async (url, init) => {
      if (url.startsWith('https://lib.test')) {
        asked++;
        throw new Error('timeout');
      }
      return library('')(url, init);
    };
    const { libraryBook } = await import('../src/models/library.js');
    expect(await libraryBook(db, down, '241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner', LIB)).toBe('later');
    expect(await libraryBook(db, down, '241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner', LIB)).toBe('later');
    expect(asked).toBe(1);
    // Another book without a stored answer isn't waited on either.
    expect(await libraryBook(db, down, 'Something else', 'Someone', LIB)).toBe('later');
    expect(asked).toBe(1);
    // A week-old match whose refresh failed stays due: it is applied once the library answers.
    db.prepare('UPDATE documents SET library_checked_at = library_checked_at - 7 * 86400').run();
    const due = (db.prepare('SELECT library_checked_at FROM documents').get() as { library_checked_at: number }).library_checked_at;
    await documentInfo(db, 1, DOC, down, LIB, { hardcover: true });
    expect(db.prepare('SELECT library_checked_at FROM documents').get()).toEqual({ library_checked_at: due });
    resetLibraryState(); // five minutes later
    await documentInfo(db, 1, DOC, library(AUGE), LIB, { hardcover: true });
    expect((db.prepare('SELECT library_checked_at FROM documents').get() as { library_checked_at: number }).library_checked_at).toBeGreaterThan(due);
  });

  it('drops the library\'s old cover when the library no longer has one', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    await documentInfo(db, 1, DOC, library(AUGE), LIB, { hardcover: true });
    expect((db.prepare('SELECT cover_url FROM documents').get() as { cover_url: string }).cover_url).toMatch(/^\/api\/v1\/library\/covers\//);
    // A week later the entry has no cover any more: the other sources' cover takes its place.
    db.prepare('UPDATE documents SET library_checked_at = library_checked_at - 7 * 86400').run();
    db.prepare("UPDATE catalog_cache SET checked_at = checked_at - 8 * 86400 WHERE key LIKE 'library:%'").run();
    const info = await documentInfo(db, 1, DOC, library(AUGE.replace(/<link type="image\/jpeg"[^>]*\/>/, '')), LIB, { hardcover: true });
    expect(info.cover).toBe('https://apple.test/600x600bb.jpg');
  });

  it('retries a cover whose weekly download failed, showing the old one meanwhile', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    await documentInfo(db, 1, DOC, library(AUGE), LIB, { hardcover: true });
    const shown = (db.prepare('SELECT cover_url FROM documents').get() as { cover_url: string }).cover_url;
    const base = library(AUGE);
    const busy: HttpTransport = async (url, init) => (url.endsWith('/opds/cover/170') ? new Response('busy', { status: 503 }) : base(url, init));
    db.prepare('UPDATE documents SET library_checked_at = library_checked_at - 7 * 86400').run();
    await documentInfo(db, 1, DOC, busy, LIB, { hardcover: true });
    // Still the old cover, and marked to be tried again after a day rather than a week.
    expect(db.prepare('SELECT cover_url, library_match FROM documents').get()).toEqual({ cover_url: shown, library_match: 0 });
  });

  it('stores the library\'s details while the other sources are busy', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    const base = library(AUGE);
    const busy: HttpTransport = async (url, init) => (url.startsWith('https://meta.test/') ? new Response('', { status: 503 }) : base(url, init));
    await documentInfo(db, 1, DOC, busy, { ...LIB, METADATA_API_URL: 'https://meta.test' }, { hardcover: true });
    expect(db.prepare('SELECT description, genres, release_year, hc_checked_at FROM documents').get()).toEqual({
      description: 'Während eines Camping-Wochenendes …', genres: '["Krimi"]', release_year: 2024, hc_checked_at: null,
    });
  });

  it('keeps "Saga: A Novel" and "Saga A Novel" apart in the cache', async () => {
    const { libraryBook } = await import('../src/models/library.js');
    const db = book('x', 'y');
    const saga = library(entry(8, 'Saga', 'Jane Doe'));
    expect(await libraryBook(db, saga, 'Saga A Novel', 'Jane Doe', LIB)).toBeNull();
    expect(await libraryBook(db, saga, 'Saga: A Novel', 'Jane Doe', LIB)).toMatchObject({ title: 'Saga' });
  });

  it('finds the catalog\'s search again after it moved', async () => {
    const { libraryBook } = await import('../src/models/library.js');
    const db = book('x', 'y');
    let moved = false;
    const http: HttpTransport = async (url) => {
      if (url === 'https://lib.test/opds') return atom(`<link type="application/atom+xml" rel="search" href="/${moved ? 'new' : 'old'}/{searchTerms}"/>`);
      if (url.startsWith('https://lib.test/new/')) return atom(entry(9, 'Foundryside', 'Robert Jackson Bennett'));
      if (url.startsWith('https://lib.test/old/') && !moved) return atom('');
      return new Response('gone', { status: 404 });
    };
    expect(await libraryBook(db, http, 'Dune', 'Frank Herbert', LIB)).toBeNull();
    moved = true;
    expect(await libraryBook(db, http, 'Foundryside', 'Robert Jackson Bennett', LIB)).toBe('later');
    // The failure itself forgets the old search address; only the pause after it has to pass.
    vi.useFakeTimers({ now: Date.now() + 10 * 60 * 1000 });
    try {
      expect(await libraryBook(db, http, 'Foundryside', 'Robert Jackson Bennett', LIB)).toMatchObject({ title: 'Foundryside' });
    } finally {
      vi.useRealTimers();
    }
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

describe('review round six', () => {
  const cover = (db: ReturnType<typeof book>) => (db.prepare('SELECT cover_url FROM documents').get() as { cover_url: string | null }).cover_url;
  const CDN_AUGE = AUGE.replace('href="/opds/cover/170"', 'href="https://cdn.test/170.jpg"');

  it('clears a library cover on another host when the library drops it, or the title is edited', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    await documentInfo(db, 1, DOC, library(CDN_AUGE), LIB, { hardcover: true });
    expect(db.prepare('SELECT cover_url, cover_library FROM documents').get()).toEqual({ cover_url: 'https://cdn.test/170.jpg', cover_library: 1 });
    // A week later the entry has no cover: the other sources' cover takes its place.
    db.prepare('UPDATE documents SET library_checked_at = library_checked_at - 7 * 86400').run();
    db.prepare("UPDATE catalog_cache SET checked_at = checked_at - 8 * 86400 WHERE key LIKE 'library:%'").run();
    const info = await documentInfo(db, 1, DOC, library(AUGE.replace(/<link type="image\/jpeg"[^>]*\/>/, '')), LIB, { hardcover: true });
    expect(info.cover).toBe('https://apple.test/600x600bb.jpg');
    expect(db.prepare('SELECT cover_library FROM documents').get()).toEqual({ cover_library: 0 });

    for (const [k, v] of Object.entries(LIB)) vi.stubEnv(k, v);
    const { app, db: db2 } = makeTestApp({}, { connectorTransport: library(CDN_AUGE) });
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT', headers, body: JSON.stringify({ document: DOC, progress: 'x', percentage: 0.1, device: 'X4', device_id: 'x4',
        metadata: { title: '241 - Die drei Fragezeichen und das weiße Auge', authors: 'Marco Sonnleitner' } }),
    });
    await documentInfo(db2, 1, DOC, library(CDN_AUGE), LIB, { hardcover: true });
    expect(cover(db2)).toBe('https://cdn.test/170.jpg');
    await app.request(`/api/v1/documents/${DOC}/info`, { method: 'PUT', headers, body: JSON.stringify({ author: 'Somebody Else' }) });
    expect(db2.prepare('SELECT cover_url, cover_library FROM documents').get()).toEqual({ cover_url: null, cover_library: 0 });
  });

  it('discards a lookup that finishes after the book was renamed', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    const base = library(AUGE);
    const http: HttpTransport = async (url, init) => {
      if (url.endsWith('/opds/cover/170')) {
        // The user corrects the book while the cover downloads (what PUT /info does).
        db.prepare("UPDATE documents SET title = 'Another Book', meta_manual = 1, library_checked_at = NULL, library_match = 0, hc_checked_at = NULL").run();
      }
      return base(url, init);
    };
    await documentInfo(db, 1, DOC, http, LIB, { hardcover: true });
    expect(db.prepare('SELECT title, cover_url, library_match, library_checked_at, description FROM documents').get()).toEqual({
      title: 'Another Book', cover_url: null, library_match: 0, library_checked_at: null, description: null,
    });
  });

  it('checks another source\'s author against the reader\'s too', async () => {
    const db = book('Home', 'Alice Smith');
    const base = library(entry(10, 'Home', 'Alice Smith &amp; Bob Jones'));
    const http: HttpTransport = async (url, init) =>
      url.startsWith('https://meta.test/')
        ? Response.json({ books: [{ id: 't-7', title: 'Home', author: 'Bob Jones', rating: 3.1, moods: ['dark'] }] })
        : base(url, init);
    await documentInfo(db, 1, DOC, http, { ...LIB, METADATA_API_URL: 'https://meta.test' }, { hardcover: true });
    expect(db.prepare('SELECT hc_id, rating, moods FROM documents').get()).toEqual({ hc_id: null, rating: null, moods: null });
  });

  it('drops another source\'s series id with its series when the library\'s comes in', async () => {
    const db = book('Foundryside', 'Robert Jackson Bennett');
    db.prepare("UPDATE documents SET series = 'Old', hc_series_id = 10").run();
    const base = library(entry(11, 'Foundryside', 'Robert Jackson Bennett').replace('<published>', '<content type="text">SERIES: The Founders [1]</content><published>'));
    const busy: HttpTransport = async (url, init) => (url.startsWith('https://meta.test/') ? new Response('', { status: 503 }) : base(url, init));
    await documentInfo(db, 1, DOC, busy, { ...LIB, METADATA_API_URL: 'https://meta.test' }, { hardcover: true });
    expect(db.prepare('SELECT series, series_position, hc_series_id FROM documents').get()).toEqual({ series: 'The Founders', series_position: 1, hc_series_id: null });
  });

  it('keeps "Alice & Bob" and "Alice Bob" apart in the cache', async () => {
    const { libraryBook } = await import('../src/models/library.js');
    const db = book('x', 'y');
    const home = library(entry(12, 'Home', 'Alice'));
    expect(await libraryBook(db, home, 'Home', 'Alice & Bob', LIB)).toMatchObject({ title: 'Home' });
    expect(await libraryBook(db, home, 'Home', 'Alice Bob', LIB)).toBeNull();
  });

  it('downloads a cover again on the retry after a failed weekly download', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    await documentInfo(db, 1, DOC, library(AUGE), LIB, { hardcover: true });
    const busy: HttpTransport = async (url, init) => (url.endsWith('/opds/cover/170') ? new Response('busy', { status: 503 }) : library(AUGE)(url, init));
    db.prepare('UPDATE documents SET library_checked_at = library_checked_at - 7 * 86400').run();
    await documentInfo(db, 1, DOC, busy, LIB, { hardcover: true });
    expect(db.prepare('SELECT library_match FROM documents').get()).toEqual({ library_match: 0 });
    // A day later: the cover link is requested again.
    let fetched = 0;
    const base = library(AUGE);
    const counting: HttpTransport = async (url, init) => (url.endsWith('/opds/cover/170') && fetched++, base(url, init));
    db.prepare('UPDATE documents SET library_checked_at = library_checked_at - 86400').run();
    await documentInfo(db, 1, DOC, counting, LIB, { hardcover: true });
    expect(fetched).toBe(1);
    expect(db.prepare('SELECT library_match FROM documents').get()).toEqual({ library_match: 1 });
  });

  it('keeps the library\'s covers and details out of the catalog export', async () => {
    const { app, db } = makeTestApp({ catalogExportToken: 'tok' });
    await registerUser(app);
    db.prepare(`INSERT INTO documents (user_id, document, title, author, isbn, description, genres, cover_url, cover_library, library_fields, updated_at)
      VALUES (1, 'lib', 'Dune', 'Frank Herbert', '9780441013593', 'My own notes.', '["Mine"]', '/api/v1/library/covers/0123456789abcdef0123456789abcdef', 1, ',description,genres,', 0)`).run();
    const body = await (await app.request('/api/catalog/books', { headers: { authorization: 'Bearer tok' } })).json();
    expect(body.books[0]).toMatchObject({ title: 'Dune', description: null, genres: [], cover_url: null });
  });

  it('carries the library flag with the cover when copies are merged', async () => {
    const { mergeDocuments } = await import('../src/models/merge.js');
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    const alias = 'e'.repeat(32);
    db.prepare("INSERT INTO documents (user_id, document, title, cover_url, cover_library, updated_at) VALUES (1, ?, 'x', 'https://cdn.test/170.jpg', 1, 0)").run(alias);
    mergeDocuments(db, 1, alias, DOC, Math.floor(Date.now() / 1000));
    expect(db.prepare('SELECT cover_url, cover_library FROM documents WHERE document = ?').get(DOC)).toEqual({ cover_url: 'https://cdn.test/170.jpg', cover_library: 1 });
  });
});

describe('own review', () => {
  it('asks the other source again on a weekly refresh when its cached answer is gone', async () => {
    const now = Math.floor(Date.now() / 1000);
    const stored = (db: ReturnType<typeof book>) =>
      db.prepare("UPDATE documents SET hc_id = '42', rating = 4.2, moods = '[\"Tense\"]', hc_checked_at = ?").run(now);
    const answering = (title: string, author: string): HttpTransport => {
      const base = library(entry(5, 'Foundryside', 'Robert Jackson Bennett'));
      return async (url, init) =>
        url.startsWith('https://meta.test/') ? Response.json({ books: [{ id: '42', title, author, rating: 4.2, moods: ['Tense'] }] }) : base(url, init);
    };
    const env = { ...LIB, METADATA_API_URL: 'https://meta.test' };
    // It answers with the same book: its details stay, under the library's.
    const same = book('Foundryside', 'Robert Jackson Bennett');
    stored(same);
    await documentInfo(same, 1, DOC, answering('Foundryside', 'Robert Jackson Bennett'), env, { hardcover: true });
    expect(same.prepare('SELECT hc_id, rating, moods, genres FROM documents').get()).toEqual({ hc_id: '42', rating: 4.2, moods: '["Tense"]', genres: '["Krimi"]' });
    // It answers with another book: its details go.
    const other = book('Foundryside', 'Robert Jackson Bennett');
    stored(other);
    await documentInfo(other, 1, DOC, answering('The Secret of the Haunted Mirror', 'Robert Jackson Bennett'), env, { hardcover: true });
    expect(other.prepare('SELECT hc_id, rating, moods, genres FROM documents').get()).toEqual({ hc_id: null, rating: null, moods: null, genres: '["Krimi"]' });
  });

  it('drops stored covers no book shows any more, once a week old', async () => {
    const { pruneLibraryCovers } = await import('../src/models/library.js');
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    await documentInfo(db, 1, DOC, library(AUGE), LIB, { hardcover: true });
    const old = Math.floor(Date.now() / 1000) - 8 * 86400;
    db.prepare("INSERT INTO library_covers (id, source, digest, content_type, data, fetched_at) VALUES ('ffffffffffffffffffffffffffffffff', 'x old', 'd', 'image/jpeg', x'00', ?)").run(old);
    db.prepare('UPDATE library_covers SET fetched_at = ?').run(old); // the shown one is old too, but in use
    pruneLibraryCovers(db);
    const shown = (db.prepare('SELECT cover_url FROM documents').get() as { cover_url: string }).cover_url;
    expect(db.prepare('SELECT id FROM library_covers').all()).toEqual([{ id: shown.split('/').pop() }]);
  });

  it('treats a library cover this server doesn\'t hold as none (an account restored elsewhere)', async () => {
    const db = book('Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    db.prepare("UPDATE documents SET cover_url = '/api/v1/library/covers/0123456789abcdef0123456789abcdef', cover_library = 1, cover_checked_at = ?").run(Math.floor(Date.now() / 1000));
    const info = await documentInfo(db, 1, DOC, library(''), {});
    expect(info.cover).toBe('https://apple.test/600x600bb.jpg'); // no library configured here: the other sources fill in
  });

  it('answers with what is stored after a title edit during the lookup', async () => {
    const db = book('Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    const base = library('');
    const http: HttpTransport = async (url, init) => {
      if (url.includes('openlibrary')) {
        db.prepare("UPDATE documents SET title = 'Another Book', meta_manual = 1").run();
        return Response.json({ docs: [{ title: 'Die drei Fragezeichen und das weiße Auge', author_name: ['Marco Sonnleitner'], number_of_pages_median: 160 }] });
      }
      return base(url, init);
    };
    const info = await documentInfo(db, 1, DOC, http, {});
    expect(info).toEqual({ cover: null, pages: null });
  });
});

describe('catalog export and cleanup', () => {
  it('keeps library details out of the export after a later library miss', async () => {
    for (const [k, v] of Object.entries(LIB)) vi.stubEnv(k, v);
    const { app, db } = makeTestApp({ catalogExportToken: 'tok' });
    await registerUser(app);
    db.prepare("INSERT INTO documents (user_id, document, title, author, isbn, updated_at) VALUES (1, ?, 'Foundryside', 'Robert Jackson Bennett', '9780593123456', 0)").run(DOC);
    await documentInfo(db, 1, DOC, library(entry(5, 'Foundryside', 'Robert Jackson Bennett', '<summary>My own notes.</summary>')), LIB, { hardcover: true });
    expect(db.prepare('SELECT description, library_fields FROM documents').get()).toEqual({ description: 'My own notes.', library_fields: ',description,genres,release_year,' });
    // A day later the library has no such book any more (a miss): the details stay, and stay out of the export.
    db.prepare('UPDATE documents SET library_checked_at = library_checked_at - 8 * 86400').run();
    db.prepare("UPDATE catalog_cache SET checked_at = checked_at - 8 * 86400 WHERE key LIKE 'library:%'").run();
    await documentInfo(db, 1, DOC, library(''), LIB, { hardcover: true });
    expect(db.prepare('SELECT library_match FROM documents').get()).toEqual({ library_match: 0 });
    const body = await (await app.request('/api/catalog/books', { headers: { authorization: 'Bearer tok' } })).json();
    expect(body.books[0]).toMatchObject({ title: 'Foundryside', description: null, genres: [] });
  });

  it('leaves out only the fields that came from the library', async () => {
    for (const [k, v] of Object.entries(LIB)) vi.stubEnv(k, v);
    const { app, db } = makeTestApp({ catalogExportToken: 'tok' });
    await registerUser(app);
    db.prepare("INSERT INTO documents (user_id, document, title, author, isbn, updated_at) VALUES (1, ?, 'Foundryside', 'Robert Jackson Bennett', '9780593123456', 0)").run(DOC);
    // The library has a description only; the metadata API (same book) adds the series.
    const base = library('<entry><title>Foundryside</title><id>urn:5</id><author><name>Robert Jackson Bennett</name></author><summary>My own notes.</summary></entry>');
    const http: HttpTransport = async (url, init) =>
      url.startsWith('https://meta.test/')
        ? Response.json({ books: [{ id: 't-2', title: 'Foundryside', author: 'Robert Jackson Bennett', description: 'A heist.', series: 'The Founders', series_position: 1 }] })
        : base(url, init);
    await documentInfo(db, 1, DOC, http, { ...LIB, METADATA_API_URL: 'https://meta.test' }, { hardcover: true });
    expect(db.prepare('SELECT description, series, library_fields FROM documents').get()).toEqual({ description: 'My own notes.', series: 'The Founders', library_fields: ',description,' });
    const body = await (await app.request('/api/catalog/books', { headers: { authorization: 'Bearer tok' } })).json();
    expect(body.books[0]).toMatchObject({ title: 'Foundryside', description: null, series: 'The Founders', series_position: 1 });
  });

  it('doesn\'t overwrite a cover another lookup stored meanwhile', async () => {
    const db = book('Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    const libraryCoverUrl = '/api/v1/library/covers/0123456789abcdef0123456789abcdef';
    const base = library('');
    const http: HttpTransport = async (url, init) => {
      // The background enricher stores the library's cover while this lookup asks Apple.
      if (url.includes('itunes')) db.prepare('UPDATE documents SET cover_url = ?, cover_library = 1').run(libraryCoverUrl);
      return base(url, init);
    };
    const info = await documentInfo(db, 1, DOC, http, {});
    expect(info.cover).toBe(libraryCoverUrl);
    expect(db.prepare('SELECT cover_url, cover_library FROM documents').get()).toEqual({ cover_url: libraryCoverUrl, cover_library: 1 });
  });

  it('takes the library mark from the copy whose value a merge keeps', async () => {
    const { mergeDocuments } = await import('../src/models/merge.js');
    const db = book('Foundryside', 'Robert Jackson Bennett');
    const alias = 'd'.repeat(32);
    // Kept copy: another source's description, no series. Alias: the library's description and series.
    db.prepare("UPDATE documents SET description = 'A heist.', library_fields = NULL").run();
    db.prepare(`INSERT INTO documents (user_id, document, title, description, series, series_position, library_fields, updated_at)
      VALUES (1, ?, 'x', 'My own notes.', 'The Founders', 1, ',description,series,', 0)`).run(alias);
    mergeDocuments(db, 1, alias, DOC, Math.floor(Date.now() / 1000));
    expect(db.prepare('SELECT description, series, library_fields FROM documents WHERE document = ?').get(DOC)).toEqual({
      description: 'A heist.', series: 'The Founders', library_fields: ',series,',
    });
  });

  it('cleans up covers nothing shows any more without a new download', async () => {
    const { enrichSoon } = await import('../src/models/cover.js');
    const db = book('x', 'y');
    db.prepare("UPDATE documents SET hc_checked_at = 1, library_checked_at = ?, library_match = 1").run(Math.floor(Date.now() / 1000));
    const old = Math.floor(Date.now() / 1000) - 8 * 86400;
    db.prepare("INSERT INTO library_covers (id, source, digest, content_type, data, fetched_at) VALUES ('ffffffffffffffffffffffffffffffff', 'x a', 'd', 'image/jpeg', x'00', ?)").run(old);
    enrichSoon(db, 1, library(''), LIB);
    expect(db.prepare('SELECT count(*) AS n FROM library_covers').get()).toEqual({ n: 0 });
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

  it('requests only the library\'s own address', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    const calls: { url: string; auth?: string }[] = [];
    const base = library(AUGE.replace('href="/opds/cover/170"', 'href="https://cdn.test/170.jpg"'), calls);
    const http: HttpTransport = async (url, init) =>
      url === 'https://cdn.test/170.jpg' ? (calls.push({ url, auth: init.headers?.authorization }), new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })) : base(url, init);
    await documentInfo(db, 1, DOC, http, LIB);
    // A cover on another host isn't requested by the server at all: the app loads it, like any other source's.
    expect(calls.find((c) => c.url === 'https://cdn.test/170.jpg')).toBeUndefined();
    expect((db.prepare('SELECT cover_url FROM documents').get() as { cover_url: string }).cover_url).toBe('https://cdn.test/170.jpg');
  });

  it('follows no redirect and no search on another host', async () => {
    const db = book('241 - Die drei Fragezeichen und das weiße Auge', 'Marco Sonnleitner');
    const calls: { url: string; auth?: string }[] = [];
    const base = library(AUGE, calls);
    let redirect: string | undefined;
    const redirecting: HttpTransport = async (url, init) => {
      if (url !== 'https://lib.test/opds/cover/170') return base(url, init);
      redirect = init.redirect;
      return new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/admin' } });
    };
    await documentInfo(db, 1, DOC, redirecting, LIB);
    expect(redirect).toBe('manual');
    expect(calls.some((c) => c.url.startsWith('http://10.'))).toBe(false);
    // Not the library's (redirected) cover: the other sources' one.
    expect((db.prepare('SELECT cover_url FROM documents').get() as { cover_url: string | null }).cover_url).toBe('https://apple.test/600x600bb.jpg');

    resetLibraryState();
    const elsewhere: HttpTransport = async (url, init) => {
      calls.push({ url });
      if (url === 'https://lib.test/opds') return atom('<link type="application/atom+xml" rel="search" href="http://10.0.0.1/search/{searchTerms}"/>');
      return Response.json({ results: [], docs: [] });
    };
    const { libraryBook } = await import('../src/models/library.js');
    expect(await libraryBook(book('Foundryside', 'Robert Jackson Bennett'), elsewhere, 'Foundryside', 'Robert Jackson Bennett', LIB)).toBe('later');
    expect(calls.some((c) => c.url.startsWith('http://10.'))).toBe(false);
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
