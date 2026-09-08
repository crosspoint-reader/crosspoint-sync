import crypto from 'node:crypto';

const ITERATIONS = 10_000;
const KEY_LEN = 32;
const DIGEST = 'sha256';

/**
 * The secret we receive is the kosync auth key: MD5(password), a 32-hex string.
 * We store a salted PBKDF2 of it so a leaked DB can't be reversed with rainbow tables.
 * Format is self-describing so iterations can be raised later: pbkdf2$<iters>$<salt>$<hash>
 */
export function hashKey(md5Key: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(md5Key, salt, ITERATIONS, KEY_LEN, DIGEST)
    .toString('hex');
  return `pbkdf2$${ITERATIONS}$${salt}$${hash}`;
}

/** A kosync auth key: MD5(password), lowercase or uppercase 32-hex. */
export function looksLikeMd5(value: string): boolean {
  return /^[a-f0-9]{32}$/i.test(value);
}

export function md5Hex(value: string): string {
  return crypto.createHash('md5').update(value, 'utf8').digest('hex');
}

export function verifyKey(md5Key: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  if (!Number.isInteger(iterations) || iterations <= 0) return false;
  const hash = crypto
    .pbkdf2Sync(md5Key, salt, iterations, KEY_LEN, DIGEST)
    .toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
