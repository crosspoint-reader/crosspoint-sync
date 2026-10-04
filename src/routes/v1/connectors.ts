import { createHash, randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { withTransaction, type DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { secretsEnabled } from '../../crypto/secrets.js';
import { fetchTransport, getConnector, listConnectors } from '../../connectors/registry.js';
import { purgeConnector, queueDepth } from '../../connectors/queue.js';
import { backfillConnector } from '../../connectors/fanout.js';
import { spotifyFirstSync } from '../../connectors/fanin.js';
import { resolveMatch } from '../../connectors/runner.js';
import { CLIENT_ID_RE, CLIENT_ID_REJECTED, spotifyPlan, spotifyResume, spotifyTracks } from '../../connectors/spotify.js';
import {
  backfillDocumentMeta,
  decryptCredential,
  deleteAccount,
  getAccount,
  getClientId,
  getMatch,
  getMatchAnchor,
  latestPercentage,
  listMatches,
  listReveals,
  revealConnector,
  saveMatch,
  setAccountStatus,
  setMatchAnchor,
  setClientId,
  upsertAccount,
} from '../../connectors/store.js';
import { isValidDocument } from '../kosync.js';
import { ConnectorOperationError, type HttpTransport } from '../../connectors/types.js';

/** Where a provider sends the browser back: one https URL for web and native (an app link there). */
export const oauthCallbackPath = (id: string) => `/connectors/${id}/callback`;

interface PendingOAuth {
  userId: number;
  connectorId: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  client: 'app' | 'web';
  expires: number;
  outcome?: Promise<{ error?: string }>;
}
// Browser sign-ins in flight, by state.
// ponytail: in memory, so one server instance; a restart mid-sign-in means signing in again.
const pendingOAuth = new Map<string, PendingOAuth>();
const OAUTH_TTL_MS = 10 * 60_000;
const b64url = (b: Buffer) => b.toString('base64url');

function publicOrigin(c: Context<AppEnv>, trustProxy: boolean): string {
  const url = new URL(c.req.url);
  const https = trustProxy && c.req.header('x-forwarded-proto')?.split(',')[0].trim().toLowerCase() === 'https';
  return `${https ? 'https:' : url.protocol}//${url.host}`;
}

/**
 * Finish a sign-in from whoever got the redirect (the app via its app link, or
 * the callback page). The code is exchanged once; browsers can send the
 * redirect twice, so a repeat waits for and shares the first one's result.
 */
async function completeOAuth(
  db: DB, transport: HttpTransport, state: string, code: string | undefined, error: string | undefined
): Promise<{ entry?: PendingOAuth; error?: string }> {
  const entry = pendingOAuth.get(state);
  if (!entry || entry.expires < Date.now()) return { error: 'This sign-in expired. Start again from Settings.' };
  entry.outcome ??= exchangeOAuth(db, transport, entry, code, error);
  return { entry, ...(await entry.outcome) };
}

async function exchangeOAuth(
  db: DB, transport: HttpTransport, entry: PendingOAuth, code: string | undefined, error: string | undefined
): Promise<{ error?: string }> {
  const conn = getConnector(entry.connectorId)!;
  if (!code) return { error: error === 'access_denied' ? `You declined on ${conn.displayName}.` : 'Sign-in failed. Start again.' };
  const cred: Record<string, unknown> = { code, code_verifier: entry.verifier, redirect_uri: entry.redirectUri, client_id: entry.clientId };
  const result = await conn.validate(cred, transport);
  if (!result.ok) return { error: result.error ?? 'Sign-in failed. Start again.' };
  const first = !getAccount(db, entry.userId, conn.id);
  upsertAccount(db, entry.userId, conn.id, cred, result.accountLabel ?? null);
  if (first && conn.id === 'spotify') {
    spotifyFirstSync(db, entry.userId, transport).catch((err) =>
      console.error(JSON.stringify({ msg: 'first sync failed', connector: conn.id, user_id: entry.userId,
        error: err instanceof Error ? err.message : String(err) })));
  }
  return {};
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>body{font:16px system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1c1917}a{color:#b45309}</style></head>
<body><h1 style="font-size:1.25rem">${title}</h1><p>${body}</p></body></html>`;

/**
 * The provider's redirect when no app intercepted it: completes the link right
 * here, then returns a web sign-in to the app's Settings. Unauthenticated; the
 * single-use state is what ties it to the user who began.
 */
export function oauthCallbackRoutes(db: DB, transport: HttpTransport = fetchTransport): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/connectors/:id/callback', async (c) => {
    const { entry, error } = await completeOAuth(db, transport, c.req.query('state') ?? '', c.req.query('code'), c.req.query('error'));
    const name = escapeHtml(getConnector(c.req.param('id'))?.displayName ?? 'Service');
    if (error) {
      return c.html(page(`${name} not linked`, `${escapeHtml(error)} <a href="/app/#/settings">Back to Settings</a>`), 400);
    }
    if (entry!.client === 'web') return c.redirect(`/app/#/settings/${encodeURIComponent(entry!.connectorId)}`);
    return c.html(page(`${name} linked`, 'You can go back to the CrossPoint Sync app.'));
  });
  return app;
}

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
          beta: conn.beta,
          carries: conn.carries,
          capabilities: conn.capabilities,
          credential_kind: conn.credentialKind,
          // Sign-in setup: the redirect to register (this server's own public URL), the
          // user's own client id, and whether the server has a shared one.
          ...(conn.oauth ? { oauth: {
            redirect_uri: publicOrigin(c, trustProxy) + oauthCallbackPath(conn.id),
            client_id: getClientId(db, user.id, conn.id),
            shared: !!conn.oauth().clientId,
          } } : {}),
          library_refresh: !!conn.refreshLibrary,
          asin_lookup: !!conn.lookup,
          matches: conn.matchBy !== 'document',
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
    // Browser sign-in only starts from a visible connector.
    const userId = c.get('user').id;
    if (conn.revealable && conn.oauth && !listReveals(db, userId).includes(conn.id) && !getAccount(db, userId, conn.id)) {
      return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    }
    // Sign-in goes through oauth/begin; older apps would send a pasted token here.
    if (conn.oauth) {
      return c.json({ code: 2003, message: `Update the CrossPoint Sync app to sign in with ${conn.displayName}.` }, 400);
    }
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
        verification_uri_complete: start.verificationUriComplete ?? null,
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

  // Start a browser sign-in: the server keeps the PKCE verifier, so whichever
  // side receives the redirect (app link or callback page) can finish it.
  // An OAuth connector this user may set up (revealed, for gated ones), else null.
  function oauthConnector(c: Context<AppEnv>) {
    const conn = getConnector(c.req.param('id') ?? '');
    const userId = c.get('user').id;
    if (!conn?.oauth || (conn.revealable && !listReveals(db, userId).includes(conn.id) && !getAccount(db, userId, conn.id))) return null;
    return conn;
  }

  // The user's own developer app: checked with the provider, then used for new sign-ins.
  // An existing link keeps the client id that issued its tokens until signing in again.
  app.put('/connectors/:id/client-id', async (c) => {
    const conn = oauthConnector(c);
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const body = (await c.req.json().catch(() => null)) as { client_id?: unknown } | null;
    const id = typeof body?.client_id === 'string' ? body.client_id.trim().toLowerCase() : '';
    if (!CLIENT_ID_RE.test(id)) {
      return c.json({ code: 2003, message: 'A Client ID is 32 letters and numbers. Copy it from your app\'s Settings (step 3).' }, 400);
    }
    const redirectUri = publicOrigin(c, trustProxy) + oauthCallbackPath(conn.id);
    if ((await conn.checkClientId?.(id, redirectUri, transport)) === 'rejected') {
      return c.json({ code: 2003, message: CLIENT_ID_REJECTED }, 400);
    }
    setClientId(db, c.get('user').id, conn.id, id);
    return c.json({ id: conn.id, client_id: id });
  });

  app.delete('/connectors/:id/client-id', (c) => {
    const conn = oauthConnector(c);
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    setClientId(db, c.get('user').id, conn.id, null);
    return c.json({ id: conn.id, client_id: null });
  });

  app.post('/connectors/:id/oauth/begin', async (c) => {
    const conn = oauthConnector(c);
    const user = c.get('user');
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const config = conn.oauth!();
    const clientId = getClientId(db, user.id, conn.id) ?? config.clientId;
    if (!clientId) return c.json({ code: 2003, message: `Add your ${conn.displayName} app's Client ID first.` }, 400);
    if (!credentialRequestIsSecure(c, trustProxy)) {
      return c.json({ code: 2003, message: 'Connector credentials require HTTPS' }, 400);
    }
    if (!secretsEnabled()) {
      return c.json({ code: 2003, message: 'Server has no TOKEN_ENC_KEY; connector storage disabled' }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as { client?: string } | null;
    const now = Date.now();
    for (const [k, v] of pendingOAuth) if (v.expires < now) pendingOAuth.delete(k);
    const verifier = b64url(randomBytes(48));
    const state = b64url(randomBytes(16));
    const redirectUri = publicOrigin(c, trustProxy) + oauthCallbackPath(conn.id);
    pendingOAuth.set(state, {
      userId: user.id, connectorId: conn.id, verifier, redirectUri, clientId,
      client: body?.client === 'app' ? 'app' : 'web', expires: now + OAUTH_TTL_MS,
    });
    const q = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: config.scopes.join(' '),
      code_challenge_method: 'S256',
      code_challenge: b64url(createHash('sha256').update(verifier).digest()),
      state,
    });
    return c.json({ authorize_url: `${config.authorizeUrl}?${q}`, redirect_uri: redirectUri });
  });

  // The app caught the redirect through its app link.
  app.post('/connectors/:id/oauth/complete', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { state?: string; code?: string; error?: string } | null;
    const state = typeof body?.state === 'string' ? body.state : '';
    const user = c.get('user');
    const entry = pendingOAuth.get(state);
    if (entry?.userId !== user.id || entry.connectorId !== c.req.param('id')) {
      return c.json({ code: 2003, message: 'This sign-in expired. Start again from Settings.' }, 400);
    }
    const { error } = await completeOAuth(db, transport, state, body?.code, body?.error);
    if (error) return c.json({ code: 2003, message: error }, 400);
    return c.json({ id: c.req.param('id'), linked: true });
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
      const result = await conn.refreshLibrary(decryptCredential(account, db), transport);
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
      const book = await conn.lookup(decryptCredential(account, db), externalId, transport);
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
      db.prepare('DELETE FROM epub_maps WHERE user_id = ? AND connector_id = ?').run(user.id, conn.id);
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

  // Spotify listening position for a book, matched on demand (Spotify never
  // syncs in the background). { matched: false } hides the book-page card.
  async function spotifyBook(c: Context<AppEnv>) {
    const document = c.req.param('document') ?? '';
    if (!isValidDocument(document)) return { error: kosyncError(c, 403, 2004, "Field 'document' not provided.") };
    const user = c.get('user');
    const account = getAccount(db, user.id, 'spotify');
    if (!account) return { error: c.json({ code: 2003, message: 'Spotify not linked' }, 400) };
    let m = getMatch(db, user.id, 'spotify', document);
    // Search once per book, again only after a re-link, like refresh.ts's matchOnDemand.
    if (!m || (!m.external_id && m.source !== 'manual' && m.updated_at < account.updated_at)) {
      await resolveMatch(db, 'spotify', user.id, document, transport).catch(() => null);
      m = getMatch(db, user.id, 'spotify', document);
    }
    const externalId = m?.external_id ?? null;
    return {
      user, document, cred: decryptCredential(account, db), externalId,
      readerPct: latestPercentage(db, user.id, document),
      anchor: externalId ? getMatchAnchor(db, user.id, 'spotify', externalId) : null,
    };
  }

  function spotifyFailed(c: Context<AppEnv>, userId: number, err: unknown) {
    if (err instanceof ConnectorOperationError && err.needsReauth) setAccountStatus(db, userId, 'spotify', 'needs_reauth', err.message);
    return c.json({ code: 2003, message: err instanceof Error ? err.message : 'Spotify failed' }, 502);
  }

  app.get('/connectors/spotify/position/:document', async (c) => {
    const b = await spotifyBook(c);
    if (b.error) return b.error;
    if (!b.externalId) return c.json({ matched: false, position: null });
    try {
      const plan = await spotifyPlan(b.cred, b.externalId, transport, b.readerPct, b.anchor);
      // position: Spotify's own place; target: where Resume goes (the reader's place when it's ahead).
      return c.json({
        matched: true, external_id: b.externalId, position: plan?.position ?? null, target: plan?.target ?? null,
        reader_pct: b.readerPct, anchor: b.anchor,
      });
    } catch (err) {
      return spotifyFailed(c, b.user.id, err);
    }
  });

  // "Resume in Spotify": a user tap. On 403/404 the app opens app_url (the Spotify app), else fallback_url.
  app.post('/connectors/spotify/resume/:document', async (c) => {
    const b = await spotifyBook(c);
    if (b.error) return b.error;
    if (!b.externalId) return c.json({ code: 2003, message: 'Book is not matched on Spotify' }, 404);
    try {
      const r = await spotifyResume(b.cred, b.externalId, transport, b.readerPct, b.anchor);
      if (!r) return c.json({ code: 2003, message: 'Spotify has no position for this audiobook' }, 404);
      return c.json(r.ok ? { ok: true, position: r.position } : { ok: false, position: r.position, reason: r.reason, fallback_url: r.fallbackUrl, app_url: r.appUrl });
    } catch (err) {
      return spotifyFailed(c, b.user.id, err);
    }
  });

  // Calibration ("Not the right spot?"): the audiobook's tracks to pick from, and
  // saving "where my reader is now = this track at this time" for the book.
  app.get('/connectors/spotify/tracks/:document', async (c) => {
    const b = await spotifyBook(c);
    if (b.error) return b.error;
    if (!b.externalId) return c.json({ code: 2003, message: 'Book is not matched on Spotify' }, 404);
    try {
      return c.json({ ...(await spotifyTracks(b.cred, b.externalId, transport)), reader_pct: b.readerPct, anchor: b.anchor });
    } catch (err) {
      return spotifyFailed(c, b.user.id, err);
    }
  });

  app.put('/connectors/spotify/anchor/:document', async (c) => {
    const b = await spotifyBook(c);
    if (b.error) return b.error;
    if (!b.externalId) return c.json({ code: 2003, message: 'Book is not matched on Spotify' }, 404);
    if (b.readerPct == null || !(b.readerPct > 0 && b.readerPct < 1)) {
      return c.json({ code: 2003, message: 'Sync your reader from somewhere inside the book first' }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as { track?: unknown; position_ms?: unknown } | null;
    const index = Number(body?.track);
    const offset = Math.max(0, Number(body?.position_ms ?? 0) || 0);
    try {
      const { tracks, total_ms } = await spotifyTracks(b.cred, b.externalId, transport);
      const t = tracks[index];
      if (!Number.isInteger(index) || !t || !total_ms) return kosyncError(c, 403, 2003, 'Invalid request');
      const audio = (t.start_ms + Math.min(offset, t.duration_ms)) / total_ms;
      if (!(audio > 0 && audio < 1)) return c.json({ code: 2003, message: 'Pick a track inside the book, not its very start or end' }, 400);
      const anchor = { text: b.readerPct, audio };
      setMatchAnchor(db, b.user.id, 'spotify', b.document, anchor);
      return c.json({ anchor });
    } catch (err) {
      return spotifyFailed(c, b.user.id, err);
    }
  });

  app.delete('/connectors/spotify/anchor/:document', async (c) => {
    const b = await spotifyBook(c);
    if (b.error) return b.error;
    setMatchAnchor(db, b.user.id, 'spotify', b.document, null);
    return c.json({ anchor: null });
  });

  // One book's match at each linked service (the app's book page).
  app.get('/documents/:document/matches', (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    const user = c.get('user');
    const services = listConnectors().flatMap((conn) => {
      // Services keyed on our own document hash (another KOSync server) have nothing to match.
      if (conn.matchBy === 'document' || !getAccount(db, user.id, conn.id)) return [];
      const m = getMatch(db, user.id, conn.id, document);
      return [
        {
          id: conn.id,
          name: conn.displayName,
          matched: !!m?.external_id,
          external_id: m?.external_id ?? null,
          source: m?.source ?? 'none',
          push_note: m?.push_note ?? null,
        },
      ];
    });
    return c.json({ document, services });
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
      const books = await conn.listCurrentlyReading(decryptCredential(account, db), transport);
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
      const books = await conn.search(decryptCredential(account, db), q, transport);
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
          externalEdition = await conn.resolveEdition(decryptCredential(account, db), externalId, transport);
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
