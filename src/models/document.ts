import { withTransaction, type DB } from '../db/db.js';

/**
 * Every table that holds per-(user, document) reading data. Removing a book
 * means clearing all of them: the dashboard lists books straight off `progress`,
 * so leaving bookmarks/clippings/stats behind would strand rows no UI can reach.
 * Ordered children-first; nothing here has FK dependencies, but it keeps the
 * intent obvious next to the account-level delete in routes/account.ts.
 */
const DOCUMENT_TABLES = [
  'connector_queue',
  'connector_matches',
  'stats_device_book',
  'clippings',
  'bookmarks',
  'progress_samples',
  'progress',
  'documents',
] as const;

/** True when the user has any stored data at all for this document. */
export function hasDocumentData(db: DB, userId: number, document: string): boolean {
  for (const table of DOCUMENT_TABLES) {
    const row = db
      .prepare(`SELECT 1 FROM ${table} WHERE user_id = ? AND document = ? LIMIT 1`)
      .get(userId, document);
    if (row) return true;
  }
  return false;
}

/**
 * Permanently delete one book's synced data for a user: kosync progress (all
 * devices), position samples, bookmarks, clippings, per-book stats, connector
 * matches and any queued connector events. Returns the number of rows removed.
 *
 * Bookmarks and clippings are hard-deleted rather than tombstoned - the book is
 * gone, so there is nothing left for a device to delta-sync against. A device
 * that still holds the book simply re-uploads it on the next sync.
 */
export function deleteDocumentData(db: DB, userId: number, document: string): number {
  let rows = 0;
  withTransaction(db, () => {
    for (const table of DOCUMENT_TABLES) {
      const result = db
        .prepare(`DELETE FROM ${table} WHERE user_id = ? AND document = ?`)
        .run(userId, document);
      rows += Number(result.changes);
    }
    // Merge mappings in either direction die with the book too.
    const aliasResult = db
      .prepare('DELETE FROM document_aliases WHERE user_id = ? AND (alias = ? OR document = ?)')
      .run(userId, document, document);
    rows += Number(aliasResult.changes);
  });
  return rows;
}
