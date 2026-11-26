import crypto from 'node:crypto';
import { Hono } from 'hono';
import type { DB } from '../db/db.js';

/**
 * Operator-only export of the published books this install knows, for an
 * external metadata catalog. One row per ISBN, or per title and author for
 * books without one. Catalog fields only: no user ids, statuses or ratings,
 * and anything a reader typed by hand or that came from their own library
 * (LIBRARY_OPDS_URL: its covers and details) is left out. A document without an ISBN
 * is exported only once Hardcover has matched it, so personal documents and
 * unrecognised files never leave. Mounted only when CATALOG_EXPORT_TOKEN is set.
 *
 *   GET /api/catalog/books?after=<next from the previous page>&limit=<1..500>
 *   -> { books: [{ isbn | null, title, author, description, cover_url, series, series_position,
 *                  genres, moods, content_warnings, page_count, release_year, rating, language }], next }
 */
export function catalogRoutes(db: DB, token: string): Hono {
  const app = new Hono();
  const expected = Buffer.from(`Bearer ${token}`);
  app.get('/books', (c) => {
    const given = Buffer.from(c.req.header('authorization') ?? '');
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const limit = Math.min(Math.max(Number(c.req.query('limit')) || 500, 1), 500);
    // No index behind this: a full scan per page, fine for an occasional operator pull.
    const rows = db.prepare(
      `SELECT COALESCE(isbn, lower(title) || char(31) || lower(COALESCE(author, ''))) AS k,
              isbn,
              MAX(CASE WHEN meta_manual = 0 THEN title END) AS title,
              MAX(CASE WHEN meta_manual = 0 THEN author END) AS author,
              MAX(CASE WHEN description_manual = 0 AND instr(COALESCE(library_fields, ''), ',description,') = 0 THEN description END) AS description,
              MAX(CASE WHEN genres_manual = 0 AND instr(COALESCE(library_fields, ''), ',genres,') = 0 THEN genres END) AS genres,
              MAX(CASE WHEN moods_manual = 0 THEN moods END) AS moods,
              MAX(CASE WHEN content_warnings_manual = 0 THEN content_warnings END) AS content_warnings,
              MAX(CASE WHEN series_manual = 0 AND instr(COALESCE(library_fields, ''), ',series,') = 0 THEN series END) AS series,
              MAX(CASE WHEN series_manual = 0 AND instr(COALESCE(library_fields, ''), ',series,') = 0 THEN series_position END) AS series_position,
              MAX(CASE WHEN release_year_manual = 0 AND instr(COALESCE(library_fields, ''), ',release_year,') = 0 THEN release_year END) AS release_year,
              MAX(page_count) AS page_count,
              MAX(rating) AS rating,
              MAX(language) AS language,
              MAX(CASE WHEN cover_library = 0 THEN cover_url END) AS cover_url
         FROM documents
        WHERE isbn IS NOT NULL OR (hc_id IS NOT NULL AND meta_manual = 0)
        GROUP BY k
       HAVING title IS NOT NULL AND k > ?
        ORDER BY k
        LIMIT ?`
    ).all(c.req.query('after') ?? '', limit) as { k: string; genres: string | null; moods: string | null; content_warnings: string | null }[];
    const list = (v: string | null) => (v ? (JSON.parse(v) as string[]) : []);
    const books = rows.map(({ k: _, ...r }) => ({ ...r, genres: list(r.genres), moods: list(r.moods), content_warnings: list(r.content_warnings) }));
    return c.json({ books, next: rows.length === limit ? rows[rows.length - 1].k : null });
  });
  return app;
}
