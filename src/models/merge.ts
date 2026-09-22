import { withTransaction, type DB } from '../db/db.js';

/**
 * Manual document merges. The kosync document key is client-computed and
 * clients disagree (KOReader binary partial-MD5 vs CrossPoint filename MD5),
 * so one physical book can sync as two documents. A merge migrates the
 * existing rows onto one canonical document and records alias -> canonical so
 * future pushes under the old hash land on the canonical one.
 */

/** Resolve a device-sent document hash to its canonical merged document. */
export function resolveDocument(db: DB, userId: number, document: string): string {
  const row = db
    .prepare('SELECT document FROM document_aliases WHERE user_id = ? AND alias = ?')
    .get(userId, document) as { document: string } | undefined;
  return row?.document ?? document;
}

/** All alias hashes per canonical document for a user. */
export function aliasesByDocument(db: DB, userId: number): Map<string, string[]> {
  const rows = db
    .prepare('SELECT alias, document FROM document_aliases WHERE user_id = ?')
    .all(userId) as unknown as { alias: string; document: string }[];
  const map = new Map<string, string[]>();
  for (const r of rows) {
    const list = map.get(r.document) ?? [];
    list.push(r.alias);
    map.set(r.document, list);
  }
  return map;
}

/**
 * Merge `from` into `into`: migrate progress (newest per device wins),
 * position samples, metadata (canonical's fields win, alias fills gaps),
 * bookmarks/clippings/stats, and connector matches, then record the alias.
 * Callers must pass already-resolved, distinct documents.
 */
export function mergeDocuments(db: DB, userId: number, from: string, into: string, now: number): void {
  withTransaction(db, () => {
    // progress PK (user, document, device_id): keep the newest row per device.
    db.prepare(
      `DELETE FROM progress WHERE user_id = ? AND document = ? AND EXISTS (
         SELECT 1 FROM progress b WHERE b.user_id = progress.user_id AND b.document = ?
           AND b.device_id = progress.device_id AND b.updated_at >= progress.updated_at)`
    ).run(userId, from, into);
    db.prepare(
      `DELETE FROM progress WHERE user_id = ? AND document = ? AND EXISTS (
         SELECT 1 FROM progress b WHERE b.user_id = progress.user_id AND b.document = ?
           AND b.device_id = progress.device_id AND b.updated_at > progress.updated_at)`
    ).run(userId, into, from);
    db.prepare('UPDATE progress SET document = ? WHERE user_id = ? AND document = ?').run(
      into,
      userId,
      from
    );

    // progress_samples PK (user, document, pct_bucket): newest sample per bucket.
    db.prepare(
      `DELETE FROM progress_samples WHERE user_id = ? AND document = ? AND EXISTS (
         SELECT 1 FROM progress_samples b WHERE b.user_id = progress_samples.user_id AND b.document = ?
           AND b.pct_bucket = progress_samples.pct_bucket AND b.updated_at >= progress_samples.updated_at)`
    ).run(userId, from, into);
    db.prepare('UPDATE OR REPLACE progress_samples SET document = ? WHERE user_id = ? AND document = ?').run(
      into,
      userId,
      from
    );

    // documents: canonical metadata wins, alias fills the gaps.
    db.prepare(
      `INSERT INTO documents (user_id, document, title, author, filename, filesize, updated_at)
       SELECT user_id, ?, title, author, filename, filesize, ? FROM documents WHERE user_id = ? AND document = ?
       ON CONFLICT(user_id, document) DO UPDATE SET
         title = COALESCE(documents.title, excluded.title),
         author = COALESCE(documents.author, excluded.author),
         filename = COALESCE(documents.filename, excluded.filename),
         filesize = COALESCE(documents.filesize, excluded.filesize),
         updated_at = excluded.updated_at`
    ).run(into, now, userId, from);
    db.prepare('DELETE FROM documents WHERE user_id = ? AND document = ?').run(userId, from);

    // Uniquely-keyed side tables: move what fits, drop the (rare) conflicts.
    for (const table of ['bookmarks', 'clippings', 'stats_device_book', 'connector_matches', 'connector_queue']) {
      db.prepare(`UPDATE OR IGNORE ${table} SET document = ? WHERE user_id = ? AND document = ?`).run(
        into,
        userId,
        from
      );
      db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND document = ?`).run(userId, from);
    }

    // Flatten chains (anything aliased to `from` now points at `into`), then
    // record the merge itself.
    db.prepare('UPDATE document_aliases SET document = ? WHERE user_id = ? AND document = ?').run(
      into,
      userId,
      from
    );
    db.prepare(
      'INSERT OR REPLACE INTO document_aliases (user_id, alias, document, created_at) VALUES (?, ?, ?, ?)'
    ).run(userId, from, into, now);
  });
}

/**
 * Remove an alias mapping. Already-migrated rows stay on the canonical
 * document; the old hash just starts accumulating its own progress again.
 */
export function unmergeDocument(db: DB, userId: number, alias: string): boolean {
  const res = db
    .prepare('DELETE FROM document_aliases WHERE user_id = ? AND alias = ?')
    .run(userId, alias);
  return res.changes > 0;
}
