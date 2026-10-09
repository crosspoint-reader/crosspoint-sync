import { withTransaction, type DB } from '../db/db.js';
import { nextChangeSeq } from './changes.js';

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
 * Document hashes whose per-book stats count toward `document`: itself plus
 * every alias merged with stats. Stats rows stay under the hash the device
 * uploaded them with (each upload replaces that device's cumulative snapshot),
 * so they are combined here on read instead of being moved at merge time.
 */
export function statsDocuments(db: DB, userId: number, document: string): string[] {
  const rows = db
    .prepare('SELECT alias FROM document_aliases WHERE user_id = ? AND document = ? AND merge_stats = 1')
    .all(userId, document) as unknown as { alias: string }[];
  return [document, ...rows.map((r) => r.alias)];
}

/** Map of stats-merged alias -> canonical document for a user. */
export function statsAliases(db: DB, userId: number): Map<string, string> {
  const rows = db
    .prepare('SELECT alias, document FROM document_aliases WHERE user_id = ? AND merge_stats = 1')
    .all(userId) as unknown as { alias: string; document: string }[];
  return new Map(rows.map((r) => [r.alias, r.document]));
}

/**
 * Merge `from` into `into`: migrate progress (furthest wins),
 * position samples, metadata (canonical's fields win, alias fills gaps),
 * bookmarks/clippings and connector matches, then record the alias. Per-book
 * stats are not moved; `mergeStats` decides whether they combine on read.
 * Callers must pass already-resolved, distinct documents.
 */
export function mergeDocuments(
  db: DB,
  userId: number,
  from: string,
  into: string,
  now: number,
  mergeStats = true
): void {
  withTransaction(db, () => {
    // progress PK (user, document, device_id): keep the furthest row per device.
    db.prepare(
      `DELETE FROM progress WHERE user_id = ? AND document = ? AND EXISTS (
         SELECT 1 FROM progress b WHERE b.user_id = progress.user_id AND b.document = ?
           AND b.device_id = progress.device_id AND b.percentage >= progress.percentage)`
    ).run(userId, from, into);
    db.prepare(
      `DELETE FROM progress WHERE user_id = ? AND document = ? AND EXISTS (
         SELECT 1 FROM progress b WHERE b.user_id = progress.user_id AND b.document = ?
           AND b.device_id = progress.device_id AND b.percentage > progress.percentage)`
    ).run(userId, into, from);
    db.prepare('UPDATE progress SET document = ? WHERE user_id = ? AND document = ?').run(
      into,
      userId,
      from
    );
    // Reads serve the newest row, so make the furthest one the newest.
    db.prepare(
      `UPDATE progress SET updated_at = MAX(?, (SELECT MAX(updated_at) + 1 FROM progress WHERE user_id = ? AND document = ?))
       WHERE rowid = (
         SELECT rowid FROM progress WHERE user_id = ? AND document = ?
         ORDER BY percentage DESC, updated_at DESC LIMIT 1)`
    ).run(now, userId, into, userId, into);
    // The merge bypasses upsertProgress, so stamp the canonical rows itself;
    // otherwise devices never see the merged position until the next write.
    const seq = nextChangeSeq(db);
    db.prepare('UPDATE progress SET change_seq = ?, server_change_seq = ? WHERE user_id = ? AND document = ?').run(
      seq,
      seq,
      userId,
      into
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

    // progress_log is an append-only history: just re-home it.
    db.prepare('UPDATE progress_log SET document = ? WHERE user_id = ? AND document = ?').run(into, userId, from);

    // documents: canonical metadata wins, alias fills the gaps.
    db.prepare(
      `INSERT INTO documents (user_id, document, title, author, filename, filesize, status, status_at, pause_reason, start_date, finished_date, cover_url, page_count, updated_at)
       SELECT user_id, ?, title, author, filename, filesize, status, status_at, pause_reason, start_date, finished_date, cover_url, page_count, ? FROM documents WHERE user_id = ? AND document = ?
       ON CONFLICT(user_id, document) DO UPDATE SET
         title = COALESCE(documents.title, excluded.title),
         author = COALESCE(documents.author, excluded.author),
         filename = COALESCE(documents.filename, excluded.filename),
         filesize = COALESCE(documents.filesize, excluded.filesize),
         status = COALESCE(documents.status, excluded.status),
         status_at = COALESCE(documents.status_at, excluded.status_at),
         pause_reason = CASE WHEN documents.status IS NULL THEN excluded.pause_reason ELSE documents.pause_reason END,
         start_date = COALESCE(documents.start_date, excluded.start_date),
         finished_date = COALESCE(documents.finished_date, excluded.finished_date),
         cover_url = COALESCE(documents.cover_url, excluded.cover_url),
         page_count = COALESCE(documents.page_count, excluded.page_count),
         updated_at = excluded.updated_at`
    ).run(into, now, userId, from);
    db.prepare('DELETE FROM documents WHERE user_id = ? AND document = ?').run(userId, from);

    // Uniquely-keyed side tables: move what fits, drop the (rare) conflicts.
    for (const table of ['bookmarks', 'clippings', 'connector_matches', 'connector_queue']) {
      db.prepare(`UPDATE OR IGNORE ${table} SET document = ? WHERE user_id = ? AND document = ?`).run(
        into,
        userId,
        from
      );
      db.prepare(`DELETE FROM ${table} WHERE user_id = ? AND document = ?`).run(userId, from);
    }

    // Flatten chains (anything aliased to `from` now points at `into`; its
    // stats were part of `from`'s, so they follow this merge's choice), then
    // record the merge itself.
    db.prepare(
      'UPDATE document_aliases SET document = ?, merge_stats = merge_stats AND ? WHERE user_id = ? AND document = ?'
    ).run(into, mergeStats ? 1 : 0, userId, from);
    db.prepare(
      'INSERT OR REPLACE INTO document_aliases (user_id, alias, document, created_at, merge_stats) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, from, into, now, mergeStats ? 1 : 0);
  });
}

/**
 * Remove an alias mapping. Already-migrated rows stay on the canonical
 * document; the old hash just starts accumulating its own progress again.
 * Its per-book stats were never moved, so they go back with it.
 */
export function unmergeDocument(db: DB, userId: number, alias: string): boolean {
  const res = db
    .prepare('DELETE FROM document_aliases WHERE user_id = ? AND alias = ?')
    .run(userId, alias);
  return res.changes > 0;
}

/** Canonical clipping hash plus its aliases, irrespective of stats merge policy. */
export function clippingDocuments(db: DB, userId: number, document: string): string[] {
  const rows = db.prepare('SELECT alias FROM document_aliases WHERE user_id = ? AND document = ?')
    .all(userId, document) as unknown as { alias: string }[];
  return [document, ...rows.map((r) => r.alias)];
}

/**
 * Read legacy side data without moving/deleting rows. Old server versions wrote
 * alias hashes even after a merge. Rank before filtering a delta so an older
 * duplicate cannot reappear when the newest row is outside the requested range.
 * A clipping tombstone anywhere in the family wins; its effective cursor includes
 * newer alias copies so upload-only clients cannot revive a deletion.
 */
export function mergedClippingsCte(documentCount = 0, byId = false): string {
  // Restrict the indexed source before ranking; keep every duplicate in the
  // requested family so annotations, tombstones and cursors remain consistent.
  const scope = documentCount ? ` AND c.document IN (${Array(documentCount).fill('?').join(',')})` : '';
  return `WITH candidates AS (
  SELECT c.*, COALESCE(a.document, c.document) AS canonical_document,
    MAX(c.revision) OVER (PARTITION BY COALESCE(a.document, c.document), c.id) AS sync_revision,
    MAX(c.updated_at) OVER (PARTITION BY COALESCE(a.document, c.document), c.id) AS sync_updated_at,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(a.document, c.document), c.id
      ORDER BY c.deleted DESC, c.revision DESC, c.updated_at DESC,
               (c.document = COALESCE(a.document, c.document)) DESC, c.document
    ) AS row_rank,
    CASE WHEN c.document = COALESCE(a.document, c.document) THEN c.note
         ELSE COALESCE(c.note, (SELECT own.note FROM clippings own
           WHERE own.user_id = c.user_id AND own.document = a.document AND own.id = c.id)) END AS saved_note,
    CASE WHEN c.document = COALESCE(a.document, c.document) THEN c.color
         ELSE COALESCE(c.color, (SELECT own.color FROM clippings own
           WHERE own.user_id = c.user_id AND own.document = a.document AND own.id = c.id)) END AS saved_color
  FROM clippings c LEFT JOIN document_aliases a ON a.user_id = c.user_id AND a.alias = c.document
  WHERE c.user_id = ?${scope}${byId ? ' AND c.id = ?' : ''}
), merged AS (
  SELECT canonical_document AS document, id, spine_index, start_page, end_page, page_count,
    start_word, end_word, word_count, paragraph_index, chapter_title, text,
    saved_note AS note, saved_color AS color, created_at, deleted,
    sync_updated_at AS updated_at, sync_revision AS revision, layout_signature, start_offset, end_offset
  FROM candidates WHERE row_rank = 1
)`;
}
