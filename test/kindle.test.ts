import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { kindleConnector, parseExternalId } from '../src/connectors/kindle.js';
import { ConnectorOperationError } from '../src/connectors/types.js';
import type { HttpTransport } from '../src/connectors/types.js';

function testCred(library?: { asin: string; title: string; author?: string; type?: string }[]) {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    adp_token: 'test-adp-token',
    private_key: Buffer.from(privateKey.export({ format: 'der', type: 'pkcs8' })).toString('base64'),
    // Random serial per credential: the connector's EBOK cache is keyed by it.
    device_serial: crypto.randomBytes(20).toString('hex'),
    device_name: 'CrossPoint Sync',
    ...(library ? { library } : {}),
  };
}

/** Uncompressed MOBI stub: palmDocTextLength trusts the declared length for type 1. */
function mobiStub(declaredTextLength: number): Buffer {
  const headerLen = 78;
  const firstOffset = headerLen + 2 * 8;
  const palmDocHeader = Buffer.alloc(16);
  palmDocHeader.writeUInt16BE(1, 0); // no compression
  palmDocHeader.writeUInt32BE(declaredTextLength, 4);
  palmDocHeader.writeUInt16BE(1, 8);
  palmDocHeader.writeUInt16BE(4096, 10);
  const text = Buffer.from('x');
  const out = Buffer.alloc(firstOffset + palmDocHeader.length + text.length);
  out.writeUInt16BE(2, 76);
  out.writeUInt32BE(firstOffset, headerLen);
  out.writeUInt32BE(firstOffset + palmDocHeader.length, headerLen + 8);
  palmDocHeader.copy(out, firstOffset);
  text.copy(out, firstOffset + palmDocHeader.length);
  return out;
}

function streamOf(buf: Buffer): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start: (c) => { c.enqueue(buf); c.close(); } });
}

interface FionaFakeOptions {
  metadataStatus?: number;
  metadataXml?: string;
  sidecarStatus?: number;
  lastReadXml?: string;
  rulerLength?: number;
  contentStatus?: number;
}

function fionaFake(opts: FionaFakeOptions = {}) {
  const calls: string[] = [];
  const guid = 'TESTGUID';
  const sidecar = Buffer.concat([Buffer.from(guid, 'ascii'), Buffer.alloc(32 - guid.length), Buffer.from('bin')]);
  const lastReadXml =
    opts.lastReadXml ??
    '<book><last_read annotation_time_utc="2999-01-01T00:00:00Z" pos="25000" ' +
    'source_device="Kindle for Android Phone" method="FRL" version="0"/></book>';
  const transport: HttpTransport = async (url) => {
    calls.push(url);
    if (url.includes('syncMetaData')) {
      const status = opts.metadataStatus ?? 200;
      return { status, body: null, text: async () => opts.metadataXml ?? '<response/>', json: async () => ({}) };
    }
    if (url.includes('/sidecar')) {
      const status = opts.sidecarStatus ?? 200;
      return { status, body: status === 200 ? streamOf(sidecar) : null, text: async () => '', json: async () => ({}) };
    }
    if (url.includes('getAnnotations')) {
      return { status: 200, body: null, text: async () => lastReadXml, json: async () => ({}) };
    }
    if (url.includes('FSDownloadContent')) {
      const status = opts.contentStatus ?? 200;
      const mobi = mobiStub(opts.rulerLength ?? 100000);
      return { status, body: status === 200 ? streamOf(mobi) : null, text: async () => '', json: async () => ({}) };
    }
    return { status: 404, body: null, text: async () => '<error/>', json: async () => ({}) };
  };
  return { transport, calls };
}

describe('parseExternalId', () => {
  it('parses typed and bare ids', () => {
    expect(parseExternalId('PDOC:B012345678')).toEqual({ type: 'PDOC', asin: 'B012345678' });
    expect(parseExternalId('EBOK:B012345678')).toEqual({ type: 'EBOK', asin: 'B012345678' });
    expect(parseExternalId('B012345678')).toEqual({ type: 'PDOC', asin: 'B012345678' });
  });
});

