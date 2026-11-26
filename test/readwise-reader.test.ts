import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpTransport } from '../src/connectors/types.js';
import { readwiseReaderConnector } from '../src/connectors/readwise-reader.js';

// Minimal fake transport (same shape as the one in connectors-more.test.ts):
// records calls, and returns the last-registered handler whose match string
// appears in the URL or body.
function fakeTransport() {
  const calls: { url: string; method: string; body?: string }[] = [];
  const handlers: { match: string; status: number; body: unknown }[] = [
    { match: 'id=', status: 200, body: { results: [{ id: '01bbb', category: 'epub', reading_progress: 0.1, updated_at: '1970-01-01T00:00:00Z' }] } },
  ];
  const t: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    const h = [...handlers].reverse().find((x) => url.includes(x.match) || (init.body ?? '').includes(x.match));
    const status = h?.status ?? 200;
    const body = h?.body ?? {};
    return { status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body };
  };
  return { transport: t, calls, on: (m: string, s: number, b: unknown) => handlers.push({ match: m, status: s, body: b }) };
}

const CRED = { token: 'rw_token' };
let tokenId = 0;
beforeEach(() => { CRED.token = `rw_test_${++tokenId}`; });

describe('readwise-reader connector', () => {
  it('validates via GET /api/v3/list/', async () => {
    const fake = fakeTransport();
    fake.on('/api/v3/list/', 200, { results: [] });
    const v = await readwiseReaderConnector.validate(CRED, fake.transport);
    expect(v.ok).toBe(true);
    expect(fake.calls[0].url).toContain('/api/v3/list/');
    expect(fake.calls[0].url).toContain('withHtmlContent=false');
  });

  it('reports an invalid token on 401', async () => {
    const fake = fakeTransport();
    fake.on('/api/v3/list/', 401, {});
    const v = await readwiseReaderConnector.validate(CRED, fake.transport);
    expect(v.ok).toBe(false);
  });

  it('matches a document by title against the non-archived pool', async () => {
    const fake = fakeTransport();
    fake.on('/list/', 200, {
      results: [
        { id: '01aaa', title: 'Some Other Article', author: 'Nobody' },
        { id: '01bbb', title: 'Stop Eating the Oreos', author: 'A. Writer' },
      ],
    });
    const m = await readwiseReaderConnector.match!(
      CRED,
      { document: 'hash', title: 'Stop Eating the Oreos', author: 'A. Writer', filename: null },
      fake.transport
    );
    expect(m?.externalId).toBe('01bbb');
    // Sends the Token auth header, never a query token.
    expect(fake.calls[0].url).not.toContain('rw_token');
  });

  it('returns no match when nothing crosses the confidence threshold', async () => {
    const fake = fakeTransport();
    fake.on('/list/', 200, { results: [{ id: '01ccc', title: 'Completely Unrelated', author: 'X' }] });
    const m = await readwiseReaderConnector.match!(
      CRED,
      { document: 'hash', title: 'Stop Eating the Oreos', author: 'A. Writer', filename: null },
      fake.transport
    );
    expect(m).toBeNull();
  });

  it('archives on finish via PATCH /bulk_update/', async () => {
    const fake = fakeTransport();
    fake.on('/bulk_update/', 200, {});
    const r = await readwiseReaderConnector.push(
      CRED,
      { externalId: '01bbb', confidence: 1 },
      { kind: 'finished', document: 'hash', percentage: 1, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    const call = fake.calls.find((c) => c.url.includes('/bulk_update/'));
    expect(call?.method).toBe('PATCH');
    expect(JSON.parse(call!.body!)).toEqual({ updates: [{ id: '01bbb', reading_progress: 1, location: 'archive', seen: true }] });
  });

  it('sends in-progress percentages without archiving', async () => {
    const fake = fakeTransport();
    const r = await readwiseReaderConnector.push(
      CRED,
      { externalId: '01bbb', confidence: 1 },
      { kind: 'progress', document: 'hash', percentage: 0.5, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    expect(JSON.parse(fake.calls.find(c => c.method === 'PATCH')!.body!)).toEqual({
      updates: [{ id: '01bbb', reading_progress: 0.5 }],
    });
  });

  it('adds a clipping as a highlight on the matched document via POST /save/', async () => {
    const fake = fakeTransport();
    fake.on('/save/', 201, { id: '01hhh' });
    const r = await readwiseReaderConnector.push(
      CRED,
      { externalId: '01bbb', confidence: 1 },
      { kind: 'highlight', document: 'hash', timestamp: 1, highlight: { text: 'So we beat on', note: 'last line' } },
      fake.transport
    );
    expect(r.ok).toBe(true);
    expect(fake.calls).toHaveLength(1);
    const call = fake.calls[0];
    expect(call.url).toMatch(/\/api\/v3\/save\/$/);
    expect(call.method).toBe('POST');
    expect(JSON.parse(call.body!)).toEqual({ parent_id: '01bbb', content: 'So we beat on', saved_using: 'crosspoint', notes: 'last line' });
  });

  it('omits notes for a clipping without one', async () => {
    const fake = fakeTransport();
    fake.on('/save/', 200, { id: '01hhh' });
    const r = await readwiseReaderConnector.push(CRED, { externalId: '01bbb', confidence: 1 },
      { kind: 'highlight', document: 'hash', timestamp: 1, highlight: { text: 'Whenever you feel', note: null } }, fake.transport);
    expect(r.ok).toBe(true);
    expect(JSON.parse(fake.calls[0].body!)).toEqual({ parent_id: '01bbb', content: 'Whenever you feel', saved_using: 'crosspoint' });
  });

  it.each([
    [400, false, false],
    [401, false, true],
    [429, true, false],
    [503, true, false],
  ])('maps a %s highlight response', async (status, retryable, needsReauth) => {
    const fake = fakeTransport();
    fake.on('/save/', status, { content: ['not found in the document'] });
    const r = await readwiseReaderConnector.push(CRED, { externalId: '01bbb', confidence: 1 },
      { kind: 'highlight', document: 'hash', timestamp: 1, highlight: { text: 'missing passage' } }, fake.transport);
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(retryable);
    expect(!!r.needsReauth).toBe(needsReauth);
  });

  it('sends a clipping on an unmatched book to /api/v2/highlights/ as its own book', async () => {
    const fake = fakeTransport();
    fake.on('/highlights/', 200, []);
    const doc = { document: 'hash', title: 'Obscure Book', author: 'Nobody', filename: null };
    const r = await readwiseReaderConnector.pushUnmatched!(CRED, doc,
      { kind: 'highlight', document: 'hash', timestamp: 1, highlight: { text: 'A line', note: 'mine', highlightedAt: 1752300000 } },
      fake.transport);
    expect(r).toMatchObject({ ok: true, note: expect.stringMatching(/separate Readwise book/) });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0].url).toMatch(/\/api\/v2\/highlights\/$/);
    expect(JSON.parse(fake.calls[0].body!).highlights[0]).toMatchObject({
      text: 'A line', note: 'mine', title: 'Obscure Book', author: 'Nobody', source_type: 'crosspoint', category: 'books',
      highlighted_at: '2025-07-12T06:00:00.000Z',
    });
  });

  it('names an unmatched book from its filename when it has no title', async () => {
    const fake = fakeTransport();
    fake.on('/highlights/', 200, []);
    const doc = { document: 'hash', title: null, author: null, filename: 'Obscure Book.epub' };
    await readwiseReaderConnector.pushUnmatched!(CRED, doc,
      { kind: 'highlight', document: 'hash', timestamp: 1, highlight: { text: 'A line' } }, fake.transport);
    expect(JSON.parse(fake.calls[0].body!).highlights[0].title).toBe('Obscure Book');
  });

  it.each(['progress', 'finished'] as const)('leaves an unmatched %s event undelivered', async kind => {
    const fake = fakeTransport();
    const doc = { document: 'hash', title: 'Obscure Book', author: 'Nobody', filename: null };
    const r = await readwiseReaderConnector.pushUnmatched!(CRED, doc, { kind, document: 'hash', timestamp: 1, percentage: 0.5 }, fake.transport);
    expect(r).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it.each([
    [401, false, true],
    [403, false, true],
    [429, true, false],
    [500, true, false],
  ])('maps a %s response for an unmatched clipping', async (status, retryable, needsReauth) => {
    const fake = fakeTransport();
    fake.on('/highlights/', status, {});
    const doc = { document: 'hash', title: 'Obscure Book', author: 'Nobody', filename: null };
    const r = await readwiseReaderConnector.pushUnmatched!(CRED, doc,
      { kind: 'highlight', document: 'hash', timestamp: 1, highlight: { text: 'A line' } }, fake.transport);
    expect(r).toMatchObject({ ok: false, retryable });
    expect(!!(r as { needsReauth?: boolean }).needsReauth).toBe(needsReauth);
  });

  it.each(['progress', 'finished'] as const)('preserves newer Reader progress for queued %s events', async kind => {
    const fake = fakeTransport();
    fake.on('id=', 200, { results: [{ reading_progress: 0.7, updated_at: '2026-01-01T00:00:00Z' }] });
    const result = await readwiseReaderConnector.push(CRED, { externalId: '01bbb', confidence: 1 },
      { kind, document: 'hash', percentage: kind === 'finished' ? 1 : 0.2, timestamp: 1 }, fake.transport);
    expect(result.ok).toBe(true);
    expect(result.note).toContain('Newer Reader');
    expect(fake.calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  it.each([401, 403, 429, 500])('does not write when the position check fails with %s', async status => {
    const fake = fakeTransport();
    fake.on('id=', status, {});
    const result = await readwiseReaderConnector.push({ token: `preflight-${status}` }, { externalId: '01bbb', confidence: 1 },
      { kind: 'progress', document: 'hash', percentage: 0.5, timestamp: 1 }, fake.transport);
    expect(result).toMatchObject({ ok: false, retryable: status === 429 || status === 500,
      needsReauth: status === 401 || status === 403 });
    expect(fake.calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  it.each([undefined, 'invalid'])('does not overwrite a position with an unknown timestamp (%s)', async updated_at => {
    const fake = fakeTransport();
    fake.on('id=', 200, { results: [{ reading_progress: 0.1, updated_at }] });
    const result = await readwiseReaderConnector.push(CRED, { externalId: '01bbb', confidence: 1 },
      { kind: 'progress', document: 'hash', percentage: 0.5, timestamp: 1 }, fake.transport);
    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(fake.calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  it.each([NaN, Infinity, -0.1, 1.1, undefined])('rejects invalid percentages (%s)', async percentage => {
    const fake = fakeTransport();
    const result = await readwiseReaderConnector.push(CRED, { externalId: '01bbb', confidence: 1 },
      { kind: 'progress', document: 'hash', percentage, timestamp: 1 }, fake.transport);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(fake.calls).toHaveLength(0);
  });

  it('skips PDF positions but still archives a finished PDF', async () => {
    const fake = fakeTransport();
    fake.on('id=', 200, { results: [{ category: 'pdf', updated_at: '1970-01-01T00:00:00Z' }] });
    const event = { kind: 'progress' as const, document: 'hash', percentage: 0.5, timestamp: 1 };
    expect(await readwiseReaderConnector.push(CRED, { externalId: 'pdf', confidence: 1 }, event, fake.transport))
      .toMatchObject({ ok: true, note: expect.stringContaining('PDF') });
    expect(fake.calls.some(c => c.method === 'PATCH')).toBe(false);
    await readwiseReaderConnector.push(CRED, { externalId: 'pdf', confidence: 1 }, { ...event, kind: 'finished', percentage: 1 }, fake.transport);
    expect(JSON.parse(fake.calls.find(c => c.method === 'PATCH')!.body!))
      .toEqual({ updates: [{ id: 'pdf', location: 'archive', seen: true }] });
  });

  it('lists only EPUB documents, in every location', async () => {
    const fake = fakeTransport();
    fake.on('/list/', 200, { results: [{ id: 'book', title: 'Book', category: 'epub', location: 'archive' }] });
    expect(await readwiseReaderConnector.listCurrentlyReading!(CRED, fake.transport))
      .toEqual([{ externalId: 'book', title: 'Book', author: null }]);
    expect(fake.calls).toHaveLength(1);
    const params = new URL(fake.calls[0].url).searchParams;
    expect(params.get('category')).toBe('epub');
    expect(params.has('location')).toBe(false);
  });

  it('resumes the listing from its cursor after a rate limit', async () => {
    const fake = fakeTransport();
    fake.on('/list/', 200, { results: [{ id: 'b1', title: 'First Book' }], nextPageCursor: 'P2' });
    fake.on('pageCursor=P2', 429, {});
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(5_000_000);
      await expect(readwiseReaderConnector.search!(CRED, 'book', fake.transport)).rejects.toThrow('429');
      expect(fake.calls).toHaveLength(2);
      now.mockReturnValue(5_000_000 + 61_000);
      fake.on('pageCursor=P2', 200, { results: [{ id: 'b2', title: 'Second Book' }] });
      const found = await readwiseReaderConnector.search!(CRED, 'book', fake.transport);
      expect(found.map(b => b.externalId)).toEqual(['b1', 'b2']);
      expect(fake.calls).toHaveLength(3);
      expect(fake.calls[2].url).toContain('pageCursor=P2');
    } finally { now.mockRestore(); }
  });

  it('refreshes the listing with only changed documents, and fully once a day', async () => {
    const fake = fakeTransport();
    fake.on('/list/', 200, { results: [{ id: 'old', title: 'Old Book' }, { id: 'gone', title: 'Gone Book' }] });
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(10_000_000);
      expect(await readwiseReaderConnector.search!(CRED, 'book', fake.transport)).toHaveLength(2);
      now.mockReturnValue(10_000_000 + 300_001);
      fake.on('updatedAfter=', 200, { results: [{ id: 'new', title: 'New Book' }, { id: 'old', title: 'Old Book Renamed' }] });
      const found = await readwiseReaderConnector.search!(CRED, 'book', fake.transport);
      expect(found.map(b => [b.externalId, b.title])).toEqual([['old', 'Old Book Renamed'], ['gone', 'Gone Book'], ['new', 'New Book']]);
      expect(fake.calls).toHaveLength(2);
      expect(new URL(fake.calls[1].url).searchParams.get('updatedAfter')).toBe(new Date(10_000_000).toISOString());

      now.mockReturnValue(10_000_000 + 86_400_001);
      fake.on('/list/', 200, { results: [{ id: 'old', title: 'Old Book Renamed' }] });
      expect((await readwiseReaderConnector.search!(CRED, 'book', fake.transport)).map(b => b.externalId)).toEqual(['old']);
      expect(fake.calls).toHaveLength(3);
      expect(fake.calls[2].url).not.toContain('updatedAfter=');
    } finally { now.mockRestore(); }
  });

  it('retries a 207 partial failure', async () => {
    const fake = fakeTransport();
    fake.on('/bulk_update/', 207, {});
    const r = await readwiseReaderConnector.push(
      CRED,
      { externalId: '01bbb', confidence: 1 },
      { kind: 'finished', document: 'hash', percentage: 1, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
  });

  it('fan-in: pullProgress returns the Reader reading_progress newer than the cursor', async () => {
    const fake = fakeTransport();
    fake.on('id=', 200, { results: [{ reading_progress: 0.42, updated_at: '2026-01-02T00:00:00Z' }] });
    const change = await readwiseReaderConnector.pullProgress!(
      CRED,
      { externalId: '01bbb', confidence: 1 },
      fake.transport,
      Date.parse('2026-01-01T00:00:00Z')
    );
    expect(change).toMatchObject({ externalId: '01bbb', percentage: 0.42, finished: false });
  });

  it('fan-in: skips a document not updated since the cursor', async () => {
    const fake = fakeTransport();
    fake.on('id=', 200, { results: [{ reading_progress: 0.42, updated_at: '2026-01-01T00:00:00Z' }] });
    const change = await readwiseReaderConnector.pullProgress!(
      CRED,
      { externalId: '01bbb', confidence: 1 },
      fake.transport,
      Date.parse('2026-06-01T00:00:00Z')
    );
    expect(change).toBeNull();
  });

  it('fan-in: a missing updated_at yields a finite timestamp, never NaN', async () => {
    const fake = fakeTransport();
    fake.on('id=', 200, { results: [{ reading_progress: 0.3 }] }); // no updated_at
    const change = await readwiseReaderConnector.pullProgress!(
      CRED,
      { externalId: '01bbb', confidence: 1 },
      fake.transport,
      Date.parse('2026-01-01T00:00:00Z')
    );
    expect(change).not.toBeNull();
    expect(change!.percentage).toBe(0.3);
    expect(Number.isFinite(change!.updatedAtMs)).toBe(true);
  });

  it('matches a document that only appears on a later page (pagination)', async () => {
    const fake = fakeTransport();
    // First page of each location: one unrelated doc + a nextPageCursor.
    fake.on('/list/', 200, {
      results: [{ id: 'p1', title: 'First Page Filler', author: 'Q' }],
      nextPageCursor: 'CURSOR2',
    });
    // Second page (request carries pageCursor=) holds the target, no more pages.
    fake.on('pageCursor=', 200, {
      results: [{ id: 'p2', title: 'Buried On Page Two', author: 'Z' }],
      nextPageCursor: null,
    });
    const m = await readwiseReaderConnector.match!(
      CRED,
      { document: 'hash', title: 'Buried On Page Two', author: 'Z', filename: null },
      fake.transport
    );
    expect(m?.externalId).toBe('p2');
    expect(fake.calls.some((c) => c.url.includes('pageCursor=CURSOR2'))).toBe(true);
  });

  it('rate-limit cooldown is per-token, not global', async () => {
    // Token A trips a 429 -> its cooldown is set.
    const a1 = fakeTransport();
    a1.on('id=', 429, {});
    await expect(readwiseReaderConnector.pullProgress!(
      { token: 'rw_A' },
      { externalId: 'x', confidence: 1 },
      a1.transport,
      0
    )).rejects.toThrow('429');

    // A is now in cooldown: a follow-up makes no HTTP call at all.
    const a2 = fakeTransport();
    a2.on('id=', 200, { results: [{ reading_progress: 0.9, updated_at: '2026-01-01T00:00:00Z' }] });
    await expect(readwiseReaderConnector.pullProgress!(
      { token: 'rw_A' },
      { externalId: 'x', confidence: 1 },
      a2.transport,
      0
    )).rejects.toThrow('rate limited');
    expect(a2.calls).toHaveLength(0);

    // A different token B is unaffected and goes through.
    const b = fakeTransport();
    b.on('id=', 200, { results: [{ reading_progress: 0.5, updated_at: '2026-01-01T00:00:00Z' }] });
    const ok = await readwiseReaderConnector.pullProgress!(
      { token: 'rw_B' },
      { externalId: 'x', confidence: 1 },
      b.transport,
      0
    );
    expect(ok?.percentage).toBe(0.5);
    expect(b.calls.length).toBeGreaterThan(0);
  });
});

it('shares paginated candidates between concurrent searches and automatic matching', async () => {
  const fake = fakeTransport();
  fake.on('/list/', 200, { results: [{ id: 'first', title: 'Other' }], nextPageCursor: 'next' });
  fake.on('pageCursor=', 200, { results: [{ id: 'book', title: 'The Robots of Dawn', author: 'Isaac Asimov' }] });
  const [books, results, match] = await Promise.all([
    readwiseReaderConnector.listCurrentlyReading!(CRED, fake.transport),
    readwiseReaderConnector.search!(CRED, 'robots ASIMOV', fake.transport),
    readwiseReaderConnector.match!(CRED, { document: 'hash', title: 'The Robots of Dawn', author: 'Isaac Asimov', filename: null }, fake.transport),
  ]);
  expect(books).toHaveLength(2);
  expect(results.map(b => b.externalId)).toEqual(['book']);
  expect(match?.externalId).toBe('book');
  expect(fake.calls).toHaveLength(2);
  expect(await readwiseReaderConnector.search!({ token: CRED.token + '-other' }, 'robots', fake.transport)).toHaveLength(1);
  expect(fake.calls).toHaveLength(4);
});

it('expires cached candidates and does not retain failed requests', async () => {
  const fake = fakeTransport();
  const now = vi.spyOn(Date, 'now');
  try {
    now.mockReturnValue(1_000_000);
    fake.on('/list/', 500, {});
    await expect(readwiseReaderConnector.search!(CRED, 'book', fake.transport)).rejects.toThrow('500');
    fake.on('/list/', 200, { results: [{ id: 'book', title: 'Book' }] });
    expect(await readwiseReaderConnector.search!(CRED, 'book', fake.transport)).toHaveLength(1);
    expect(fake.calls).toHaveLength(2);
    now.mockReturnValue(1_300_001);
    await readwiseReaderConnector.search!(CRED, 'book', fake.transport);
    expect(fake.calls).toHaveLength(3);
  } finally { now.mockRestore(); }
});
