import crypto from 'node:crypto';
import { Hono } from 'hono';
import { deleteCookie } from 'hono/cookie';
import { withTransaction, type DB } from '../db/db.js';
import type { Config } from '../config.js';
import { masterAuth, type AppEnv } from '../auth/middleware.js';
import { hashKey, verifyKey } from '../auth/password.js';
import { invalidateAuthCache } from '../auth/middleware.js';
import { SESSION_COOKIE } from '../auth/session.js';
import { nowSeconds } from '../models/sync.js';
import { USERNAME_RE } from './kosync.js';

/** Permanently delete a kosync user and every row of its reading data. */
function deleteKosyncUserData(db: DB, userId: number, username: string): void {
  withTransaction(db, () => {
    for (const table of [
      'connector_queue',
      'connector_matches',
      'connector_accounts',
      'stats_device_book',
      'stats_device_global',
      'clippings',
      'bookmarks',
      'documents',
      'progress',
      'progress_samples',
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(userId);
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
  });
  invalidateAuthCache(username);
}

/**
 * Manage the CrossPoint Sync (KOSync) account linked under a master account.
 * This is a standard KOReader-compatible sync account: the user picks a username
 * and password, exactly like any kosync server, and enters them in their
 * reader's KOReader Sync settings. It is where reading data + connectors live.
 * A master account owns at most one; it can create a fresh one or link an
 * existing (e.g. device-created) one by proving ownership with its password.
 *
 * The reader sends MD5(password); we store PBKDF2(MD5(password)) in
 * users.key_hash, same as any kosync password. The plaintext is never stored.
 */

function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

export function accountRoutes(db: DB, config: Config): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use('*', masterAuth(db));

  // Status of this account's linked kosync sync identity.
  app.get('/kosync', (c) => {
    const account = c.get('account');
    const row = db
      .prepare('SELECT username FROM users WHERE account_id = ?')
      .get(account.id) as { username: string } | undefined;
    return c.json({ linked: !!row, username: row?.username ?? null });
  });

  // Create a fresh CrossPoint Sync (KOSync) account with a user-chosen username
  // and password, then link it. Standard kosync: the reader uses the same creds.
  app.post('/kosync', async (c) => {
    const account = c.get('account');
    if (db.prepare('SELECT 1 FROM users WHERE account_id = ?').get(account.id)) {
      return c.json({ error: 'A sync account is already linked' }, 409);
    }
    let username: string | null = null;
    let password: string | null = null;
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      username = typeof body.username === 'string' ? body.username.trim() : null;
      password = typeof body.password === 'string' ? body.password : null;
    } catch {
      /* validation below */
    }
    if (!username || !USERNAME_RE.test(username)) {
      return c.json({ error: 'Invalid username' }, 400);
    }
    if (!password || password.length < 1 || password.length > 256) {
      return c.json({ error: 'Invalid password' }, 400);
    }
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      return c.json({ error: 'That sync username is taken' }, 409);
    }
    db.prepare(
      'INSERT INTO users (username, key_hash, account_id, created_at) VALUES (?, ?, ?, ?)'
    ).run(username, hashKey(md5(password)), account.id, nowSeconds());
    return c.json({ username });
  });

  // Link an existing kosync account by proving ownership with its password.
  app.put('/kosync', async (c) => {
    const account = c.get('account');
    if (db.prepare('SELECT 1 FROM users WHERE account_id = ?').get(account.id)) {
      return c.json({ error: 'A sync account is already linked' }, 409);
    }
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
    const row = db
      .prepare('SELECT id, key_hash, account_id FROM users WHERE username = ?')
      .get(username) as { id: number; key_hash: string; account_id: number | null } | undefined;
    // The device sends MD5(password); the web form takes the plain password.
    if (!row || !verifyKey(md5(password), row.key_hash)) {
      return c.json({ error: 'Invalid sync account credentials' }, 401);
    }
    if (row.account_id && row.account_id !== account.id) {
      return c.json({ error: 'That sync account is linked to another login' }, 409);
    }
    db.prepare('UPDATE users SET account_id = ? WHERE id = ?').run(account.id, row.id);
    return c.json({ linked: true, username });
  });

  // Detach the kosync account (data stays; it just becomes an orphan again).
  app.delete('/kosync', (c) => {
    const account = c.get('account');
    db.prepare('UPDATE users SET account_id = NULL WHERE account_id = ?').run(account.id);
    return c.json({ linked: false });
  });

  // Permanently delete the linked kosync account and ALL its reading data.
  app.delete('/kosync/data', (c) => {
    const account = c.get('account');
    const row = db
      .prepare('SELECT id, username FROM users WHERE account_id = ?')
      .get(account.id) as { id: number; username: string } | undefined;
    if (!row) return c.json({ error: 'No sync account linked' }, 409);
    deleteKosyncUserData(db, row.id, row.username);
    return c.json({ deleted: true });
  });

  // Permanently delete the master account, its linked kosync account, and all
  // reading data. Signs the browser out.
  app.delete('/', (c) => {
    const account = c.get('account');
    const kosync = db
      .prepare('SELECT id, username FROM users WHERE account_id = ?')
      .get(account.id) as { id: number; username: string } | undefined;
    if (kosync) deleteKosyncUserData(db, kosync.id, kosync.username);
    db.prepare('DELETE FROM accounts WHERE id = ?').run(account.id);
    deleteCookie(c, SESSION_COOKIE, { path: '/' });
    return c.json({ deleted: true });
  });

  // Change the password of the linked kosync account (reader must be updated).
  app.post('/kosync/password', async (c) => {
    const account = c.get('account');
    const row = db
      .prepare('SELECT id, username FROM users WHERE account_id = ?')
      .get(account.id) as { id: number; username: string } | undefined;
    if (!row) return c.json({ error: 'No sync account linked' }, 409);
    let password: string | null = null;
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      password = typeof body.password === 'string' ? body.password : null;
    } catch {
      /* validation below */
    }
    if (!password || password.length < 1 || password.length > 256) {
      return c.json({ error: 'Invalid password' }, 400);
    }
    db.prepare('UPDATE users SET key_hash = ? WHERE id = ?').run(hashKey(md5(password)), row.id);
    invalidateAuthCache(row.username);
    return c.json({ username: row.username });
  });

  return app;
}
