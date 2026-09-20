import type { ProgressRefresh } from '../../connectors/refresh.js';
import { Hono } from 'hono';
import type { DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { isValidDocument, parseProgressBody, upsertProgress } from '../kosync.js';
import { deleteDocumentData, hasDocumentData } from '../../models/document.js';
import { fanOutProgress } from '../../connectors/fanout.js';

export function progressRoutes(db: DB, refreshProgress: ProgressRefresh = async () => {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.put('/progress', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    const parsed = parseProgressBody(user.id, body);
    if (!parsed.ok) {
      return kosyncError(c, 403, parsed.code, parsed.message);
    }
    upsertProgress(db, parsed.record);
    fanOutProgress(db, user.id, parsed.record.document, parsed.record.percentage, parsed.record.updatedAt, parsed.record.progress, parsed.record.position);
    return c.json({ document: parsed.record.document, timestamp: parsed.record.updatedAt });
  });

  // List every synced document with its newest progress (joined with any known
  // metadata) - lets clients and UIs discover documents without knowing hashes.
  app.get('/progress', (c) => {
    const user = c.get('user');
    const limitRaw = Number(c.req.query('limit') ?? 100);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 100;
    const rows = db
      .prepare(
        `SELECT p.document, p.device_id, p.device, p.percentage, p.progress, p.updated_at,
                d.title, d.author, d.filename
         FROM progress p
         LEFT JOIN documents d ON d.user_id = p.user_id AND d.document = p.document
         WHERE p.user_id = ?
           AND p.updated_at = (
             SELECT MAX(p2.updated_at) FROM progress p2
             WHERE p2.user_id = p.user_id AND p2.document = p.document
           )
           AND p.device_id = (
             SELECT MIN(p3.device_id) FROM progress p3
             WHERE p3.user_id = p.user_id AND p3.document = p.document
               AND p3.updated_at = p.updated_at
           )
         ORDER BY p.updated_at DESC
         LIMIT ?`
      )
      .all(user.id, limit) as unknown as {
      document: string;
      device_id: string;
      device: string;
      percentage: number;
      progress: string;
      updated_at: number;
      title: string | null;
      author: string | null;
      filename: string | null;
    }[];
    return c.json({
      items: rows.map((r) => ({
        document: r.document,
        title: r.title,
        author: r.author,
        filename: r.filename,
        percentage: r.percentage,
        progress: r.progress,
        device_id: r.device_id,
        device: r.device,
        timestamp: r.updated_at,
      })),
    });
  });

  app.get('/progress/:document', async (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    try {
      await refreshProgress(user.id, document);
    } catch (error) {
      const status = error instanceof Error && error.name === 'TimeoutError' ? 504 : 502;
      return c.json({ code: 2003, message: 'BookFusion progress refresh failed' }, status);
    }
    const rows = db
      .prepare(
        `SELECT device_id, device, percentage, progress, position, updated_at
         FROM progress WHERE user_id = ? AND document = ?
         ORDER BY updated_at DESC, device_id`
      )
      .all(user.id, document) as {
      device_id: string;
      device: string;
      percentage: number;
      progress: string;
      position: string | null;
      updated_at: number;
    }[];
    return c.json({
      document,
      devices: rows.map((r) => ({
        device_id: r.device_id,
        device: r.device,
        percentage: r.percentage,
        progress: r.progress,
        position: r.position ? JSON.parse(r.position) : null,
        timestamp: r.updated_at,
      })),
    });
  });

  // Remove a synced book entirely: kosync progress for every device plus the
  // rest of that book's server-side data (samples, bookmarks, clippings,
  // per-book stats, connector matches and queued connector events). Lets a user
  // clear a book off their dashboard - e.g. one synced from a file they no
  // longer have. Devices that still hold the book re-sync it from scratch.
  app.delete('/progress/:document', (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    if (!hasDocumentData(db, user.id, document)) {
      return c.json({ code: 2003, message: 'Unknown document' }, 404);
    }
    const rows = deleteDocumentData(db, user.id, document);
    return c.json({ document, deleted: true, rows });
  });

  return app;
}
