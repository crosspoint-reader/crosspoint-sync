import { Hono } from 'hono';
import { withTransaction, type DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { isValidDocument } from '../kosync.js';
import { nowSeconds } from '../../models/sync.js';
import { mergeDocuments, resolveDocument, unmergeDocument } from '../../models/merge.js';

const MAX_BATCH = 50;

export function documentRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.put('/documents', async (c) => {
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
    const now = nowSeconds();
    const upsert = db.prepare(
      `INSERT INTO documents (user_id, document, title, author, filename, filesize, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, document) DO UPDATE SET
         title = COALESCE(excluded.title, documents.title),
         author = COALESCE(excluded.author, documents.author),
         filename = COALESCE(excluded.filename, documents.filename),
         filesize = COALESCE(excluded.filesize, documents.filesize),
         updated_at = excluded.updated_at`
    );
    type Row = {
      document: string;
      title: string | null;
      author: string | null;
      filename: string | null;
      filesize: number | null;
    };
    const rows: Row[] = [];
    for (const raw of items) {
      const o = raw as Record<string, unknown>;
      if (!isValidDocument(o.document)) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      rows.push({
        document: o.document,
        title: typeof o.title === 'string' ? o.title.slice(0, 512) : null,
        author: typeof o.author === 'string' ? o.author.slice(0, 512) : null,
        filename: typeof o.filename === 'string' ? o.filename.slice(0, 512) : null,
        filesize:
          typeof o.filesize === 'number' && Number.isInteger(o.filesize) && o.filesize >= 0
            ? o.filesize
            : null,
      });
    }
    withTransaction(db, () => {
      for (const r of rows) {
        upsert.run(user.id, r.document, r.title, r.author, r.filename, r.filesize, now);
      }
    });
    return c.json({ until: now, accepted: rows.length });
  });

  // Merge two synced listings that are really the same book (devices can hash
  // the same file differently). `document` becomes an alias of `into`: existing
  // data migrates onto `into`, and future pushes under `document` land there.
  app.post('/documents/merge', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const o = (body ?? {}) as Record<string, unknown>;
    if (!isValidDocument(o.document) || !isValidDocument(o.into)) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    const from = resolveDocument(db, user.id, o.document);
    const into = resolveDocument(db, user.id, o.into);
    if (from === into) {
      return kosyncError(c, 403, 2003, 'Documents are already merged');
    }
    mergeDocuments(db, user.id, from, into, nowSeconds());
    return c.json({ document: into, merged: from });
  });

  // Undo a merge: the alias hash starts syncing separately again. Rows already
  // migrated stay on the canonical document.
  app.delete('/documents/merge/:alias', (c) => {
    const alias = c.req.param('alias');
    if (!isValidDocument(alias)) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    if (!unmergeDocument(db, user.id, alias)) {
      return c.json({ code: 2003, message: 'Unknown alias' }, 404);
    }
    return c.json({ alias, unmerged: true });
  });

  app.get('/documents', (c) => {
    const user = c.get('user');
    const rows = db
      .prepare(
        'SELECT document, title, author, filename, filesize, updated_at FROM documents WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500'
      )
      .all(user.id);
    return c.json({ items: rows });
  });

  return app;
}
