import type { DB } from '../db/db.js';
import { nowSeconds } from '../models/sync.js';
import { decryptSecret, encryptSecret } from '../crypto/secrets.js';
import type { Credential, DocumentMeta, Match } from './types.js';

export interface AccountRow {
  user_id: number;
  connector_id: string;
  cred_enc: string;
  account_label: string | null;
  status: string;
  enabled: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

export function upsertAccount(
  db: DB,
  userId: number,
  connectorId: string,
  cred: Credential,
  accountLabel: string | null,
  now = nowSeconds()
): void {
  const enc = encryptSecret(JSON.stringify(cred));
  db.prepare(
    `INSERT INTO connector_accounts
       (user_id, connector_id, cred_enc, account_label, status, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'ok', 1, ?, ?)
     ON CONFLICT(user_id, connector_id) DO UPDATE SET
       cred_enc = excluded.cred_enc,
       account_label = excluded.account_label,
       status = 'ok',
       enabled = 1,
       last_error = NULL,
       updated_at = excluded.updated_at`
  ).run(userId, connectorId, enc, accountLabel, now, now);
}

export function getAccount(db: DB, userId: number, connectorId: string): AccountRow | null {
  return (
    (db
      .prepare('SELECT * FROM connector_accounts WHERE user_id = ? AND connector_id = ?')
      .get(userId, connectorId) as AccountRow | undefined) ?? null
  );
}

export function listAccounts(db: DB, userId: number): AccountRow[] {
  return db
    .prepare('SELECT * FROM connector_accounts WHERE user_id = ?')
    .all(userId) as unknown as AccountRow[];
}

export function decryptCredential(row: AccountRow): Credential {
  return JSON.parse(decryptSecret(row.cred_enc)) as Credential;
}

export function deleteAccount(db: DB, userId: number, connectorId: string): void {
  db.prepare('DELETE FROM connector_accounts WHERE user_id = ? AND connector_id = ?').run(
    userId,
    connectorId
  );
}

export function setAccountStatus(
  db: DB,
  userId: number,
  connectorId: string,
  status: string,
  error: string | null,
  now = nowSeconds()
): void {
  db.prepare(
    'UPDATE connector_accounts SET status = ?, last_error = ?, updated_at = ? WHERE user_id = ? AND connector_id = ?'
  ).run(status, error, now, userId, connectorId);
}

/** All connector accounts that are linked, enabled, and healthy for fan-out. */
export function activeConnectorIds(db: DB, userId: number): string[] {
  return (
    db
      .prepare(
        `SELECT connector_id FROM connector_accounts WHERE user_id = ? AND enabled = 1 AND status != 'error'`
      )
      .all(userId) as { connector_id: string }[]
  ).map((r) => r.connector_id);
}

export interface MatchRow {
  user_id: number;
  connector_id: string;
  document: string;
  external_id: string | null;
  external_edition: string | null;
  confidence: number;
  source: string;
  query_used: string | null;
  push_note: string | null;
  updated_at: number;
}

// How a match was resolved. 'sidecar' = an exact service id the device sent in
// the book's plugin sidecar; it outranks fuzzy 'auto' search but yields to a
// user's 'manual' pick.
export type MatchSource = 'auto' | 'manual' | 'none' | 'sidecar';

export function getMatch(
  db: DB,
  userId: number,
  connectorId: string,
  document: string
): MatchRow | null {
  return (
    (db
      .prepare(
        'SELECT * FROM connector_matches WHERE user_id = ? AND connector_id = ? AND document = ?'
      )
      .get(userId, connectorId, document) as MatchRow | undefined) ?? null
  );
}

export function saveMatch(
  db: DB,
  userId: number,
  connectorId: string,
  document: string,
  match: Match | null,
  source: MatchSource,
  now = nowSeconds()
): void {
  db.prepare(
    `INSERT INTO connector_matches
       (user_id, connector_id, document, external_id, external_edition, confidence, source, query_used, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, connector_id, document) DO UPDATE SET
       external_id = excluded.external_id,
       external_edition = excluded.external_edition,
       confidence = excluded.confidence,
       source = excluded.source,
       query_used = excluded.query_used,
       push_note = NULL,
       updated_at = excluded.updated_at`
  ).run(
    userId,
    connectorId,
    document,
    match?.externalId ?? null,
    match?.externalEdition ?? null,
    match?.confidence ?? 0,
    source,
    match?.queryUsed ?? null,
    now
  );
}

/**
 * Pre-seed the match cache from the exact service ids a device sent in a book's
 * plugin sidecar (`externalIds`, keyed by connector id). This lets the runner
 * push to the right record without a fuzzy title search. Only connectors that
 * exist are seeded. A user's manual pick is never overwritten; an unchanged id
 * is left alone so its updated_at (and any richer edition) survives.
 */
export function seedSidecarMatches(
  db: DB,
  userId: number,
  document: string,
  externalIds: Record<string, string>,
  connectorExists: (id: string) => boolean,
  now = nowSeconds()
): void {
  for (const [connectorId, externalId] of Object.entries(externalIds)) {
    if (!externalId || !connectorExists(connectorId)) continue;
    const existing = getMatch(db, userId, connectorId, document);
    if (existing && existing.source === 'manual') continue; // respect user choice
    if (existing && existing.external_id === externalId && existing.source === 'sidecar') continue;
    saveMatch(
      db,
      userId,
      connectorId,
      document,
      { externalId, confidence: 1 },
      'sidecar',
      now
    );
  }
}

/** Record (or clear) a per-book push condition for the review UI. */
export function setMatchNote(
  db: DB,
  userId: number,
  connectorId: string,
  document: string,
  note: string | null
): void {
  db.prepare(
    'UPDATE connector_matches SET push_note = ? WHERE user_id = ? AND connector_id = ? AND document = ?'
  ).run(note, userId, connectorId, document);
}

export function listMatches(db: DB, userId: number, connectorId: string): MatchRow[] {
  return db
    .prepare(
      'SELECT * FROM connector_matches WHERE user_id = ? AND connector_id = ? ORDER BY updated_at DESC'
    )
    .all(userId, connectorId) as unknown as MatchRow[];
}

/**
 * Fill in a document's title/author from a resolved match, but only where they
 * are currently missing — never overwrite metadata the device sent. This is how
 * a match (or a manual pick) durably teaches us a book's identity, so later
 * metadata-less syncs (e.g. from another device) still match. See docs/design.
 */
export function backfillDocumentMeta(
  db: DB,
  userId: number,
  document: string,
  title: string | null | undefined,
  author: string | null | undefined,
  now = nowSeconds()
): void {
  if (!title && !author) return;
  db.prepare(
    `INSERT INTO documents (user_id, document, title, author, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, document) DO UPDATE SET
       title = COALESCE(documents.title, excluded.title),
       author = COALESCE(documents.author, excluded.author),
       updated_at = excluded.updated_at`
  ).run(userId, document, title ?? null, author ?? null, now);
}

/** Mark a stealth connector revealed for a user (idempotent). */
export function revealConnector(db: DB, userId: number, connectorId: string, now = nowSeconds()): void {
  db.prepare(
    'INSERT OR IGNORE INTO connector_reveals (user_id, connector_id, revealed_at) VALUES (?, ?, ?)'
  ).run(userId, connectorId, now);
}

/** The connector ids this user has revealed. */
export function listReveals(db: DB, userId: number): string[] {
  return (
    db.prepare('SELECT connector_id FROM connector_reveals WHERE user_id = ?').all(userId) as {
      connector_id: string;
    }[]
  ).map((r) => r.connector_id);
}

export function getPullCursor(db: DB, userId: number, connectorId: string): number {
  const row = db
    .prepare('SELECT pull_cursor FROM connector_accounts WHERE user_id = ? AND connector_id = ?')
    .get(userId, connectorId) as { pull_cursor: number } | undefined;
  return row?.pull_cursor ?? 0;
}

export function setPullCursor(
  db: DB,
  userId: number,
  connectorId: string,
  cursor: number
): void {
  db.prepare(
    'UPDATE connector_accounts SET pull_cursor = ? WHERE user_id = ? AND connector_id = ?'
  ).run(cursor, userId, connectorId);
}

/** Reverse-lookup: which of our documents is matched to this connector book id. */
export function documentForExternal(
  db: DB,
  userId: number,
  connectorId: string,
  externalId: string
): string | null {
  const row = db
    .prepare(
      'SELECT document FROM connector_matches WHERE user_id = ? AND connector_id = ? AND external_id = ? LIMIT 1'
    )
    .get(userId, connectorId, externalId) as { document: string } | undefined;
  return row?.document ?? null;
}

/** Canonical progress, using the same ordering as the KOSync endpoint. */
export function latestProgress(db: DB, userId: number, document: string): {
  percentage: number; progress: string; updated_at: number;
} | null {
  return db.prepare(
    'SELECT percentage, progress, updated_at FROM progress WHERE user_id = ? AND document = ? ORDER BY updated_at DESC, device_id LIMIT 1'
  ).get(userId, document) as { percentage: number; progress: string; updated_at: number } | undefined ?? null;
}

export function latestPercentage(db: DB, userId: number, document: string): number | null {
  return latestProgress(db, userId, document)?.percentage ?? null;
}

/** All linked, enabled connector accounts across users (for the fan-in worker). */
export function listAllEnabledAccounts(db: DB): { user_id: number; connector_id: string }[] {
  return db
    .prepare(`SELECT user_id, connector_id FROM connector_accounts WHERE enabled = 1 AND status != 'error'`)
    .all() as { user_id: number; connector_id: string }[];
}

export function documentMeta(db: DB, userId: number, document: string): DocumentMeta {
  const row = db
    .prepare('SELECT title, author, filename FROM documents WHERE user_id = ? AND document = ?')
    .get(userId, document) as
    | { title: string | null; author: string | null; filename: string | null }
    | undefined;
  return {
    document,
    title: row?.title ?? null,
    author: row?.author ?? null,
    filename: row?.filename ?? null,
  };
}
