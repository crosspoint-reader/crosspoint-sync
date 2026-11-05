import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { withTransaction, type DB } from '../db/db.js';
import type { Config } from '../config.js';
import type { AppEnv } from '../auth/middleware.js';
import { hashKey, verifyKey } from '../auth/password.js';
import { invalidateAuthCache, rateLimiter, USERS_BY_NAME_SQL } from '../auth/middleware.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  signSession,
  verifySession,
} from '../auth/session.js';
import { nowSeconds } from '../models/sync.js';
import { USERNAME_RE } from './kosync.js';
import { encryptSecret, secretsEnabled } from '../crypto/secrets.js';

/**
 * Master ("general login") accounts. This is the website identity, kept separate
 * from the kosync device credential (see account.ts for linking a kosync sync
 * account under a master account). There are no passwords: signup issues a
 * master token (shown once) that IS the web credential. We store
 * PBKDF2(MD5(token)); the session cookie carries the master account id.
 *
 * Token format: xp1_<accountId>_<hex>. The embedded id lets login work from the
 * token alone. This token is NOT a kosync secret and never touches a device.
 */

const TOKEN_RE = /^xp1_(\d+)_[0-9a-f]{32}$/;

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

/** Issue a new master token for the account (revoking the old one) and return it. */
export function issueMasterToken(db: DB, accountId: number): string {
  const token = `xp1_${accountId}_${crypto.randomBytes(16).toString('hex')}`;
  db.prepare('UPDATE accounts SET token_hash = ?, token_enc = ? WHERE id = ?')
    .run(hashKey(md5(token)), secretsEnabled() ? encryptSecret(token) : null, accountId);
  return token;
}

/** The master account owning this sync account, creating and linking one if it has none. */
export function claimMasterAccount(db: DB, user: { id: number; username: string; account_id: number | null }): number {
  if (user.account_id) return user.account_id;
  let handle = user.username;
  if (!USERNAME_RE.test(handle) || db.prepare('SELECT 1 FROM accounts WHERE handle = ?').get(handle)) {
    const base = (handle.replace(/[^A-Za-z0-9._@+-]/g, '').slice(0, 56) || 'user');
    handle = `${base}-${crypto.randomBytes(2).toString('hex')}`;
  }
  const info = db
    .prepare('INSERT INTO accounts (handle, token_hash, created_at) VALUES (?, ?, ?)')
    .run(handle, '', nowSeconds());
  const accountId = Number(info.lastInsertRowid);
  issueMasterToken(db, accountId);
  db.prepare('UPDATE users SET account_id = ? WHERE id = ?').run(accountId, user.id);
  return accountId;
}

/**
 * Give every sync account without one a master account (and so a recovery
 * token). Idempotent. Batches share one commit (one fsync, not three per user)
 * and yield between, so a big first run doesn't stall requests.
 */
export async function backfillMasterAccounts(db: DB, batch = 200): Promise<number> {
  let total = 0;
  for (;;) {
    const orphans = db.prepare('SELECT id, username, account_id FROM users WHERE account_id IS NULL LIMIT ?').all(batch) as {
      id: number; username: string; account_id: null;
    }[];
    if (!orphans.length) return total;
    withTransaction(db, () => { for (const u of orphans) claimMasterAccount(db, u); });
    total += orphans.length;
    await new Promise((r) => setImmediate(r));
  }
}

/** The master account id a well-formed, valid token belongs to, else null. */
function tokenAccount(db: DB, token: string | null): number | null {
  const parsed = token?.match(TOKEN_RE);
  if (!token || !parsed) return null;
  const row = db
    .prepare('SELECT token_hash FROM accounts WHERE id = ?')
    .get(Number(parsed[1])) as { token_hash: string } | undefined;
  return row && verifyKey(md5(token), row.token_hash) ? Number(parsed[1]) : null;
}

