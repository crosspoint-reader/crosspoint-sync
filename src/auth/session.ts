import crypto from 'node:crypto';
import type { DB } from '../db/db.js';

/**
 * Stateless signed session cookies for the web account. Format:
 *   base64url(JSON{uid, exp}) + '.' + base64url(HMAC-SHA256(payload))
 * No session table - the HMAC makes the cookie unforgeable. Signed with
 * SESSION_SECRET (falls back to TOKEN_ENC_KEY, then a key generated once and kept
 * in the database by loadSessionSecret, so zero-config sign-ins survive restarts).
 */

const COOKIE_NAME = 'cp_session';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

let cachedSecret: Buffer | undefined;
let warnedEphemeral = false;

function sessionSecret(env: NodeJS.ProcessEnv = process.env): Buffer {
  if (cachedSecret) return cachedSecret;
  const raw = env.SESSION_SECRET || env.TOKEN_ENC_KEY;
  if (raw) {
    cachedSecret = crypto.createHash('sha256').update(raw).digest();
  } else {
    cachedSecret = crypto.randomBytes(32);
    if (!warnedEphemeral) {
      warnedEphemeral = true;
      console.warn(
        JSON.stringify({
          msg: 'no SESSION_SECRET/TOKEN_ENC_KEY set; using an ephemeral key; sessions drop on restart',
        })
      );
    }
  }
  return cachedSecret;
}

/** Zero-config: generate a session key once, store it in the DB, reuse it on every boot. */
export function loadSessionSecret(db: DB, env: NodeJS.ProcessEnv = process.env): void {
  if (env.SESSION_SECRET || env.TOKEN_ENC_KEY) return;
  db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)').run(
    'session_secret',
    crypto.randomBytes(32).toString('hex')
  );
  const row = db.prepare("SELECT value FROM settings WHERE key = 'session_secret'").get() as {
    value: string;
  };
  env.SESSION_SECRET = row.value;
  cachedSecret = undefined;
}

export function resetSessionSecretCache(): void {
  cachedSecret = undefined;
}

export const SESSION_COOKIE = COOKIE_NAME;

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function signSession(
  userId: number,
  ttlSeconds = DEFAULT_TTL_SECONDS,
  env: NodeJS.ProcessEnv = process.env
): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = b64url(Buffer.from(JSON.stringify({ uid: userId, exp })));
  const sig = b64url(crypto.createHmac('sha256', sessionSecret(env)).update(payload).digest());
  return `${payload}.${sig}`;
}

export function verifySession(
  token: string | undefined,
  env: NodeJS.ProcessEnv = process.env
): { uid: number } | null {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64url(
    crypto.createHmac('sha256', sessionSecret(env)).update(payload).digest()
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      uid: number;
      exp: number;
    };
    if (typeof data.uid !== 'number' || typeof data.exp !== 'number') return null;
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return { uid: data.uid };
  } catch {
    return null;
  }
}

export const SESSION_TTL_SECONDS = DEFAULT_TTL_SECONDS;
