import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { AccountImportError, exportAccountData, importAccountData } from '../../models/account-data.js';
import type { DB } from '../../db/db.js';
import { invalidateAuthCache, type AppEnv } from '../../auth/middleware.js';
import { hashKey } from '../../auth/password.js';
import { deleteKosyncUserData } from '../account.js';
import { autoPauseDays, setAutoPauseDays } from '../../models/pause.js';

/**
 * The signed-in sync account, for the app (which signs in with the sync
 * username/password, not a website session): change its password, clear its
 * reading data, or delete it.
 */
export function meRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/account/export', (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Content-Disposition', 'attachment; filename="crosspoint-sync-account.json"');
    return c.json(exportAccountData(db, c.get('user').id));
  });

  app.post('/account/import', bodyLimit({ maxSize: 50 * 1024 * 1024 }), async (c) => {
    let body;
    try { body = await c.req.json(); }
    catch { return c.json({ message: 'Invalid JSON archive.' }, 400); }
    if (!body || typeof body !== 'object' || !['empty', 'replace'].includes(body.mode)) {
      return c.json({ message: 'Choose import mode: empty or replace.' }, 400);
    }
    try {
      return c.json(importAccountData(db, c.get('user').id, body.archive, body.mode === 'replace'));
    } catch (error) {
      if (error instanceof AccountImportError) return c.json({ message: error.message }, error.status);
      throw error;
    }
  });

  // New password, as the reader would send it: MD5 of the plain password.
  app.post('/account/password', async (c) => {
    const user = c.get('user');
    let key: unknown;
    try {
      key = ((await c.req.json()) as Record<string, unknown>).key;
    } catch {
      /* validated below */
    }
    if (typeof key !== 'string' || !/^[0-9a-f]{32}$/i.test(key)) {
      return c.json({ code: 2003, message: 'Send the new password as its MD5 (key)' }, 400);
    }
    db.prepare('UPDATE users SET key_hash = ? WHERE id = ?').run(hashKey(key.toLowerCase()), user.id);
    invalidateAuthCache(user.username);
    return c.json({ username: user.username });
  });

  // Days without progress before a book in progress is paused (0 = never).
  app.get('/account/auto-pause', (c) => c.json({ days: autoPauseDays(db, c.get('user').id) }));

  app.put('/account/auto-pause', async (c) => {
    const user = c.get('user');
    let days: unknown;
    try {
      days = ((await c.req.json()) as Record<string, unknown>).days;
    } catch {
      /* validated below */
    }
    if (days !== null && !(Number.isInteger(days) && (days as number) >= 0 && (days as number) <= 365)) {
      return c.json({ code: 2003, message: 'Send { days: 0-365 } (0 = never, null = default)' }, 400);
    }
    setAutoPauseDays(db, user.id, days as number | null);
    return c.json({ days: autoPauseDays(db, user.id) });
  });

  // Wipe reading data (progress, clippings, stats, linked services) but keep the account.
  app.delete('/account/data', (c) => {
    const user = c.get('user');
    deleteKosyncUserData(db, user.id, user.username, { keepUser: true });
    return c.json({ deleted: true });
  });

  // Delete the account and everything in it.
  app.delete('/account', (c) => {
    const user = c.get('user');
    deleteKosyncUserData(db, user.id, user.username);
    return c.json({ deleted: true });
  });

  return app;
}