function setSessionCookie(c: Context<AppEnv>, accountId: number, basePath: string) {
  const proto = c.req.header('x-forwarded-proto');
  const secure = proto ? proto.split(',')[0].trim() === 'https' : false;
  setCookie(c, SESSION_COOKIE, signSession(accountId), {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: basePath || '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function authRoutes(db: DB, config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Create a master account: pick a handle, receive a login token (shown once).
  app.post('/signup', rateLimiter(config.authRateLimitPerMinute), async (c) => {
    if (config.registrationDisabled) {
      return c.json({ error: 'Registration is disabled' }, 403);
    }
    let handle: string | null = null;
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      handle = typeof body.handle === 'string' ? body.handle.trim() : null;
    } catch {
      /* validation below */
    }
    if (!handle || !USERNAME_RE.test(handle)) {
      return c.json({ error: 'Invalid handle' }, 400);
    }
    if (db.prepare('SELECT 1 FROM accounts WHERE handle = ?').get(handle)) {
      return c.json({ error: 'Handle is already taken' }, 409);
    }
    const info = db
      .prepare('INSERT INTO accounts (handle, token_hash, created_at) VALUES (?, ?, ?)')
      .run(handle, '', nowSeconds());
    const accountId = Number(info.lastInsertRowid);
    const token = issueMasterToken(db, accountId);
    setSessionCookie(c, accountId, config.basePath);
    return c.json({ handle, token });
  });

  // Web login: paste the master token, get a session cookie.
  app.post('/login', rateLimiter(config.authRateLimitPerMinute), async (c) => {
    let token: string | null = null;
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      token = typeof body.token === 'string' ? body.token.trim() : null;
    } catch {
      /* validation below */
    }
    const accountId = tokenAccount(db, token);
    if (!accountId) return c.json({ error: 'Invalid token' }, 401);
    setSessionCookie(c, accountId, config.basePath);
    return c.json({ ok: true });
  });

  // App account recovery: a valid master token sets a new password (as its MD5
  // key, like a reader sends) on the linked sync account.
  app.post('/recover', rateLimiter(config.authRateLimitPerMinute), async (c) => {
    let token: string | null = null;
    let key: unknown;
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      token = typeof body.token === 'string' ? body.token.trim() : null;
      key = body.key;
    } catch {
      /* validation below */
    }
    if (typeof key !== 'string' || !/^[0-9a-f]{32}$/i.test(key)) {
      return c.json({ error: 'Send the new password as its MD5 (key)' }, 400);
    }
    const accountId = tokenAccount(db, token);
    if (!accountId) return c.json({ error: 'Invalid recovery token' }, 401);
    const user = db
      .prepare('SELECT id, username FROM users WHERE account_id = ?')
      .get(accountId) as { id: number; username: string } | undefined;
    if (!user) return c.json({ error: 'No sync account is linked to this token' }, 404);
    db.prepare('UPDATE users SET key_hash = ? WHERE id = ?').run(hashKey(key.toLowerCase()), user.id);
    invalidateAuthCache(user.username);
    return c.json({ username: user.username });
  });

  // Sign in with the kosync sync account (username + password). This is the
  // recovery path for a lost login token: prove ownership of the sync account
  // and we log you into the master account that owns it. If the sync account
  // isn't linked to any master yet (e.g. created on a device), we create one and
  // link it, so device-first users get a web account too.
  app.post('/login-kosync', rateLimiter(config.authRateLimitPerMinute), async (c) => {
    let username: string | null = null;
    let password: string | null = null;
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      username = typeof body.username === 'string' ? body.username.trim() : null;
      password = typeof body.password === 'string' ? body.password : null;
    } catch {
      /* validation below */
    }
    if (!username || !password) {
      return c.json({ error: 'Username and password required' }, 400);
    }
    const rows = db.prepare(USERS_BY_NAME_SQL).all(username, username) as { id: number; username: string; account_id: number | null; key_hash: string }[];
    const row = rows.find((r) => verifyKey(md5(password!), r.key_hash));
    if (!row) {
      return c.json({ error: 'Invalid sync account credentials' }, 401);
    }
    setSessionCookie(c, claimMasterAccount(db, row), config.basePath);
    return c.json({ ok: true });
  });

  app.post('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: config.basePath || '/' });
    return c.json({ ok: true });
  });

  app.get('/me', (c) => {
    const session = verifySession(getCookie(c, SESSION_COOKIE));
    if (!session) return c.json({ error: 'Not signed in' }, 401);
    const row = db
      .prepare('SELECT handle FROM accounts WHERE id = ?')
      .get(session.uid) as { handle: string } | undefined;
    if (!row) return c.json({ error: 'Not signed in' }, 401);
    return c.json({ handle: row.handle });
  });

  // Rotate the master login token (revokes the old one).
  app.post('/token/rotate', (c) => {
    const session = verifySession(getCookie(c, SESSION_COOKIE));
    if (!session) return c.json({ error: 'Not signed in' }, 401);
    if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(session.uid)) {
      return c.json({ error: 'Not signed in' }, 401);
    }
    return c.json({ token: issueMasterToken(db, session.uid) });
  });

  return app;
}
