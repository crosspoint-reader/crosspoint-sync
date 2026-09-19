import { describe, expect, it } from 'vitest';
import type { HttpTransport } from '../src/connectors/types.js';
import { readwiseReaderConnector } from '../src/connectors/readwise-reader.js';

// Minimal fake transport (same shape as the one in connectors-more.test.ts):
// records calls, and returns the last-registered handler whose match string
// appears in the URL or body.
function fakeTransport() {
  const calls: { url: string; method: string; body?: string }[] = [];
  const handlers: { match: string; status: number; body: unknown }[] = [];
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
    expect(JSON.parse(call!.body!)).toEqual({ updates: [{ id: '01bbb', location: 'archive', seen: true }] });
  });

  it('ignores in-progress events (only finish archives)', async () => {
    const fake = fakeTransport();
    const r = await readwiseReaderConnector.push(
      CRED,
      { externalId: '01bbb', confidence: 1 },
      { kind: 'progress', document: 'hash', percentage: 0.5, timestamp: 1 },
      fake.transport
    );
    expect(r.ok).toBe(true);
    expect(fake.calls).toHaveLength(0);
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
    const blocked = await readwiseReaderConnector.pullProgress!(
      { token: 'rw_A' },
      { externalId: 'x', confidence: 1 },
      a1.transport,
      0
    );
    expect(blocked).toBeNull();

    // A is now in cooldown: a follow-up makes no HTTP call at all.
    const a2 = fakeTransport();
    a2.on('id=', 200, { results: [{ reading_progress: 0.9, updated_at: '2026-01-01T00:00:00Z' }] });
    const stillBlocked = await readwiseReaderConnector.pullProgress!(
      { token: 'rw_A' },
      { externalId: 'x', confidence: 1 },
      a2.transport,
      0
    );
    expect(stillBlocked).toBeNull();
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
