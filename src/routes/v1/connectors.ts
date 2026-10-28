import { createHash, randomBytes } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { withTransaction, type DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { secretsEnabled } from '../../crypto/secrets.js';
import { fetchTransport, getConnector, listConnectors } from '../../connectors/registry.js';
import { purgeConnector, queueDepth, queueErrors } from '../../connectors/queue.js';
import { backfillConnector } from '../../connectors/fanout.js';
import { pollConnector, jellyfinFirstSync, spotifyFirstSync } from '../../connectors/fanin.js';
import { resolveMatch } from '../../connectors/runner.js';
import { CLIENT_ID_RE, CLIENT_ID_REJECTED, playWhenDeviceAppears, spotifyPlan, spotifyResume, spotifyTracks } from '../../connectors/spotify.js';
import {
  backfillDocumentMeta,
  connectorOptions,
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
  setConnectorOptions,
  upsertAccount,
  type OptionValues,
} from '../../connectors/store.js';
import { isValidDocument, listCursor, parseListCursor } from '../kosync.js';
import { ConnectorOperationError, type HttpTransport } from '../../connectors/types.js';
import { importBookorbitStats } from '../../connectors/bookorbit-stats.js';
import { resolveDocument } from '../../models/merge.js';
import { hasDocumentData } from '../../models/document.js';
import { selectMicroblogClipping, scheduleMicroblogClippings, recreateMicroblogClippings } from '../../connectors/microblog-clippings.js';
import { isItemId } from '../../models/sync.js';
import { listMicroblogDestinations, selectedMicroblogDestination } from '../../connectors/microblog-destinations.js';

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
const REVIEW_PAGE = 500;
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

const UNREACHABLE_SERVER =
  "Couldn't reach that server from your sync server. It needs an address the sync server can reach: a server only on your home network works if you self-host CrossPoint Sync on that network.";

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
export function oauthCallbackRoutes(db: DB, transport: HttpTransport = fetchTransport, basePath = ''): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/connectors/:id/callback', async (c) => {
    const { entry, error } = await completeOAuth(db, transport, c.req.query('state') ?? '', c.req.query('code'), c.req.query('error'));
    const name = escapeHtml(getConnector(c.req.param('id'))?.displayName ?? 'Service');
    if (error) {
      return c.html(page(`${name} not linked`, `${escapeHtml(error)} <a href="${basePath}/app/#/settings">Back to Settings</a>`), 400);
    }
    if (entry!.client === 'web') return c.redirect(`${basePath}/app/#/settings/${encodeURIComponent(entry!.connectorId)}`);
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

export const CREDENTIAL_HTTPS_REQUIRED = 'Connector credentials require HTTPS to CrossPoint Sync. '
  + 'If HTTPS ends at a reverse proxy, configure TRUST_PROXY=true on the Sync server '
  + 'and have the proxy send X-Forwarded-Proto: https. Only enable proxy trust when direct access to Sync is blocked.';

export function credentialRequestIsSecure(c: Context<AppEnv>, trustProxy: boolean, allowHttpLocalhost = false): boolean {
  const url = new URL(c.req.url);
  if (url.protocol === 'https:') return true;
  const incoming = c.env?.incoming;
  const peerAddress = incoming?.socket?.remoteAddress;
  // Docker NAT can give a host-local request a bridge peer address. Only an
  // explicit localhost-testing opt-in bypasses the peer check; the host port
  // must be bound to 127.0.0.1. Host alone is not trusted on ordinary installs.
  if (loopbackHostname(url.hostname) && (!incoming || (peerAddress && (loopbackAddress(peerAddress) || allowHttpLocalhost)))) {
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
  trustProxy = false,
  basePath = '',
  allowHttpLocalhost = false
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
            redirect_uri: publicOrigin(c, trustProxy) + basePath + oauthCallbackPath(conn.id),
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
          queue_errors: account ? [...queueErrors(db, user.id, conn.id), ...(conn.id === 'bookorbit' ?
            db.prepare(`SELECT 'reading session' AS kind, e.last_error AS message, COUNT(*) AS count
              FROM bookorbit_session_exports e JOIN reading_sessions local USING(user_id, device_id, session_id)
              JOIN bookorbit_session_destination d ON d.user_id=e.user_id AND d.destination=e.destination
              WHERE e.user_id=? AND e.exported_seconds < local.seconds AND e.last_error IS NOT NULL GROUP BY e.last_error LIMIT 3`)
              .all(user.id) : [])] : undefined,
          ...(conn.options ? { options: conn.options, option_values: account ? connectorOptions(db, user.id, conn) : null } : {}),
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
    if (!credentialRequestIsSecure(c, trustProxy, allowHttpLocalhost)) {
      return c.json({ code: 2003, message: CREDENTIAL_HTTPS_REQUIRED }, 400);
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
      // Node's fetch says only "fetch failed" for an unreachable host, such as an
      // address on the user's home network that this server can't see.
      const message = result.error === 'fetch failed' ? UNREACHABLE_SERVER : (result.error ?? 'Credential rejected');
      return c.json({ code: 2003, message }, 400);
    }
    const user = c.get('user');
    const first = !getAccount(db, user.id, conn.id);
    upsertAccount(db, user.id, conn.id, cred as Record<string, unknown>, result.accountLabel ?? null);
    if (conn.id === 'bookorbit') void importBookorbitStats(db, user.id, transport);
    if (first && conn.id === 'jellyfin') {
      jellyfinFirstSync(db, user.id, transport).catch((err) =>
        console.error(JSON.stringify({ msg: 'first sync failed', connector: conn.id, user_id: user.id,
          error: err instanceof Error ? err.message : String(err) })));
    }
    return c.json({ id: conn.id, linked: true, account: result.accountLabel ?? null });
  });

  // Begin an interactive device-code link (BookFusion). Returns the user code +
  // verification URL for the browser to show, and the device code to poll with.
  app.post('/connectors/:id/link/begin', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    if (!conn.beginLink) return c.json({ code: 2003, message: 'Connector has no device link' }, 400);
    if (!credentialRequestIsSecure(c, trustProxy, allowHttpLocalhost)) {
      return c.json({ code: 2003, message: CREDENTIAL_HTTPS_REQUIRED }, 400);
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
    if (!credentialRequestIsSecure(c, trustProxy, allowHttpLocalhost)) {
      return c.json({ code: 2003, message: CREDENTIAL_HTTPS_REQUIRED }, 400);
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
        if (!v.ok) return c.json({ status: 'error', error: v.error ?? 'Credential rejected' }, 400);
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
    const redirectUri = publicOrigin(c, trustProxy) + basePath + oauthCallbackPath(conn.id);
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
    if (!credentialRequestIsSecure(c, trustProxy, allowHttpLocalhost)) {
      return c.json({ code: 2003, message: CREDENTIAL_HTTPS_REQUIRED }, 400);
    }
    if (!secretsEnabled()) {
      return c.json({ code: 2003, message: 'Server has no TOKEN_ENC_KEY; connector storage disabled' }, 403);
    }
    const body = (await c.req.json().catch(() => null)) as { client?: string } | null;
    const now = Date.now();
    for (const [k, v] of pendingOAuth) if (v.expires < now) pendingOAuth.delete(k);
    const verifier = b64url(randomBytes(48));
    const state = b64url(randomBytes(16));
    const redirectUri = publicOrigin(c, trustProxy) + basePath + oauthCallbackPath(conn.id);
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

  app.get('/connectors/microblog/destinations', async (c) => {
    const userId = c.get('user').id;
    const account = getAccount(db, userId, 'microblog');
    if (!account?.enabled) return c.json({ message: 'Micro.blog is not linked or enabled' }, 400);
    try {
      const items = await listMicroblogDestinations(decryptCredential(account, db), transport);
      return c.json({ items, selected: selectedMicroblogDestination(db, userId) ?? (items.length === 1 ? items[0].uid : null) });
    } catch (error) { return c.json({ message: error instanceof Error ? error.message : 'Could not load blogs' }, 502); }
  });

  app.get('/connectors/microblog/clipping-posts', (c) => {
    const userId = c.get('user').id;
    if (!getAccount(db, userId, 'microblog')?.enabled) return c.json({ items: [] });
    const rows = db.prepare('SELECT document,url,destination,missing,error FROM microblog_clipping_posts WHERE user_id=?').all(userId);
    return c.json({ items: rows.map((row) => ({ ...row, missing: !!row.missing })) });
  });

  app.post('/connectors/microblog/clipping-posts/:document/recreate', async (c) => {
    if (!credentialRequestIsSecure(c, trustProxy, allowHttpLocalhost)) return c.json({ message: CREDENTIAL_HTTPS_REQUIRED }, 400);
    const document = c.req.param('document');
    if (!isValidDocument(document)) return c.json({ message: 'Invalid book' }, 400);
    try { return c.json(await recreateMicroblogClippings(db, c.get('user').id, document, transport)); }
    catch (error) { return c.json({ message: error instanceof Error ? error.message : 'Could not recreate post' }, error instanceof ConnectorOperationError && !error.retryable ? 409 : 502); }
  });

  app.put('/connectors/microblog/destination', async (c) => {
    if (!credentialRequestIsSecure(c, trustProxy, allowHttpLocalhost)) return c.json({ message: CREDENTIAL_HTTPS_REQUIRED }, 400);
    const userId = c.get('user').id;
    const account = getAccount(db, userId, 'microblog');
    if (!account?.enabled) return c.json({ message: 'Micro.blog is not linked or enabled' }, 400);
    const body = await c.req.json().catch(() => null) as { destination?: unknown } | null;
    try {
      const items = await listMicroblogDestinations(decryptCredential(account, db), transport);
      if (!items.some((d) => d.uid === body?.destination)) return c.json({ message: 'Choose an available Micro.blog blog' }, 400);
      if (getAccount(db, userId, 'microblog')?.cred_enc !== account.cred_enc) return c.json({ message: 'Micro.blog account changed; reload its blogs' }, 409);
      const row = db.prepare("SELECT options FROM connector_accounts WHERE user_id=? AND connector_id='microblog'").get(userId) as { options: string | null };
      let values: OptionValues = {};
      try { values = JSON.parse(row.options || '{}'); } catch { /* Recover malformed settings. */ }
      setConnectorOptions(db, userId, 'microblog', { ...values, highlight_blog: body!.destination as string });
      scheduleMicroblogClippings(db, userId);
      return c.json({ destination: body!.destination });
    } catch (error) { return c.json({ message: error instanceof Error ? error.message : 'Could not select blog' }, 502); }
  });

  app.post('/connectors/microblog/clippings/:document/:clippingId', (c) => {
    const user = c.get('user');
    const account = getAccount(db, user.id, 'microblog');
    if (!account?.enabled) return c.json({ message: 'Micro.blog is not linked or enabled' }, 400);
    const document = c.req.param('document');
    const clippingId = c.req.param('clippingId');
    if (!isValidDocument(document) || !isItemId(clippingId)) return c.json({ message: 'Invalid clipping' }, 400);
    const canonical = resolveDocument(db, user.id, document);
    try { selectMicroblogClipping(db, user.id, canonical, clippingId); }
    catch { return c.json({ message: 'Clipping not found' }, 404); }
    const state = db.prepare('SELECT error FROM microblog_clipping_posts WHERE user_id=? AND document=?').get(user.id, canonical) as { error: string | null } | undefined;
    if (state?.error) return c.json({ message: state.error }, 409);
    const queued = scheduleMicroblogClippings(db, user.id, canonical) > 0;
    return c.json({ queued, waiting_for_match: !getMatch(db, user.id, 'microblog', canonical)?.external_id });
  });

  // Change a linked connector's options. Unknown keys and bad values are ignored.
  app.put('/connectors/:id/options', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn?.options) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const user = c.get('user');
    if (!getAccount(db, user.id, conn.id)) {
      return c.json({ code: 2003, message: 'Connector not linked' }, 400);
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    const next: OptionValues = connectorOptions(db, user.id, conn);
    if (conn.id === 'microblog') {
      const destination = selectedMicroblogDestination(db, user.id);
      if (destination) next.highlight_blog = destination;
    }
    for (const o of conn.options) {
      const v = body?.[o.key];
      if (o.choices ? o.choices.some((ch) => ch.value === v) : typeof v === 'boolean') next[o.key] = v as boolean | string;
    }
    withTransaction(db, () => {
      setConnectorOptions(db, user.id, conn.id, next);
      // A kind switched off: drop its queued work so nothing more goes out.
      for (const o of conn.options!) {
        if (o.gates && next[o.key] === false) {
          // The kind column holds the coalesce key, e.g. 'highlight:<clipping id>'.
          db.prepare(`DELETE FROM connector_queue WHERE user_id = ? AND connector_id = ? AND (kind = ? OR kind LIKE ?) AND status = 'pending'`)
            .run(user.id, conn.id, o.gates, `${o.gates}:%`);
        }
      }
    });
    if (conn.id === 'microblog') scheduleMicroblogClippings(db, user.id);
    return c.json({ id: conn.id, option_values: next });
  });

  // "Sync now": backfill this connector with everything already synced.
  // Audiobookshelf first pulls every matched book's position, so newer listening
  // there isn't overwritten by the backfill.
  app.post('/connectors/:id/sync', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const user = c.get('user');
    if (!getAccount(db, user.id, conn.id)) {
      return c.json({ code: 2003, message: 'Connector not linked' }, 400);
    }
    if (conn.id === 'audiobookshelf') {
      // Per-book failures are logged and skipped; a revoked key marks the account needs_reauth.
      const signal = AbortSignal.timeout(60_000);
      const bounded: HttpTransport = (url, init) => transport(url, { ...init,
        signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
      const pulled = await pollConnector(db, user.id, conn.id, bounded, { signal }).catch(() => 0);
      return c.json({ pulled, queued: backfillConnector(db, user.id, conn.id) });
    }
    const queued = backfillConnector(db, user.id, conn.id);
    if (conn.id === 'bookorbit') {
      // Keep an in-progress backfill, but make completed books eligible for reconciliation.
      db.prepare('UPDATE bookorbit_stats_sync SET refreshed_at = 0 WHERE user_id = ?').run(user.id);
      void importBookorbitStats(db, user.id, transport);
    }
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
      if (r.ok) return c.json({ ok: true, position: r.position });
      // No active device: the app opens Spotify, and playback starts there once it's up.
      const retrying = r.reason === 'NO_ACTIVE_DEVICE';
      if (retrying) void playWhenDeviceAppears(b.cred, r.position, transport).catch(() => {});
      return c.json({ ok: false, position: r.position, reason: r.reason, fallback_url: r.fallbackUrl, app_url: r.appUrl, retrying });
    } catch (err) {
      return spotifyFailed(c, b.user.id, err);
    }
  });

  // The Spotify card's refresh: read Spotify now and move this book's progress
  // forward if the listener has, instead of waiting for a device sync or the hourly poll.
  app.post('/connectors/spotify/sync/:document', async (c) => {
    const b = await spotifyBook(c);
    if (b.error) return b.error;
    if (!b.externalId) return c.json({ code: 2003, message: 'Book is not matched on Spotify' }, 404);
    try {
      return c.json({ applied: await pollConnector(db, b.user.id, 'spotify', transport, { document: b.document, throwOnError: true }) });
    } catch (err) {
      return spotifyFailed(c, b.user.id, err);
    }
  });

  // One matched book: pull remote state before queueing local updates.
  app.post('/connectors/:id/sync/:document', async (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn || conn.hidden) return c.json({ message: 'Unknown connector' }, 404);
    const canPull = !!conn.pullProgress && conn.capabilities.read;
    if ((!canPull && !conn.capabilities.write) || (conn.capabilities.read && conn.pullChanges && !canPull)) {
      return c.json({ message: 'This service does not support per-book sync' }, 400);
    }
    const raw = c.req.param('document');
    if (!isValidDocument(raw)) return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    const userId = c.get('user').id;
    const document = resolveDocument(db, userId, raw);
    if (!hasDocumentData(db, userId, document)) return c.json({ message: 'Book not found' }, 404);
    const account = getAccount(db, userId, conn.id);
    if (!account?.enabled || account.status !== 'ok') return c.json({ message: 'Connect this service before syncing this book' }, 400);
    const signal = AbortSignal.timeout(30_000);
    const bounded: HttpTransport = (url, init) => transport(url, { ...init,
      signal: init.signal ? AbortSignal.any([signal, init.signal]) : signal });
    try {
      const match = conn.matchBy === 'document' ? { externalId: document, externalEdition: null } :
        await resolveMatch(db, conn.id, userId, document, bounded);
      if (!match) return c.json({ message: 'Match this book to the service before syncing' }, 400);
      // Await both remote position and highlights before enqueueing any backfill.
      const applied = canPull ? await pollConnector(db, userId, conn.id, bounded, { document, signal, throwOnError: true }) : 0;
      const fresh = getAccount(db, userId, conn.id);
      if (!fresh?.enabled || fresh.status !== 'ok' || fresh.cred_enc !== account.cred_enc ||
          (conn.matchBy !== 'document' && getMatch(db, userId, conn.id, document)?.external_id !== match.externalId)) {
        return c.json({ message: 'Service connection changed; try again' }, 409);
      }
      if (conn.id === 'bookorbit') await importBookorbitStats(db, userId, bounded, { document, force: true, throwOnError: true });
      signal.throwIfAborted();
      const finalAccount = getAccount(db, userId, conn.id);
      const finalMatch = getMatch(db, userId, conn.id, document);
      if (!finalAccount?.enabled || finalAccount.status !== 'ok' || finalAccount.cred_enc !== account.cred_enc ||
          (conn.matchBy !== 'document' && (finalMatch?.external_id !== match.externalId || finalMatch.external_edition !== match.externalEdition))) {
        return c.json({ message: 'Service connection changed; try again' }, 409);
      }
      const queued = backfillConnector(db, userId, conn.id, document);
      if (conn.id !== 'bookorbit') return c.json({ applied, queued });
      const history = db.prepare('SELECT active_generation, cutoff FROM bookorbit_stats_sync WHERE user_id=? AND external_id=?')
        .get(userId, match.externalId);
      return c.json({ applied, queued, history_pending: !history?.active_generation || history.cutoff !== null });
    } catch (err) {
      return c.json({ message: err instanceof Error ? err.message : 'Book sync failed' }, 502);
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
      // Document-keyed services can sync without a metadata match.
      const account = getAccount(db, user.id, conn.id);
      if (!account) return [];
      const m = getMatch(db, user.id, conn.id, document);
      return [
        {
          id: conn.id,
          name: conn.displayName,
          matched: conn.matchBy === 'document' || !!m?.external_id,
          match_by: conn.matchBy ?? 'metadata',
          sync: { read: !!conn.pullProgress && conn.capabilities.read && (conn.id !== 'bookfusion' || m?.source === 'sidecar'), write: conn.capabilities.write,
            enabled: !!account.enabled && account.status === 'ok' },
          external_id: m?.external_id ?? null,
          source: m?.source ?? 'none',
          push_note: m?.push_note ?? null,
        },
      ];
    });
    return c.json({ document, services });
  });

  // Review list: every synced book with its title and this connector's match state.
  // Newest first, 500 per page; pass `next` back as `cursor` for the following page.
  app.get('/connectors/:id/review', (c) => {
    const conn = getConnector(c.req.param('id'));
    if (!conn) return c.json({ code: 2003, message: 'Unknown connector' }, 404);
    const cursor = parseListCursor(c.req.query('cursor'));
    if (cursor === null) return kosyncError(c, 403, 2003, 'Invalid request');
    const user = c.get('user');
    const rows = db
      .prepare(
        `SELECT p.document AS document, d.title AS title, d.author AS author,
                m.external_id AS external_id, m.source AS source, m.confidence AS confidence,
                m.push_note AS push_note, p.updated_at AS updated_at
         FROM progress p
         LEFT JOIN documents d ON d.user_id = p.user_id AND d.document = p.document
         LEFT JOIN connector_matches m ON m.user_id = p.user_id AND m.connector_id = ? AND m.document = p.document
         WHERE p.user_id = ?
           AND p.updated_at = (
             SELECT MAX(p2.updated_at) FROM progress p2 WHERE p2.user_id = p.user_id AND p2.document = p.document
           )
           AND p.device_id = (
             SELECT MIN(p3.device_id) FROM progress p3
             WHERE p3.user_id = p.user_id AND p3.document = p.document AND p3.updated_at = p.updated_at
           )
           AND (? IS NULL OR p.updated_at < ? OR (p.updated_at = ? AND p.document < ?))
         ORDER BY p.updated_at DESC, p.document DESC
         LIMIT ?`
      )
      .all(conn.id, user.id, cursor?.at ?? null, cursor?.at ?? null, cursor?.at ?? null, cursor?.document ?? null, REVIEW_PAGE + 1) as unknown as {
      document: string;
      updated_at: number;
      title: string | null;
      author: string | null;
      external_id: string | null;
      source: string | null;
      confidence: number | null;
      push_note: string | null;
    }[];
    const more = rows.length > REVIEW_PAGE;
    if (more) rows.pop();
    return c.json({
      connector: conn.id,
      next: more ? listCursor(rows[rows.length - 1]) : null,
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
