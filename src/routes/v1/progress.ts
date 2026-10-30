import type { ProgressRefresh } from '../../connectors/refresh.js';
import { Hono } from 'hono';
import type { DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import {
  fanOutDeviceProgress,
  isValidDocument,
  listCursor,
  parseListCursor,
  parseProgressBody,
  upsertProgress,
  writeDeviceProgress,
  type ProgressUpsert,
} from '../kosync.js';
import { withTransaction } from '../../db/db.js';
import { deleteDocumentData, hasDocumentData } from '../../models/document.js';
import { fanOutProgress } from '../../connectors/fanout.js';
import { aliasesByDocument, resolveDocument } from '../../models/merge.js';
import { enrichSoon } from '../../models/cover.js';
import { autoPause } from '../../models/pause.js';
import { completedBookStatsSql } from '../../models/stats.js';
import { CHANGES_DEFAULT_LIMIT, CHANGES_MAX_LIMIT, listProgressChanges } from '../../models/changes.js';

// Positions per batch PUT: readers send a handful of changed books at a time.
export const MAX_PROGRESS_BATCH = 20;

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
    const parsed = parseProgressBody(user.id, body, { clientTime: true });
    if (!parsed.ok) {
      return kosyncError(c, 403, parsed.code, parsed.message);
    }
    const clientDocument = parsed.record.document;
    parsed.record.document = resolveDocument(db, user.id, clientDocument);
    upsertProgress(db, parsed.record);
    fanOutProgress(db, user.id, parsed.record.document, parsed.record.percentage, parsed.record.updatedAt, parsed.record.progress, parsed.record.position);
    return c.json({ document: clientDocument, timestamp: parsed.record.updatedAt });
  });

  // Several books' progress in one request (a reader's bulk sync push): each
  // item is a kosync progress body, stored exactly as the kosync PUT stores it.
  // All or nothing: any invalid item rejects the request before anything is
  // written. Servers without this route answer 404; readers then fall back to
  // one PUT /syncs/progress per book.
  app.put('/progress/batch', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const items = ((body ?? {}) as Record<string, unknown>).items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_PROGRESS_BATCH) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    const records: ProgressUpsert[] = [];
    for (const item of items) {
      const parsed = parseProgressBody(user.id, item);
      if (!parsed.ok) return kosyncError(c, 403, parsed.code, parsed.message);
      records.push(parsed.record);
    }
    const accepted: { document: string; timestamp: number }[] = [];
    withTransaction(db, () => {
      for (const record of records) {
        accepted.push({ document: writeDeviceProgress(db, record), timestamp: record.updatedAt });
      }
    });
    // External services only after every row is stored.
    for (const record of records) fanOutDeviceProgress(db, record);
    return c.json({ accepted: accepted.length, items: accepted });
  });

  // List every synced document with its newest progress (joined with any known
  // metadata) - lets clients and UIs discover documents without knowing hashes.
  // Newest first; pass `next` back as `cursor` for the following page.
  app.get('/progress', (c) => {
    const user = c.get('user');
    const cursor = parseListCursor(c.req.query('cursor'));
    if (cursor === null) return kosyncError(c, 403, 2003, 'Invalid request');
    if (!cursor) {
      // Once per listing, not per page.
      enrichSoon(db, user.id); // Hardcover details for new books, in the background
      autoPause(db, { userId: user.id });
    }
    const limitRaw = Number(c.req.query('limit') ?? 100);
    const limit =
      Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 100;
    const includeHistory = c.req.query('include_history') === '1';
    const rows = db
      .prepare(
        `WITH library AS (
           SELECT user_id, document, device_id, device, percentage, progress, position, updated_at FROM progress WHERE user_id = ?
           ${includeHistory ? `UNION ALL
           SELECT d.user_id, d.document, NULL, NULL, NULL, NULL, NULL,
             COALESCE((SELECT MAX(at) FROM progress_log l WHERE l.user_id = d.user_id AND l.document = d.document), d.updated_at)
           FROM documents d WHERE d.user_id = ?
             AND NOT EXISTS (SELECT 1 FROM progress p WHERE p.user_id = d.user_id AND p.document = d.document)
             AND NOT EXISTS (SELECT 1 FROM document_aliases a WHERE a.user_id = d.user_id AND a.alias = d.document)
             AND (d.status IS NOT NULL OR EXISTS (SELECT 1 FROM stats_device_book s WHERE s.user_id = d.user_id AND s.document = d.document)
               OR EXISTS (SELECT 1 FROM progress_log l WHERE l.user_id = d.user_id AND l.document = d.document))` : ''}
         ) SELECT p.document, p.device_id, p.device, p.percentage, p.progress, p.position, p.updated_at,
                d.title, d.author, d.filename, d.language, d.cover_url, d.page_count,
                d.hc_slug, d.moods, d.genres, d.content_warnings, d.rating, d.user_rating, d.isbn, d.series, d.series_position, d.release_year,
                COALESCE(d.status, CASE WHEN p.percentage >= 0.98 OR ${completedBookStatsSql('p.user_id', 'p.document')}
                  THEN 'finished' WHEN p.device_id IS NULL THEN 'paused' ELSE 'reading' END) AS status,
                d.status_at, d.pause_reason
         FROM library p
         LEFT JOIN documents d ON d.user_id = p.user_id AND d.document = p.document
         WHERE p.user_id = ?
           AND (p.device_id IS NULL OR (p.updated_at = (
             SELECT MAX(p2.updated_at) FROM progress p2
             WHERE p2.user_id = p.user_id AND p2.document = p.document
           )
           AND p.device_id = (
             SELECT MIN(p3.device_id) FROM progress p3
             WHERE p3.user_id = p.user_id AND p3.document = p.document
               AND p3.updated_at = p.updated_at
           )))
           AND (? IS NULL OR p.updated_at < ? OR (p.updated_at = ? AND p.document < ?))
         ORDER BY p.updated_at DESC, p.document DESC
         LIMIT ?`
      )
      .all(user.id, ...(includeHistory ? [user.id] : []), user.id, cursor?.at ?? null, cursor?.at ?? null, cursor?.at ?? null, cursor?.document ?? null, limit + 1) as unknown as {
      document: string;
      device_id: string | null;
      device: string | null;
      percentage: number | null;
      progress: string | null;
      position: string | null;
      updated_at: number;
      title: string | null;
      author: string | null;
      filename: string | null;
      language: string | null;
      cover_url: string | null;
      page_count: number | null;
      hc_slug: string | null;
      moods: string | null;
      genres: string | null;
      content_warnings: string | null;
      rating: number | null;
      user_rating: number | null;
      isbn: string | null;
      series: string | null;
      series_position: number | null;
      release_year: number | null;
      status: string;
      status_at: number | null;
      pause_reason: string | null;
    }[];
    const list = (v: string | null): string[] => {
      try {
        return v ? (JSON.parse(v) as string[]) : [];
      } catch {
        return [];
      }
    };
    const more = rows.length > limit;
    if (more) rows.pop();
    const aliases = aliasesByDocument(db, user.id);
    return c.json({
      next: more ? listCursor(rows[rows.length - 1]) : null,
      items: rows.map((r) => {
        let position: { page?: number; pages?: number } | null = null;
        if (r.position) {
          try {
            position = JSON.parse(r.position) as { page?: number; pages?: number };
          } catch {
            position = null;
          }
        }
        return {
          document: r.document,
          history_only: r.device_id === null,
          title: r.title,
          author: r.author,
          filename: r.filename,
          language: r.language,
          status: r.status,
          // When a manual status was set (null when derived from progress).
          status_at: r.status_at ?? null,
          pause_reason: r.pause_reason ?? null, // 'auto' | 'manual' while paused
          cover_url: r.cover_url,
          page_count: r.page_count,
          // From Hardcover's catalog (empty until looked up, or without HARDCOVER_API_KEY).
          hardcover_slug: r.hc_slug,
          moods: list(r.moods),
          genres: list(r.genres),
          content_warnings: list(r.content_warnings),
          rating: r.rating,
          user_rating: r.user_rating,
          isbn: r.isbn,
          series: r.series,
          series_position: r.series_position,
          release_year: r.release_year,
          percentage: r.percentage,
          progress: r.progress,
          page: position?.page ?? null,
          pages: position?.pages ?? null,
          device_id: r.device_id,
          device: r.device,
          timestamp: r.updated_at,
          aliases: aliases.get(r.document) ?? [],
        };
      }),
    });
  });

  // Progress change feed for incremental device sync. Registered before
  // /progress/:document so "changes" is not read as a document hash.
  app.get('/progress/changes', (c) => {
    const user = c.get('user');
    const sinceRaw = Number(c.req.query('since') ?? 0);
    const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.floor(sinceRaw) : 0;
    const limitRaw = Number(c.req.query('limit') || CHANGES_DEFAULT_LIMIT);
    const limit = Number.isFinite(limitRaw) && limitRaw >= 0
      ? Math.min(Math.floor(limitRaw), CHANGES_MAX_LIMIT)
      : CHANGES_DEFAULT_LIMIT;
    const deviceRaw = c.req.query('device');
    const device = deviceRaw ? deviceRaw.slice(0, 128) : null;
    return c.json(listProgressChanges(db, user.id, since, limit, device));
  });

  app.get('/progress/:document', async (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    const canonical = resolveDocument(db, user.id, document);
    try {
      await refreshProgress(user.id, canonical);
    } catch (error) {
      const status = error instanceof Error && error.name === 'TimeoutError' ? 504 : 502;
      return c.json({ code: 2003, message: 'BookFusion progress refresh failed' }, status);
    }
    autoPause(db, { userId: user.id, document: canonical });
    const rows = db
      .prepare(
        `SELECT device_id, device, percentage, progress, position, updated_at
         FROM progress WHERE user_id = ? AND document = ?
         ORDER BY updated_at DESC, device_id`
      )
      .all(user.id, canonical) as {
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
