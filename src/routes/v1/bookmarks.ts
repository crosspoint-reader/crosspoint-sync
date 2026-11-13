import { Hono } from 'hono';
import { withTransaction, type DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { isValidDocument } from '../kosync.js';
import { isItemId, nowSeconds, parseListParams } from '../../models/sync.js';
import { resolveDocument } from '../../models/merge.js';

const MAX_BATCH = 50;

interface BookmarkRow {
  revision: number;
  id: string;
  xpath: string;
  percentage: number;
  summary: string;
  spine_index: number | null;
  paragraph_count: number | null;
  paragraph_pos: number | null;
  deleted: number;
  updated_at: number;
}

function optionalUint(v: unknown): number | null | undefined {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 65_535) return v;
  return undefined; // invalid
}

export function bookmarkRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/bookmarks/:document', (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    const canonical = resolveDocument(db, user.id, document);
    const { since, limit } = parseListParams(c);
    const cursorMode = c.req.query('cursor') !== undefined;
    const cursor = Number(c.req.query('cursor') ?? 0);
    if (cursorMode && (!Number.isSafeInteger(cursor) || cursor < 0)) {
      return kosyncError(c, 403, 2003, 'Invalid cursor');
    }
    const rows = db
      .prepare(
        `SELECT revision, id, xpath, percentage, summary, spine_index, paragraph_count, paragraph_pos, deleted, updated_at
         FROM bookmarks WHERE user_id = ? AND document = ? AND ${cursorMode ? 'revision' : 'updated_at'} > ?
         ORDER BY ${cursorMode ? 'revision' : 'updated_at, id'} LIMIT ?`
      )
      .all(user.id, canonical, cursorMode ? cursor : since, limit + 1) as unknown as BookmarkRow[];
    const more = rows.length > limit;
    const items = more ? rows.slice(0, limit) : rows;
    const until = more ? items[items.length - 1].updated_at : nowSeconds();
    return c.json({
      document,
      sync_version: 2,
      cursor: items.length ? items[items.length - 1].revision : cursor,
      until,
      more,
      items: items.map((r) => ({
        id: r.id,
        revision: r.revision,
        xpath: r.xpath,
        percentage: r.percentage,
        summary: r.summary,
        si: r.spine_index,
        pc: r.paragraph_count,
        pp: r.paragraph_pos,
        deleted: r.deleted,
        updated_at: r.updated_at,
      })),
    });
  });

  app.put('/bookmarks/:document', async (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const items = (body as Record<string, unknown> | null)?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    const canonical = resolveDocument(db, user.id, document);
    const now = nowSeconds();

    const upsert = db.prepare(
      `INSERT INTO bookmarks (user_id, document, id, xpath, percentage, summary, spine_index, paragraph_count, paragraph_pos, deleted, updated_at, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, (SELECT revision FROM bookmark_sync_clock WHERE id = 1))
       ON CONFLICT(user_id, document, id) DO UPDATE SET
         xpath = excluded.xpath,
         percentage = excluded.percentage,
         summary = excluded.summary,
         spine_index = excluded.spine_index,
         paragraph_count = excluded.paragraph_count,
         paragraph_pos = excluded.paragraph_pos,
         deleted = 0,
         updated_at = excluded.updated_at,
         revision = excluded.revision`
    );
    const tombstone = db.prepare(
      `INSERT INTO bookmarks (user_id, document, id, deleted, updated_at, revision)
       VALUES (?, ?, ?, 1, ?, (SELECT revision FROM bookmark_sync_clock WHERE id = 1))
       ON CONFLICT(user_id, document, id) DO UPDATE SET
         deleted = 1,
         updated_at = excluded.updated_at,
         revision = excluded.revision`
    );

    type Op = () => void;
    const ops: Op[] = [];
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      const o = raw as Record<string, unknown>;
      if (!isItemId(o.id)) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      const id = o.id;
      if (o.deleted === 1 || o.deleted === true) {
        ops.push(() => tombstone.run(user.id, canonical, id, now));
        continue;
      }
      const percentage = o.percentage;
      if (
        typeof o.xpath !== 'string' ||
        o.xpath.length > 512 ||
        typeof percentage !== 'number' ||
        !Number.isFinite(percentage) ||
        percentage < 0 ||
        percentage > 1
      ) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      const summary = typeof o.summary === 'string' ? o.summary.slice(0, 256) : '';
      const si = optionalUint(o.si);
      const pc = optionalUint(o.pc);
      const pp = optionalUint(o.pp);
      if (si === undefined || pc === undefined || pp === undefined) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      const xpath = o.xpath;
      ops.push(() => upsert.run(user.id, canonical, id, xpath, percentage, summary, si, pc, pp, now));
    }
    const bumpRevision = db.prepare('UPDATE bookmark_sync_clock SET revision = revision + 1 WHERE id = 1');
    withTransaction(db, () => {
      for (const op of ops) {
        bumpRevision.run();
        op();
      }
    });
    return c.json({ until: now, accepted: ops.length });
  });

  return app;
}
