import crypto from 'node:crypto';
import { Hono, type Context } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { DB } from '../db/db.js';
import type { Config } from '../config.js';
import type { AppEnv } from '../auth/middleware.js';
import { hashKey, verifyKey } from '../auth/password.js';
import { rateLimiter } from '../auth/middleware.js';
import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  signSession,
  verifySession,
} from '../auth/session.js';
import { nowSeconds } from '../models/sync.js';
import { USERNAME_RE } from './kosync.js';

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

function masterToken(accountId: number): string {
  return `xp1_${accountId}_${crypto.randomBytes(16).toString('hex')}`;
}

function setSessionCookie(c: Context<AppEnv>, accountId: number) {
  const proto = c.req.header('x-forwarded-proto');
  const secure = proto ? proto.split(',')[0].trim() === 'https' : false;
  setCookie(c, SESSION_COOKIE, signSession(accountId), {
    httpOnly: true,
    sameSite: 'Lax',
    secure,
    path: '/',
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
    const secret = crypto.randomBytes(16).toString('hex');
    const info = db
      .prepare('INSERT INTO accounts (handle, token_hash, created_at) VALUES (?, ?, ?)')
      .run(handle, '', nowSeconds());
    const accountId = Number(info.lastInsertRowid);
    const token = `xp1_${accountId}_${secret}`;
    db.prepare('UPDATE accounts SET token_hash = ? WHERE id = ?').run(hashKey(md5(token)), accountId);
    setSessionCookie(c, accountId);
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
    const parsed = token?.match(TOKEN_RE);
    if (!token || !parsed) return c.json({ error: 'Invalid token' }, 401);
    const accountId = Number(parsed[1]);
    const row = db
      .prepare('SELECT token_hash FROM accounts WHERE id = ?')
      .get(accountId) as { token_hash: string } | undefined;
    if (!row || !verifyKey(md5(token), row.token_hash)) {
      return c.json({ error: 'Invalid token' }, 401);
    }
    setSessionCookie(c, accountId);
    return c.json({ ok: true });
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
    const byName = db.prepare('SELECT id, account_id, key_hash FROM users WHERE username = ?');
    const row = (byName.get(username) ?? byName.get(username.toLowerCase())) as { id: number; account_id: number | null; key_hash: string } | undefined;
    if (!row || !verifyKey(md5(password), row.key_hash)) {
      return c.json({ error: 'Invalid sync account credentials' }, 401);
    }
    let accountId = row.account_id;
    if (!accountId) {
      // Claim: create a master account for this sync identity and link it.
      let handle = username;
      if (!USERNAME_RE.test(handle) || db.prepare('SELECT 1 FROM accounts WHERE handle = ?').get(handle)) {
        const base = (handle.replace(/[^A-Za-z0-9._@+-]/g, '').slice(0, 56) || 'user');
        handle = `${base}-${crypto.randomBytes(2).toString('hex')}`;
      }
      const info = db
        .prepare('INSERT INTO accounts (handle, token_hash, created_at) VALUES (?, ?, ?)')
        .run(handle, '', nowSeconds());
      accountId = Number(info.lastInsertRowid);
      const token = `xp1_${accountId}_${crypto.randomBytes(16).toString('hex')}`;
      db.prepare('UPDATE accounts SET token_hash = ? WHERE id = ?').run(hashKey(md5(token)), accountId);
      db.prepare('UPDATE users SET account_id = ? WHERE id = ?').run(accountId, row.id);
    }
    setSessionCookie(c, accountId);
    return c.json({ ok: true });
  });

  app.post('/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
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
    const token = masterToken(session.uid);
    db.prepare('UPDATE accounts SET token_hash = ? WHERE id = ?').run(
      hashKey(md5(token)),
      session.uid
    );
    return c.json({ token });
  });

  return app;
}