describe('kindle connector', () => {
  it('validates a working device credential', async () => {
    const fake = fionaFake();
    const res = await kindleConnector.validate(testCred(), fake.transport);
    expect(res).toEqual({ ok: true, accountLabel: 'CrossPoint Sync' });
    expect(fake.calls[0]).toContain('todo-ta-g7g.amazon.com/FionaTodoListProxy/syncMetaData');
  });

  it('rejects when Amazon rejects the credential', async () => {
    const fake = fionaFake({ metadataStatus: 401 });
    const res = await kindleConnector.validate(testCred(), fake.transport);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/deregistered|rejected/);
  });

  it('rejects a malformed credential without a network call', async () => {
    const fake = fionaFake();
    const res = await kindleConnector.validate({ adp_token: 'x' }, fake.transport);
    expect(res.ok).toBe(false);
    expect(fake.calls).toHaveLength(0);
  });

  it('matches against the uploaded library snapshot', async () => {
    const cred = testCred([
      { asin: 'B012345678', title: 'The Left Hand of Darkness', author: 'Ursula K. Le Guin' },
      { asin: 'B0ABCDEFGH', title: 'A Wizard of Earthsea', author: 'Ursula K. Le Guin' },
    ]);
    const m = await kindleConnector.match(
      cred,
      { document: DOC, title: 'The Left Hand of Darkness', author: 'Ursula K. Le Guin', filename: null },
      fionaFake().transport
    );
    expect(m?.externalId).toBe('PDOC:B012345678');
    expect(m?.confidence).toBeGreaterThan(0.6);
  });

  it('cannot match without a library snapshot', async () => {
    const m = await kindleConnector.match(
      testCred(),
      { document: DOC, title: 'Anything', author: null, filename: null },
      fionaFake().transport
    );
    expect(m).toBeNull();
  });

  it('serves the library as the manual-match picker pool, filterable by search', async () => {
    const cred = testCred([
      { asin: 'B012345678', title: 'The Dispossessed', author: 'Ursula K. Le Guin' },
      { asin: 'B0ABCDEFGH', title: 'Dune', author: 'Frank Herbert' },
    ]);
    const all = await kindleConnector.listCurrentlyReading!(cred, fionaFake().transport);
    expect(all.map((b) => b.externalId).sort()).toEqual(['PDOC:B012345678', 'PDOC:B0ABCDEFGH']);
    const found = await kindleConnector.search!(cred, 'dune', fionaFake().transport);
    expect(found.map((b) => b.externalId)).toEqual(['PDOC:B0ABCDEFGH']);
  });

  it('matches purchased books from the server-side syncMetaData list (cached)', async () => {
    const metadataXml =
      '<response><add_update_list>' +
      '<meta_data><ASIN>B0EBOK0001</ASIN><title>The Tombs of Atuan</title><authors><author>Ursula K. Le Guin</author></authors></meta_data>' +
      '</add_update_list></response>';
    const fake = fionaFake({ metadataXml });
    const cred = testCred();
    const doc = { document: DOC, title: 'The Tombs of Atuan', author: 'Ursula K. Le Guin', filename: null };
    const m = await kindleConnector.match(cred, doc, fake.transport);
    expect(m?.externalId).toBe('EBOK:B0EBOK0001');
    // The EBOK list is cached: further candidate pools don't re-hit syncMetaData.
    const callsAfterMatch = fake.calls.filter((u) => u.includes('syncMetaData')).length;
    await kindleConnector.search!(cred, 'atuan', fake.transport);
    expect(fake.calls.filter((u) => u.includes('syncMetaData')).length).toBe(callsAfterMatch);
  });

  it('refreshes the EBOK list once on a miss (new purchase), then caches again', async () => {
    const book =
      '<meta_data><ASIN>B0NEWPURCH</ASIN><title>Brand New Book</title><authors><author>New Author</author></authors></meta_data>';
    let libraryXml = '<response><add_update_list></add_update_list></response>';
    let metaCalls = 0;
    const transport: HttpTransport = async (url) => {
      if (url.includes('syncMetaData')) {
        metaCalls++;
        return { status: 200, body: null, text: async () => libraryXml, json: async () => ({}) };
      }
      return { status: 404, body: null, text: async () => '', json: async () => ({}) };
    };
    const cred = testCred();
    const doc = { document: DOC, title: 'Brand New Book', author: 'New Author', filename: null };
    // Cold cache: one fetch, miss, and NO pointless immediate second fetch.
    expect(await kindleConnector.match(cred, doc, transport)).toBeNull();
    expect(metaCalls).toBe(1);
    // The user buys the book; the next match attempt refreshes once and finds it.
    libraryXml = `<response><add_update_list>${book}</add_update_list></response>`;
    const m = await kindleConnector.match(cred, doc, transport);
    expect(m?.externalId).toBe('EBOK:B0NEWPURCH');
    expect(metaCalls).toBe(2);
    // Cached again: subsequent matches don't re-fetch.
    await kindleConnector.match(cred, doc, transport);
    expect(metaCalls).toBe(2);
  });

  it('pulls a furthest-read position as a canonical percentage change', async () => {
    const fake = fionaFake({ rulerLength: 100000 }); // pos 25000 -> 0.25
    const change = await kindleConnector.pullProgress!(
      testCred(),
      { externalId: 'PDOC:B0PULL0001', externalEdition: '100000', confidence: 1 },
      fake.transport,
      0
    );
    expect(change?.percentage).toBeCloseTo(0.25, 5);
    expect(change?.externalId).toBe('PDOC:B0PULL0001');
    // Cached ruler: no content download needed.
    expect(fake.calls.some((u) => u.includes('FSDownloadContent'))).toBe(false);
  });

  it('downloads the converted book to size the position space when no ruler is cached', async () => {
    const fake = fionaFake({ rulerLength: 50000 }); // pos 25000 -> 0.5
    const change = await kindleConnector.pullProgress!(
      testCred(),
      { externalId: 'PDOC:B0RULER001', confidence: 1 },
      fake.transport,
      0
    );
    expect(change?.percentage).toBeCloseTo(0.5, 5);
    expect(fake.calls.some((u) => u.includes('FSDownloadContent'))).toBe(true);
  });

  it('returns null when the stored progress is already newer than the annotation', async () => {
    const fake = fionaFake();
    const change = await kindleConnector.pullProgress!(
      testCred(),
      { externalId: 'PDOC:B0STALE001', externalEdition: '100000', confidence: 1 },
      fake.transport,
      Date.parse('2999-01-01T00:00:00Z') // same instant as the annotation
    );
    expect(change).toBeNull();
  });

  it('flags undated annotations furthest-read-only and lets the merge rule order them', async () => {
    const undated = '<book><last_read pos="25000" source_device="Kindle" method="FRL" version="0"/></book>';
    const fake = fionaFake({ lastReadXml: undated });
    const match = { externalId: 'PDOC:B0NODATE01', externalEdition: '100000', confidence: 1 };
    // Undated annotations are always returned now — the fan-in applier applies
    // them only when they ADVANCE the canonical position (FRL can't regress),
    // which is strictly stronger than the old sinceMs gate.
    const change = await kindleConnector.pullProgress!(testCred(), match, fake.transport, 1000);
    expect(change?.percentage).toBeCloseTo(0.25, 5);
    expect(change?.furthestReadOnly).toBe(true);
  });

  it('returns null for a doc that never synced (no sidecar)', async () => {
    const fake = fionaFake({ sidecarStatus: 404 });
    const change = await kindleConnector.pullProgress!(
      testCred(),
      { externalId: 'PDOC:B0NOSIDE01', confidence: 1 },
      fake.transport,
      0
    );
    expect(change).toBeNull();
  });

  it('refuses to force-fit a KF8-space position instead of corrupting progress', async () => {
    const fake = fionaFake({
      rulerLength: 100000,
      lastReadXml:
        '<book><last_read annotation_time_utc="2999-01-01T00:00:00Z" pos="343999" ' +
        'source_device="Justin\u2019s Kindle Paperwhite" method="FRL" version="0"/></book>',
    });
    await expect(
      kindleConnector.pullProgress!(
        testCred(),
        { externalId: 'PDOC:B0KF8GUARD', externalEdition: '100000', confidence: 1 },
        fake.transport,
        0
      )
    ).rejects.toThrow(/KF8 position space/);
  });

  it('negative-caches ruler failures: first pull logs, later pulls skip without re-downloading', async () => {
    const fake = fionaFake({ contentStatus: 403 });
    const cred = testCred();
    const m = { externalId: 'PDOC:B0NOLOADER', confidence: 1 };
    const first = await kindleConnector.pullProgress!(cred, m, fake.transport, 0).catch((e) => e);
    expect(first).toBeInstanceOf(Error);
    expect((first as Error).message).toMatch(/cannot download the converted book/);
    const downloads = fake.calls.filter((u) => u.includes('FSDownloadContent')).length;
    expect(downloads).toBe(1);
    // Second pull: known-undownloadable, skips quietly with no new download.
    const second = await kindleConnector.pullProgress!(cred, m, fake.transport, 0);
    expect(second).toBeNull();
    expect(fake.calls.filter((u) => u.includes('FSDownloadContent')).length).toBe(1);
  });

  it('accepts undated annotations as furthest-read-only changes', async () => {
    const fake = fionaFake({
      rulerLength: 100000,
      lastReadXml: '<book><last_read pos="25000" method="FRL" version="0"/></book>',
    });
    const change = await kindleConnector.pullProgress!(
      testCred(),
      { externalId: 'PDOC:B0UNDATED1', externalEdition: '100000', confidence: 1 },
      fake.transport,
      Date.now() // undated values defer to the FRL merge rule downstream
    );
    expect(change?.percentage).toBeCloseTo(0.25, 5);
    expect(change?.furthestReadOnly).toBe(true);
    expect(Date.now() - (change?.updatedAtMs ?? 0)).toBeLessThan(10_000);
  });

  it('flags needsReauth when the device credential is dead', async () => {
    const fake = fionaFake({ sidecarStatus: 401 });
    const err = await kindleConnector
      .pullProgress!(testCred(), { externalId: 'PDOC:B0DEADCRED', confidence: 1 }, fake.transport, 0)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConnectorOperationError);
    expect(err.needsReauth).toBe(true);
  });
});

