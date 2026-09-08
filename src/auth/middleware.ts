import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { DB } from '../db/db.js';
import { md5Hex, verifyKey } from './password.js';
import { SESSION_COOKIE, verifySession } from './session.js';

export interface AuthedUser {
  id: number;
  username: string;
}

export interface AuthedAccount {
  id: number;
  handle: string;
}

export type AppEnv = {
  Bindings: {
    /** Present when served by @hono/node-server; omitted by Hono's in-memory test helper. */
    incoming?: { socket?: { remoteAddress?: string } };
  };
  Variables: {
    /** The kosync sync identity that owns the reading data (device or resolved from web session). */
    user: AuthedUser;
    /** The master ("general login") account, set on web-session routes. */
    account: AuthedAccount;
  };
};

/** kosync-style error bodies; firmware already parses these shapes. */
export function kosyncError(c: Context, status: 401 | 402 | 403, code: number, message: string) {
  return c.json({ code, message }, status);
}

// Verifying PBKDF2 on every request is wasteful; cache successful (user, key) pairs.
const verifiedCache = new Map<string, string>(); // username -> md5Key
const VERIFIED_CACHE_MAX = 10_000;

export function invalidateAuthCache(username: string): void {
  verifiedCache.delete(username);
}

export function authMiddleware(db: DB): MiddlewareHandler<AppEnv> {
  const getUser = db.prepare('SELECT id, username, key_hash FROM users WHERE username = ?');
  return async (c, next) => {
    const username = c.req.header('x-auth-user');
    const key = c.req.header('x-auth-key');
    if (!username || !key) {
      return kosyncError(c, 401, 2001, 'Unauthorized');
    }
    const row = getUser.get(username) as
      | { id: number; username: string; key_hash: string }
      | undefined;
    if (!row) {
      return kosyncError(c, 401, 2001, 'Unauthorized');
    }
    if (verifiedCache.get(username) !== key) {
      // Stock kosync clients send x-auth-key as MD5(password); some third-party
      // clients (e.g. BookOrbit) send the raw password. Stored hashes are always
      // PBKDF2 of the MD5 form, so fall back to hashing the key before rejecting.
      if (!verifyKey(key, row.key_hash) && !verifyKey(md5Hex(key), row.key_hash)) {
        return kosyncError(c, 401, 2001, 'Unauthorized');
      }
      if (verifiedCache.size >= VERIFIED_CACHE_MAX) {
        verifiedCache.clear();
      }
      verifiedCache.set(username, key);
    }
    c.set('user', { id: row.id, username: row.username });
    await next();
  };
}

/**
 * Require a valid master ("general login") session cookie. Sets `account`.
 * Used for the /account management surface (kosync link, master token rotate).
 */
export function masterAuth(db: DB): MiddlewareHandler<AppEnv> {
  const getAccount = db.prepare('SELECT id, handle FROM accounts WHERE id = ?');
  return async (c, next) => {
    const session = verifySession(getCookie(c, SESSION_COOKIE));
    if (!session) return kosyncError(c, 401, 2001, 'Not signed in');
    const row = getAccount.get(session.uid) as { id: number; handle: string } | undefined;
    if (!row) return kosyncError(c, 401, 2001, 'Not signed in');
    c.set('account', { id: row.id, handle: row.handle });
    await next();
  };
}

/**
 * Accept EITHER a web session cookie OR the device x-auth headers, resolving to
 * the kosync sync identity that owns the reading data. Used for the /api/v1
 * surface so both the browser and the firmware reach the same endpoints:
 *  - device: x-auth headers -> the kosync user directly.
 *  - web: master session cookie -> the account's linked native kosync user.
 * A signed-in master account with no kosync account linked yet gets 409 (the
 * web UI prompts to create/link one before showing data).
 */
export function sessionOrKeyAuth(db: DB): MiddlewareHandler<AppEnv> {
  const headerAuth = authMiddleware(db);
  const getAccount = db.prepare('SELECT id, handle FROM accounts WHERE id = ?');
  const getKosyncForAccount = db.prepare(
    'SELECT id, username FROM users WHERE account_id = ?'
  );
  return async (c, next) => {
    const session = verifySession(getCookie(c, SESSION_COOKIE));
    if (session) {
      const account = getAccount.get(session.uid) as { id: number; handle: string } | undefined;
      if (account) {
        c.set('account', account);
        const kosync = getKosyncForAccount.get(account.id) as
          | { id: number; username: string }
          | undefined;
        if (!kosync) {
          return c.json({ code: 2005, message: 'No sync account linked' }, 409);
        }
        c.set('user', kosync);
        return next();
      }
    }
    return headerAuth(c, next);
  };
}

/** Minimal in-memory per-IP fixed-window rate limiter. */
export function rateLimiter(limitPerMinute: number): MiddlewareHandler {
  const hits = new Map<string, { windowStart: number; count: number }>();
  return async (c, next) => {
    if (limitPerMinute <= 0) return next();
    const ip =
      c.req.header('cf-connecting-ip') ??
      c.req.header('x-forwarded-for')?.split(',')[0].trim() ??
      'unknown';
    const now = Date.now();
    const entry = hits.get(ip);
    if (!entry || now - entry.windowStart >= 60_000) {
      if (hits.size > 50_000) hits.clear();
      hits.set(ip, { windowStart: now, count: 1 });
    } else {
      entry.count++;
      if (entry.count > limitPerMinute) {
        return c.json({ code: 2001, message: 'Too many requests' }, 429);
      }
    }
    await next();
  };
}
