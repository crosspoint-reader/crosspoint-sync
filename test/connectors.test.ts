import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import type { HttpTransport } from '../src/connectors/types.js';
import { drainQueue } from '../src/connectors/runner.js';
import { claimReady } from '../src/connectors/queue.js';

// A programmable fake transport. Records requests; returns queued responses by
// URL substring match.
function fakeTransport() {
  const calls: { url: string; method: string; body?: string }[] = [];
  const handlers: { match: string; status: number; body: unknown }[] = [];
  const t: HttpTransport = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body });
    // Match on URL or request body; most-recently-registered wins so specific
    // GraphQL operations (Search, mutations) override a broad 'graphql' handler.
    const h = [...handlers]
      .reverse()
      .find((x) => url.includes(x.match) || (init.body ?? '').includes(x.match));
    const status = h?.status ?? 200;
    const body = h?.body ?? {};
    return {
      status,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
      json: async () => body,
    };
  };
  return {
    transport: t,
    calls,
    on(match: string, status: number, body: unknown) {
      handlers.push({ match, status, body });
    },
  };
}

const KEY = { TOKEN_ENC_KEY: 'a'.repeat(64) };

beforeEach(() => {
  Object.assign(process.env, KEY);
  resetEncryptionKeyCache();
});
afterEach(() => {
  delete process.env.TOKEN_ENC_KEY;
  resetEncryptionKeyCache();
});

describe('connector management API', () => {
  it('lists connectors with encryption status and unlinked state', async () => {
    const fake = fakeTransport();
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const res = await app.request('/api/v1/connectors', { headers });
    const body = await res.json();
    expect(body.encryption).toBe('enabled');
    const ids = body.connectors.map((c: { id: string }) => c.id).sort();
    // The classic (highlights-only) readwise connector is hidden; still
    // registered but not listed. readwise-reader (reading-state) is listed.
    expect(ids).toEqual(['audiobookshelf', 'bookfusion', 'hardcover', 'kosync', 'microblog', 'readwise-reader']);
    expect(body.connectors.every((c: { linked: boolean }) => !c.linked)).toBe(true);
  });

  it('rejects linking when TOKEN_ENC_KEY is unset', async () => {
    delete process.env.TOKEN_ENC_KEY;
    resetEncryptionKeyCache();
    const fake = fakeTransport();
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const res = await app.request('/api/v1/connectors/hardcover', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { token: 'x' } }),
    });
    expect(res.status).toBe(403);
  });

  it('validates and links Hardcover, then reports linked', async () => {
    const fake = fakeTransport();
    fake.on('graphql', 200, { data: { me: [{ username: 'julia' }] } });
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const link = await app.request('/api/v1/connectors/hardcover', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { token: 'hc-token' } }),
    });
    expect(link.status).toBe(200);
    expect((await link.json()).account).toBe('julia');

    const list = await (await app.request('/api/v1/connectors', { headers })).json();
    const hc = list.connectors.find((c: { id: string }) => c.id === 'hardcover');
    expect(hc.linked).toBe(true);
    expect(hc.account).toBe('julia');
  });

  it('rejects an invalid credential (validate fails)', async () => {
    const fake = fakeTransport();
    fake.on('graphql', 401, {});
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const res = await app.request('/api/v1/connectors/hardcover', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { token: 'bad' } }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects credentials sent over non-loopback HTTP', async () => {
    const fake = fakeTransport();
    fake.on('graphql', 200, { data: { me: [{ username: 'julia' }] } });
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const res = await app.request('http://sync.example.com/api/v1/connectors/hardcover', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { token: 'hc-token' } }),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ message: expect.stringContaining('HTTPS') });
    expect(fake.calls).toHaveLength(0);
  });

  it('accepts credentials forwarded from an HTTPS reverse proxy', async () => {
    const fake = fakeTransport();
    fake.on('graphql', 200, { data: { me: [{ username: 'julia' }] } });
    const { app } = makeTestApp({ trustProxy: true }, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const res = await app.request('http://sync.example.com/api/v1/connectors/hardcover', {
      method: 'PUT',
      headers: { ...headers, 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ credential: { token: 'hc-token' } }),
    });

    expect(res.status).toBe(200);
  });

  it('rejects a forged forwarded HTTPS header when proxy trust is disabled', async () => {
    const fake = fakeTransport();
    fake.on('graphql', 200, { data: { me: [{ username: 'julia' }] } });
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const res = await app.request('http://sync.example.com/api/v1/connectors/hardcover', {
      method: 'PUT',
      headers: { ...headers, 'x-forwarded-proto': 'https' },
      body: JSON.stringify({ credential: { token: 'hc-token' } }),
    });

    expect(res.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('rejects a forged loopback Host from a remote peer', async () => {
    const fake = fakeTransport();
    fake.on('graphql', 200, { data: { me: [{ username: 'julia' }] } });
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const res = await app.request('http://localhost/api/v1/connectors/hardcover', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { token: 'hc-token' } }),
    }, { incoming: { socket: { remoteAddress: '203.0.113.10' } } });

    expect(res.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('fails closed when a Node request has no peer address', async () => {
    const fake = fakeTransport();
    fake.on('graphql', 200, { data: { me: [{ username: 'julia' }] } });
    const { app } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    const res = await app.request('http://localhost/api/v1/connectors/hardcover', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { token: 'hc-token' } }),
    }, { incoming: { socket: {} } });

    expect(res.status).toBe(400);
    expect(fake.calls).toHaveLength(0);
  });

  it('unlink wipes account, matches, and queue', async () => {
    const fake = fakeTransport();
    fake.on('graphql', 200, { data: { me: [{ username: 'julia' }] } });
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/hardcover', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { token: 'hc' } }),
    });
    const del = await app.request('/api/v1/connectors/hardcover', { method: 'DELETE', headers });
    expect(del.status).toBe(200);
    const list = await (await app.request('/api/v1/connectors', { headers })).json();
    expect(list.connectors.find((c: { id: string }) => c.id === 'hardcover').linked).toBe(false);
  });
});

