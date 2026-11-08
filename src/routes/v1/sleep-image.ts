import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from '../../auth/middleware.js';
import type { DB } from '../../db/db.js';
import { MAX_BACKGROUND_BYTES, parseSleepOptions, sleepMetrics, SleepImageError } from '../../models/sleep-image.js';
import { normalizeBackground, renderSleepImage } from '../../render/sleep-image.js';

export function sleepImageRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const path = '/stats/sleep-image';
  const background = (userId: number) => {
    const row = db.prepare('SELECT png FROM sleep_backgrounds WHERE user_id=?').get(userId);
    return row ? Buffer.from(row.png as Uint8Array) : undefined;
  };
  for (const match of [path, path + '/*']) app.use(match, async (c, next) => {
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    await next();
  });

  app.get(path + '/status', c => c.json({ version: 1, background: !!background(c.get('user').id) }));
  app.get(path + '/background', c => {
    const png = background(c.get('user').id);
    return png ? c.body(new Uint8Array(png), 200, { 'Content-Type': 'image/png' }) : c.json({ message: 'No background uploaded.' }, 404);
  });
  app.put(path + '/background', bodyLimit({ maxSize: MAX_BACKGROUND_BYTES }), async c => {
    if (c.req.header('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'image/png') return c.json({ message: 'Upload a PNG background.' }, 400);
    try {
      const png = normalizeBackground(Buffer.from(await c.req.arrayBuffer()));
      db.prepare('INSERT INTO sleep_backgrounds (user_id,png) VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET png=excluded.png').run(c.get('user').id, png);
      return c.json({ background: true });
    } catch (error) {
      if (error instanceof SleepImageError) return c.json({ message: error.message }, 400);
      throw error;
    }
  });
  app.delete(path + '/background', c => {
    db.prepare('DELETE FROM sleep_backgrounds WHERE user_id=?').run(c.get('user').id);
    return c.json({ background: false });
  });
  app.get(path, c => {
    try {
      const options = parseSleepOptions(c.req.query());
      const stats = sleepMetrics(db, c.get('user').id, options.timezone, c.req.header('X-Sleep-Percent'));
      const result = renderSleepImage(stats, options, options.mode === 'custom' ? background(c.get('user').id) : undefined);
      return c.body(new Uint8Array(result.bytes), 200, { 'Content-Type': result.contentType });
    } catch (error) {
      if (error instanceof SleepImageError) return c.json({ message: error.message }, 400);
      throw error;
    }
  });
  return app;
}
