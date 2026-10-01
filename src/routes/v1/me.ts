import { Hono } from 'hono';
import type { DB } from '../../db/db.js';
import { invalidateAuthCache, type AppEnv } from '../../auth/middleware.js';
import { hashKey } from '../../auth/password.js';
import { deleteKosyncUserData } from '../account.js';

/**
 * The signed-in sync account, for the app (which signs in with the sync
 * username/password, not a website session): change its password, clear its
 * reading data, or delete it.
 */
export function meRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

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