describe('fan-out on progress sync', () => {
  it('enqueues a progress event for a linked write connector and pushes it', async () => {
    const fake = fakeTransport();
    fake.on('graphql', 200, { data: { me: [{ username: 'julia' }] } });
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);

    // Link Hardcover.
    await app.request('/api/v1/connectors/hardcover', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { token: 'hc' } }),
    });
    // Provide metadata so matching can work, then sync progress.
    await app.request('/api/v1/documents', {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        items: [{ document: DOC, title: 'Foundryside', author: 'Robert Jackson Bennett' }],
      }),
    });
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: 'p', percentage: 0.3, device_id: 'd1' }),
    });

    // A pending queue row should exist.
    expect(claimReady(db, 10).length).toBeGreaterThan(0);

    // Now the drain: match (search) then push (mutation).
    fake.on('Search', 200, {
      data: { search: { results: [{ document: { id: 42, title: 'Foundryside', author_names: ['Robert Jackson Bennett'] } }] } },
    });
    // The push mutation returns success.
    fake.on('insert_user_book', 200, { data: { insert_user_book: { id: 1 } } });

    await drainQueue(db, fake.transport, 10);

    // Queue drained.
    expect(claimReady(db, 10)).toHaveLength(0);
    // A mutation call was made.
    expect(fake.calls.some((c) => c.body?.includes('insert_user_book'))).toBe(true);
  });

  it('does not fan out when no connector is linked', async () => {
    const fake = fakeTransport();
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: 'p', percentage: 0.3, device_id: 'd1' }),
    });
    expect(claimReady(db, 10)).toHaveLength(0);
  });

  it('does not fan out a metadata-less document to a metadata-matched connector', async () => {
    const fake = fakeTransport();
    fake.on('graphql', 200, { data: { me: [{ username: 'julia' }] } });
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/hardcover', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { token: 'hc' } }),
    });
    // Sync progress for a document we have NO title/author for.
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: 'p', percentage: 0.3, device_id: 'd1' }),
    });
    // Nothing queued: Hardcover can only match books we have metadata for, so a
    // metadata-less document would just dead-letter as "no book match".
    expect(claimReady(db, 10)).toHaveLength(0);
  });

  it('manual match override is honored and sticky', async () => {
    const fake = fakeTransport();
    fake.on('graphql', 200, { data: { me: [{ username: 'julia' }] } });
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/hardcover', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { token: 'hc' } }),
    });
    const set = await app.request(`/api/v1/connectors/hardcover/matches/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ external_id: '999' }),
    });
    expect(set.status).toBe(200);
    const list = await (
      await app.request('/api/v1/connectors/hardcover/matches', { headers })
    ).json();
    expect(list.matches[0]).toMatchObject({ document: DOC, external_id: '999', source: 'manual' });
  });
});

describe('readwise highlight fan-out', () => {
  it('pushes a clipping as a highlight', async () => {
    const fake = fakeTransport();
    fake.on('/auth/', 204, {});
    const { app, db } = makeTestApp({}, { connectorTransport: fake.transport });
    const { headers } = await registerUser(app);
    await app.request('/api/v1/connectors/readwise', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ credential: { token: 'rw' } }),
    });
    await app.request('/api/v1/documents', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ items: [{ document: DOC, title: 'Foundryside', author: 'RJB' }] }),
    });
    await app.request(`/api/v1/clippings/${DOC}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({
        items: [
          { id: 'c0ffee0011223344', spine: 1, text: 'a memorable line', created_at: 1752300000 },
        ],
      }),
    });
    expect(claimReady(db, 10).length).toBeGreaterThan(0);

    fake.on('/highlights/', 200, [{ id: 1 }]);
    await drainQueue(db, fake.transport, 10);
    expect(fake.calls.some((c) => c.url.includes('/highlights/') && c.method === 'POST')).toBe(true);
    expect(claimReady(db, 10)).toHaveLength(0);
  });
});