describe('kindle connector API + on-demand refresh', () => {
  const KEY = { TOKEN_ENC_KEY: 'a'.repeat(64) };
  beforeEach(() => {
    Object.assign(process.env, KEY);
    resetEncryptionKeyCache();
  });
  afterEach(() => {
    delete process.env.TOKEN_ENC_KEY;
    resetEncryptionKeyCache();
  });

  it('links via PUT, manual-matches, and refreshes progress from Amazon on GET', async () => {
    const fake = fionaFake({ rulerLength: 100000 }); // annotation pos 25000 -> 0.25
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);

    const link = await app.request('/api/v1/connectors/kindle', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: testCred() }),
    });
    expect(link.status).toBe(200);

    // Manual match (the resolveEdition hook downloads the ruler, served by the fake).
    const match = await app.request(`/api/v1/connectors/kindle/matches/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ external_id: 'PDOC:B0REFRESH1' }),
    });
    expect(match.status).toBe(200);

    // A device reports an older, lower position.
    const put = await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: '/body/1/0', percentage: 0.1, device: 'CrossPoint', device_id: 'cp1' }),
    });
    expect(put.status).toBe(200);

    // Asking for progress triggers the on-demand Amazon pull: the Kindle's newer
    // furthest-read (0.25) is recorded as the kindle "device" row alongside the
    // physical device's older 0.1 (same-second writes share the kosync tie-break,
    // so assert on the per-device view).
    const res = await app.request(`/api/v1/progress/${DOC}`, { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    const kindleRow = (body.devices ?? []).find((r: { device_id: string }) => r.device_id === 'kindle');
    expect(kindleRow?.percentage).toBeCloseTo(0.25, 5);
    expect(fake.calls.some((u) => u.includes('getAnnotations'))).toBe(true);
  });

  it('auto-matches a newly synced book on first progress GET — no dashboard action', async () => {
    const fake = fionaFake({ rulerLength: 100000 }); // annotation pos 25000 -> 0.25
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/kindle', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        credential: testCred([{ asin: 'B0AUTO0001', title: 'The Left Hand of Darkness', author: 'Ursula K. Le Guin' }]),
      }),
    });
    // The reader syncs the book with metadata; NO manual match is made.
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        document: DOC, progress: '/body/1/0', percentage: 0.1, device: 'CrossPoint', device_id: 'cp1',
        metadata: { title: 'The Left Hand of Darkness', authors: 'Ursula K. Le Guin' },
      }),
    });
    const res = await app.request(`/api/v1/progress/${DOC}`, { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    const kindleRow = (body.devices ?? []).find((r: { device_id: string }) => r.device_id === 'kindle');
    expect(kindleRow?.percentage).toBeCloseTo(0.25, 5);
    const row = (await (await app.request('/api/v1/connectors/kindle/matches', { headers })).json())
      .matches.find((m: { document: string }) => m.document === DOC);
    expect(row).toMatchObject({ external_id: 'PDOC:B0AUTO0001', source: 'auto' });
  });

  it('retries a stale not-found match after the library is re-uploaded', async () => {
    const fake = fionaFake({ rulerLength: 100000 });
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const cred = testCred();
    await app.request('/api/v1/connectors/kindle', {
      method: 'PUT', headers, body: JSON.stringify({ credential: cred }),
    });
    await app.request('/syncs/progress', {
      method: 'PUT', headers,
      body: JSON.stringify({
        document: DOC, progress: '/body/1/0', percentage: 0.1, device: 'CP', device_id: 'cp1',
        metadata: { title: 'The Left Hand of Darkness', authors: 'Ursula K. Le Guin' },
      }),
    });
    let body = await (await app.request(`/api/v1/progress/${DOC}`, { headers })).json();
    expect((body.devices ?? []).some((r: { device_id: string }) => r.device_id === 'kindle')).toBe(false);
    // Age the 'none' row so the re-uploaded credential (new library) triggers a retry.
    db.prepare("UPDATE connector_matches SET updated_at = updated_at - 100 WHERE connector_id = 'kindle'").run();
    await app.request('/api/v1/connectors/kindle', {
      method: 'PUT', headers,
      body: JSON.stringify({
        credential: { ...cred, library: [{ asin: 'B0AUTO0001', title: 'The Left Hand of Darkness', author: 'Ursula K. Le Guin' }] },
      }),
    });
    body = await (await app.request(`/api/v1/progress/${DOC}`, { headers })).json();
    const kindleRow = (body.devices ?? []).find((r: { device_id: string }) => r.device_id === 'kindle');
    expect(kindleRow?.percentage).toBeCloseTo(0.25, 5);
  });

  it('never retries a manual no-match override', async () => {
    const fake = fionaFake({ rulerLength: 100000 });
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/kindle', {
      method: 'PUT', headers,
      body: JSON.stringify({
        credential: testCred([{ asin: 'B0AUTO0001', title: 'The Left Hand of Darkness', author: 'Ursula K. Le Guin' }]),
      }),
    });
    await app.request(`/api/v1/connectors/kindle/matches/${DOC}`, {
      method: 'PUT', headers, body: JSON.stringify({ external_id: null }),
    });
    await app.request('/syncs/progress', {
      method: 'PUT', headers,
      body: JSON.stringify({
        document: DOC, progress: '/body/1/0', percentage: 0.1, device: 'CP', device_id: 'cp1',
        metadata: { title: 'The Left Hand of Darkness', authors: 'Ursula K. Le Guin' },
      }),
    });
    const body = await (await app.request(`/api/v1/progress/${DOC}`, { headers })).json();
    expect((body.devices ?? []).some((r: { device_id: string }) => r.device_id === 'kindle')).toBe(false);
    expect(fake.calls.some((u) => u.includes('getAnnotations'))).toBe(false);
  });

  it('refreshes the library on demand via POST library/refresh', async () => {
    const metadataXml =
      '<response><add_update_list>' +
      '<meta_data><ASIN>B0EBOK0001</ASIN><title>Book One</title></meta_data>' +
      '<meta_data><ASIN>B0EBOK0002</ASIN><title>Book Two</title></meta_data>' +
      '</add_update_list></response>';
    const fake = fionaFake({ metadataXml });
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/kindle', {
      method: 'PUT', headers, body: JSON.stringify({ credential: testCred() }),
    });
    const res = await app.request('/api/v1/connectors/kindle/library/refresh', { method: 'POST', headers });
    expect(res.status).toBe(200);
    expect((await res.json()).count).toBe(2);
    // A connector without a refreshable library says so.
    const nope = await app.request('/api/v1/connectors/hardcover/library/refresh', { method: 'POST', headers });
    expect(nope.status).toBe(400);
  });

  it('looks up an ASIN in the EBOK list, the PDOC snapshot, and by ownership probe', async () => {
    const metadataXml =
      '<response><add_update_list>' +
      '<meta_data><ASIN>B0EBOK0001</ASIN><title>Book One</title><authors><author>A</author></authors></meta_data>' +
      '</add_update_list></response>';
    const fake = fionaFake({ metadataXml });
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/kindle', {
      method: 'PUT', headers,
      body: JSON.stringify({
        credential: testCred([{ asin: 'B0PDOC0001', title: 'My Doc', author: 'Me' }]),
      }),
    });
    const lookupAsin = (asin: string) =>
      app.request('/api/v1/connectors/kindle/lookup', {
        method: 'POST', headers, body: JSON.stringify({ external_id: asin }),
      }).then((r) => r.json());

    // In the server-side EBOK list.
    expect(await lookupAsin('B0EBOK0001')).toMatchObject({
      found: true, book: { externalId: 'EBOK:B0EBOK0001', title: 'Book One' },
    });
    // In the extension-uploaded PDOC snapshot.
    expect(await lookupAsin('B0PDOC0001')).toMatchObject({
      found: true, book: { externalId: 'PDOC:B0PDOC0001', title: 'My Doc' },
    });
    // In neither list — but the account owns it (content downloads): probe proves
    // ownership and returns the position-space ruler as the edition.
    const probed = await lookupAsin('B0UNLISTED');
    expect(probed).toMatchObject({ found: true, book: { externalId: 'PDOC:B0UNLISTED', edition: '100000' } });
    expect(fake.calls.some((u) => u.includes('FSDownloadContent') && u.includes('B0UNLISTED'))).toBe(true);
  });

  it('returns found:false for an ASIN the account does not own', async () => {
    const fake = fionaFake({ contentStatus: 404 });
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/kindle', {
      method: 'PUT', headers, body: JSON.stringify({ credential: testCred() }),
    });
    const res = await app.request('/api/v1/connectors/kindle/lookup', {
      method: 'POST', headers, body: JSON.stringify({ external_id: 'B0NOPE0000' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).found).toBe(false);
    // Unsupported connector.
    const nope = await app.request('/api/v1/connectors/hardcover/lookup', {
      method: 'POST', headers, body: JSON.stringify({ external_id: '42' }),
    });
    expect(nope.status).toBe(400);
  });

  it('applies an undated Kindle position only when it advances the canonical one', async () => {
    const fake = fionaFake({
      rulerLength: 100000,
      lastReadXml: '<book><last_read pos="25000" method="FRL" version="0"/></book>', // 0.25, undated
    });
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/kindle', {
      method: 'PUT', headers, body: JSON.stringify({ credential: testCred() }),
    });
    await app.request(`/api/v1/connectors/kindle/matches/${DOC}`, {
      method: 'PUT', headers, body: JSON.stringify({ external_id: 'PDOC:B0FRULE001' }),
    });
    // Device is AHEAD (0.5 > 0.25): the undated FRL must not regress it.
    await app.request('/syncs/progress', {
      method: 'PUT', headers,
      body: JSON.stringify({ document: DOC, progress: '/body/1/0', percentage: 0.5, device: 'CP', device_id: 'cp1' }),
    });
    let body = await (await app.request(`/api/v1/progress/${DOC}`, { headers })).json();
    expect((body.devices ?? []).some((r: { device_id: string }) => r.device_id === 'kindle')).toBe(false);

    // Kindle gets AHEAD (0.25 > 0.1): now the undated FRL applies.
    const DOC2 = 'b2c3d4e5f60718293a4b5c6d7e8f90a1';
    await app.request(`/api/v1/connectors/kindle/matches/${DOC2}`, {
      method: 'PUT', headers, body: JSON.stringify({ external_id: 'PDOC:B0FRULE002' }),
    });
    await app.request('/syncs/progress', {
      method: 'PUT', headers,
      body: JSON.stringify({ document: DOC2, progress: '/body/1/0', percentage: 0.1, device: 'CP', device_id: 'cp1' }),
    });
    body = await (await app.request(`/api/v1/progress/${DOC2}`, { headers })).json();
    const kindleRow = (body.devices ?? []).find((r: { device_id: string }) => r.device_id === 'kindle');
    expect(kindleRow?.percentage).toBeCloseTo(0.25, 5);
  });

  it('serves stored progress when Amazon is sick (best-effort, never fails the GET)', async () => {
    const transport: HttpTransport = async (url) => {
      if (url.includes('syncMetaData')) {
        return { status: 200, body: null, text: async () => '<response/>', json: async () => ({}) };
      }
      throw new Error('network down');
    };
    const { app } = makeTestApp({}, { connectorTransport: transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/kindle', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: testCred() }),
    });
    await app.request(`/api/v1/connectors/kindle/matches/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ external_id: 'PDOC:B012345678' }),
    });
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: '/body/1/0', percentage: 0.1, device: 'CrossPoint', device_id: 'cp1' }),
    });
    const res = await app.request(`/syncs/progress/${DOC}`, { headers });
    expect(res.status).toBe(200);
    expect((await res.json()).percentage).toBeCloseTo(0.1, 5);
  });
});
