import { Hono, type Context } from 'hono';
import { withTransaction, type DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { secretsEnabled } from '../../crypto/secrets.js';
import { fetchTransport, getConnector, listConnectors } from '../../connectors/registry.js';
import { purgeConnector, queueDepth } from '../../connectors/queue.js';
import { backfillConnector } from '../../connectors/fanout.js';
import { resolveMatch } from '../../connectors/runner.js';
import {
  backfillDocumentMeta,
  decryptCredential,
  deleteAccount,
  getAccount,
  getMatch,
  listMatches,
  listReveals,
  revealConnector,
  saveMatch,
  upsertAccount,
} from '../../connectors/store.js';
import { isValidDocument } from '../kosync.js';
import type { HttpTransport } from '../../connectors/types.js';

function loopbackHostname(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

function loopbackAddress(address: string): boolean {
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

export function credentialRequestIsSecure(c: Context<AppEnv>, trustProxy: boolean): boolean {
  const url = new URL(c.req.url);
  if (url.protocol === 'https:') return true;
  const incoming = c.env?.incoming;
  const peerAddress = incoming?.socket?.remoteAddress;
  if (loopbackHostname(url.hostname) && (!incoming || (peerAddress && loopbackAddress(peerAddress)))) {
    return true;
  }
  return trustProxy
    && c.req.header('x-forwarded-proto')?.split(',')[0].trim().toLowerCase() === 'https';
}

/**
 * Master-sync-hub connector management. Same x-auth headers as the rest of v1.
 * Credential entry realistically happens from a browser (token paste / OAuth),
 * but every endpoint works over curl too.
 *
 * `transport` is injectable so tests can validate/link connectors without real
 * network calls.
 */
export function connectorRoutes(
  db: DB,
  transport: HttpTransport = fetchTransport,
  trustProxy = false
): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // List available connectors + this user's link status. Stealth (revealable)
  // connectors are listed only once revealed — or linked, which implies reveal.
  app.get('/connectors', (c) => {
    const user = c.get('user');
    const enabled = secretsEnabled();
    const revealed = new Set(listReveals(db, user.id));
    const visible = listConnectors().filter((conn) => {
      if (!conn.revealable) return true;
      if (revealed.has(conn.id)) return true;
      return !!getAccount(db, user.id, conn.id);
    });
    return c.json({
      encryption: enabled ? 'enabled' : 'disabled',
      connectors: visible.map((conn) => {
        const account = getAccount(db, user.id, conn.id);
        return {
          id: conn.id,
          name: conn.displayName,
          tier: conn.tier,
          experimental: conn.experimental,
          carries: conn.carries,
          capabilities: conn.capabilities,
          credential_kind: conn.credentialKind,
          library_refresh: !!conn.refreshLibrary,
          asin_lookup: !!conn.lookup,
          linked: !!account,
          status: account?.status ?? null,
          account: account?.account_label ?? null,
          queue: account ? queueDepth(db, user.id, conn.id) : undefined,
        };
      }),
    });
  });

  // Link (or re-link) a connector by validating and storing its credential.
  app.put('/connectors/:id', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    if (!credentialRequestIsSecure(c, trustProxy)) {
      return c.json({ code: 2003, message: 'Connector credentials require HTTPS' }, 400);
    }
    if (!secretsEnabled()) {
      return c.json(
        { code: 2003, message: 'Server has no TOKEN_ENC_KEY; connector storage disabled' },
        403
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const cred = (body as Record<string, unknown> | null)?.credential;
    if (typeof cred !== 'object' || cred === null) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const result = await conn.validate(cred as Record<string, unknown>, transport);
    if (!result.ok) {
      return c.json({ code: 2003, message: result.error ?? 'Credential rejected' }, 400);
    }
    const user = c.get('user');
    upsertAccount(db, user.id, conn.id, cred as Record<string, unknown>, result.accountLabel ?? null);
    return c.json({ id: conn.id, linked: true, account: result.accountLabel ?? null });
  });

  // Begin an interactive device-code link (BookFusion). Returns the user code +
  // verification URL for the browser to show, and the device code to poll with.
  app.post('/connectors/:id/link/begin', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    if (!conn.beginLink) return c.json({ code: 2003, message: 'Connector has no device link' }, 400);
    if (!credentialRequestIsSecure(c, trustProxy)) {
      return c.json({ code: 2003, message: 'Connector credentials require HTTPS' }, 400);
    }
    if (!secretsEnabled()) {
      return c.json({ code: 2003, message: 'Server has no TOKEN_ENC_KEY; connector storage disabled' }, 403);
    }
    try {
      const start = await conn.beginLink(transport);
      return c.json({
        device_code: start.deviceCode,
        user_code: start.userCode,
        verification_uri: start.verificationUri,
        interval: start.interval,
        expires_in: start.expiresIn,
      });
    } catch (err) {
      return c.json({ code: 2003, message: err instanceof Error ? err.message : 'Link failed' }, 502);
    }
  });

  // Poll a device-code link; on success, store the credential and link.
  app.post('/connectors/:id/link/poll', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    if (!conn.pollLink) return c.json({ code: 2003, message: 'Connector has no device link' }, 400);
    if (!credentialRequestIsSecure(c, trustProxy)) {
      return c.json({ code: 2003, message: 'Connector credentials require HTTPS' }, 400);
    }
    let deviceCode: unknown;
    try {
      deviceCode = ((await c.req.json()) as Record<string, unknown>).device_code;
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    if (typeof deviceCode !== 'string') return kosyncError(c, 403, 2003, 'Invalid request');
    try {
      const result = await conn.pollLink(deviceCode, transport);
      if (result.status === 'ok' && result.credential) {
        const user = c.get('user');
        // Confirm the freshly minted credential works, then store it.
        const v = await conn.validate(result.credential, transport);
        upsertAccount(db, user.id, conn.id, result.credential, v.accountLabel ?? result.accountLabel ?? null);
        return c.json({ status: 'ok', linked: true });
      }
      return c.json({ status: result.status, error: result.error ?? null });
    } catch (err) {
      return c.json({ status: 'error', error: err instanceof Error ? err.message : 'poll failed' }, 502);
    }
  });

  // Reveal a stealth connector (the /kindle landing page calls this). Idempotent.
  app.post('/connectors/:id/reveal', (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    if (!conn.revealable) return c.json({ code: 2003, message: 'Connector is not revealable' }, 400);
    const user = c.get('user');
    revealConnector(db, user.id, conn.id);
    return c.json({ id: conn.id, revealed: true });
  });

  // Force-refresh the connector's server-side library list ("Refresh library" button).
  app.post('/connectors/:id/library/refresh', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    if (!conn.refreshLibrary) return c.json({ code: 2003, message: 'Connector has no library to refresh' }, 400);
    const user = c.get('user');
    const account = getAccount(db, user.id, conn.id);
    if (!account) return c.json({ code: 2003, message: 'Connector not linked' }, 400);
    try {
      const result = await conn.refreshLibrary(decryptCredential(account), transport);
      return c.json(result ?? { count: null });
    } catch (err) {
      return c.json({ code: 2003, message: err instanceof Error ? err.message : 'refresh failed' }, 502);
    }
  });

  // Verify an externally-supplied book id (e.g. a pasted ASIN) against the
  // user's account at this service before it becomes a manual match.
  app.post('/connectors/:id/lookup', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    if (!conn.lookup) return c.json({ code: 2003, message: 'Connector has no id lookup' }, 400);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const externalId = (body as Record<string, unknown> | null)?.external_id;
    if (typeof externalId !== 'string' || !externalId.trim()) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    const account = getAccount(db, user.id, conn.id);
    if (!account) return c.json({ code: 2003, message: 'Connector not linked' }, 400);
    try {
      const book = await conn.lookup(decryptCredential(account), externalId, transport);
      return c.json({ found: !!book, book: book ?? null });
    } catch (err) {
      return c.json({ code: 2003, message: err instanceof Error ? err.message : 'lookup failed' }, 502);
    }
  });

  // "Sync now": backfill this connector with everything already synced.
  app.post('/connectors/:id/sync', (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const user = c.get('user');
    if (!getAccount(db, user.id, conn.id)) {
      return c.json({ code: 2003, message: 'Connector not linked' }, 400);
    }
    const queued = backfillConnector(db, user.id, conn.id);
    return c.json({ queued });
  });

  // Unlink and wipe queued work + matches.
  app.delete('/connectors/:id', (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const user = c.get('user');
    withTransaction(db, () => {
      deleteAccount(db, user.id, conn.id);
      purgeConnector(db, user.id, conn.id);
      db.prepare('DELETE FROM connector_matches WHERE user_id = ? AND connector_id = ?').run(
        user.id,
        conn.id
      );
    });
    return c.json({ id: conn.id, linked: false });
  });

  // List this user's book matches for a connector (for the review UI).
  app.get('/connectors/:id/matches', (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const user = c.get('user');
    return c.json({
      connector: conn.id,
      matches: listMatches(db, user.id, conn.id).map((m) => ({
        document: m.document,
        external_id: m.external_id,
        confidence: m.confidence,
        source: m.source,
        query_used: m.query_used,
        updated_at: m.updated_at,
      })),
    });
  });

  // Review list: every synced book with its title and this connector's match state.
  app.get('/connectors/:id/review', (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const user = c.get('user');
    const rows = db
      .prepare(
        `SELECT p.document AS document, d.title AS title, d.author AS author,
                m.external_id AS external_id, m.source AS source, m.confidence AS confidence,
                m.push_note AS push_note
         FROM progress p
         LEFT JOIN documents d ON d.user_id = p.user_id AND d.document = p.document
         LEFT JOIN connector_matches m ON m.user_id = p.user_id AND m.connector_id = ? AND m.document = p.document
         WHERE p.user_id = ?
         GROUP BY p.document
         ORDER BY MAX(p.updated_at) DESC
         LIMIT 500`
      )
      .all(conn.id, user.id) as unknown as {
      document: string;
      title: string | null;
      author: string | null;
      external_id: string | null;
      source: string | null;
      confidence: number | null;
      push_note: string | null;
    }[];
    return c.json({
      connector: conn.id,
      books: rows.map((r) => ({
        document: r.document,
        title: r.title,
        author: r.author,
        matched: !!r.external_id,
        external_id: r.external_id,
        source: r.source ?? 'none',
        confidence: r.confidence ?? 0,
        push_note: r.push_note,
      })),
    });
  });

  // The user's "currently reading" list at this connector (manual-match picker).
  app.get('/connectors/:id/candidates', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    if (!conn.listCurrentlyReading) return c.json({ books: [] });
    const user = c.get('user');
    const account = getAccount(db, user.id, conn.id);
    if (!account) return c.json({ code: 2003, message: 'Connector not linked' }, 400);
    try {
      const books = await conn.listCurrentlyReading(decryptCredential(account), transport);
      return c.json({ books });
    } catch (err) {
      return c.json({ books: [], error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // Free-text search at this connector (manual-match picker).
  app.get('/connectors/:id/search', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const q = (c.req.query('q') ?? '').trim();
    if (!conn.search || q.length === 0) return c.json({ books: [] });
    const user = c.get('user');
    const account = getAccount(db, user.id, conn.id);
    if (!account) return c.json({ code: 2003, message: 'Connector not linked' }, 400);
    try {
      const books = await conn.search(decryptCredential(account), q, transport);
      return c.json({ books });
    } catch (err) {
      return c.json({ books: [], error: err instanceof Error ? err.message : 'failed' });
    }
  });

  // Manually set/override a match (sticky - never auto-recomputed).
  app.put('/connectors/:id/matches/:document', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const o = (body ?? {}) as Record<string, unknown>;
    const externalId = o.external_id;
    const user = c.get('user');
    if (externalId === null) {
      // Explicit "no match" override - stop trying to sync this document.
      saveMatch(db, user.id, conn.id, document, null, 'manual');
      return c.json({ document, external_id: null, source: 'manual' });
    }
    if (typeof externalId !== 'string' || externalId.length === 0 || externalId.length > 128) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const title = typeof o.title === 'string' ? o.title : null;
    const author = typeof o.author === 'string' ? o.author : null;
    let externalEdition = typeof o.external_edition === 'string' ? o.external_edition : null;
    // If the picker didn't carry an edition hint (e.g. an audiobook duration),
    // resolve it now so push has what it needs to place the position exactly.
    if (!externalEdition && conn.resolveEdition) {
      const account = getAccount(db, user.id, conn.id);
      if (account) {
        try {
          externalEdition = await conn.resolveEdition(decryptCredential(account), externalId, transport);
        } catch {
          externalEdition = null; // best-effort; push can still fall back
        }
      }
    }
    saveMatch(
      db,
      user.id,
      conn.id,
      document,
      {
        externalId,
        externalEdition,
        confidence: 1,
        title,
        author,
      },
      'manual'
    );
    // A manual pick also teaches us the book's title/author (if we lacked it),
    // so metadata-less syncs and other connectors benefit.
    backfillDocumentMeta(db, user.id, document, title, author);
    return c.json({ document, external_id: externalId, source: 'manual' });
  });

  // Force (re)matching of a document now - useful for testing and the review UI.
  app.post('/connectors/:id/rematch/:document', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    if (!getAccount(db, user.id, conn.id)) {
      return c.json({ code: 2003, message: 'Connector not linked' }, 400);
    }
    // Clear any auto/none row so resolveMatch recomputes (manual is preserved).
    const existing = getMatch(db, user.id, conn.id, document);
    if (existing && existing.source !== 'manual') {
      db.prepare(
        'DELETE FROM connector_matches WHERE user_id = ? AND connector_id = ? AND document = ?'
      ).run(user.id, conn.id, document);
    }
    const match = await resolveMatch(db, conn.id, user.id, document, transport);
    return c.json({ document, match: match ?? null });
  });

  return app;
}
