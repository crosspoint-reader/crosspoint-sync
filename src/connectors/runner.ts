import type { DB } from '../db/db.js';
import { nowSeconds } from '../models/sync.js';
import { getConnector, fetchTransport } from './registry.js';
import {
  claimReady,
  markDone,
  markFailed,
  _internals,
  type QueueRow,
} from './queue.js';
import {
  backfillDocumentMeta,
  decryptCredential,
  documentMeta,
  getAccount,
  getMatch,
  latestPercentage,
  saveMatch,
  setAccountStatus,
  setMatchNote,
} from './store.js';
import { decideMatch, extractTitleAuthor } from './matching.js';
import { scheduleMicroblogClippings } from './microblog-clippings.js';
import {
  ConnectorOperationError,
  type HttpTransport,
  type Match,
  type OutboundEvent,
} from './types.js';

/**
 * Resolve a connector match for a document, using the cached row when present.
 * Manual matches are authoritative and never recomputed. Missing/auto rows are
 * (re)computed via the connector's own search. Returns null when unmatched.
 */
export async function resolveMatch(
  db: DB,
  connectorId: string,
  userId: number,
  document: string,
  http: HttpTransport,
  ev?: OutboundEvent
): Promise<Match | null> {
  const cached = getMatch(db, userId, connectorId, document);
  if (cached && cached.source === 'manual') {
    return cached.external_id
      ? {
          externalId: cached.external_id,
          externalEdition: cached.external_edition,
          confidence: cached.confidence,
        }
      : null;
  }
  if (cached && cached.external_id) {
    return {
      externalId: cached.external_id,
      ...(cached.source === 'sidecar' ? { fromSidecar: true } : {}),
      externalEdition: cached.external_edition,
      confidence: cached.confidence,
    };
  }

  const connector = getConnector(connectorId);
  const account = getAccount(db, userId, connectorId);
  if (!connector || !account) return null;
  const cred = decryptCredential(account, db);
  const meta = documentMeta(db, userId, document);

  let match: Match | null = null;

  // Candidates-first: try the user's "currently reading" list (small, high
  // precision) before falling back to a full catalog search.
  const ta = extractTitleAuthor(meta);
  if (ta && connector.listCurrentlyReading) {
    try {
      const candidates = await connector.listCurrentlyReading(cred, http);
      const decision = decideMatch(ta.title, ta.author, candidates);
      if (decision.accepted && decision.best) {
        const chosen = candidates.find((x) => x.externalId === decision.best!.externalId);
        match = {
          externalId: decision.best.externalId,
          externalEdition: chosen?.edition ?? null,
          confidence: decision.best.score,
          title: chosen?.title,
          author: chosen?.author,
        };
      }
    } catch {
      // Currently-reading lookup is best-effort; fall through to search.
    }
  }

  if (!match) {
    match = await connector.match(cred, meta, http, ev);
  }

  if (!match && ev && connector.createBook) {
    match = await connector.createBook(cred, meta, ev, http);
  }

  // Background history imports can still be matching when the user unlinks,
  // replaces credentials, or picks a manual match. Discard the stale result.
  const freshAccount = getAccount(db, userId, connectorId);
  const freshMatch = getMatch(db, userId, connectorId, document);
  if (!freshAccount?.enabled || freshAccount.cred_enc !== account.cred_enc ||
      freshMatch?.source !== cached?.source || freshMatch?.external_id !== cached?.external_id ||
      freshMatch?.external_edition !== cached?.external_edition || freshMatch?.updated_at !== cached?.updated_at) return null;
  saveMatch(db, userId, connectorId, document, match, match ? 'auto' : 'none');
  // A resolved match teaches us the book's title/author; keep it for future
  // metadata-less syncs and other connectors.
  if (match) backfillDocumentMeta(db, userId, document, match.title, match.author);
  return match;
}

/** Process a single queued event. Returns true if handled (done or dead). */
export async function processRow(db: DB, row: QueueRow, http: HttpTransport): Promise<void> {
  const connector = getConnector(row.connector_id);
  const account = getAccount(db, row.user_id, row.connector_id);
  if (!connector || !account || !account.enabled) {
    // Connector gone or disabled - drop permanently.
    markFailed(db, row, 'connector unavailable or disabled', false);
    return;
  }
  if (account.status === 'needs_reauth') {
    markFailed(db, row, 'account needs reauth', false);
    return;
  }

  const ev = JSON.parse(row.payload) as OutboundEvent;
  const publication = row.connector_id === 'microblog' && ev.kind === 'highlight';
  const originalPost = publication ? db.prepare('SELECT identity FROM microblog_clipping_posts WHERE user_id=? AND document=?')
    .get(row.user_id, row.document) as { identity: string } | undefined : undefined;
  const stillCurrent = () => row.connector_id !== 'microblog' || (
    getAccount(db, row.user_id, row.connector_id)?.cred_enc === account.cred_enc && (!originalPost ||
      (db.prepare('SELECT identity FROM microblog_clipping_posts WHERE user_id=? AND document=?').get(row.user_id, row.document) as { identity: string } | undefined)?.identity === originalPost.identity)
  );
  if (row.connector_id === 'microblog' && ev.kind === 'highlight'
      && !getMatch(db, row.user_id, 'microblog', row.document)?.external_id) {
    // Publication intent remains durable; a later matched sync reschedules it.
    markDone(db, row.id);
    return;
  }
  if (connector.shouldPush?.(
    ev,
    latestPercentage(db, row.user_id, row.document)
  ) === false) {
    markDone(db, row.id);
    return;
  }

  let match: Match | null;
  try {
    match = await resolveMatch(db, row.connector_id, row.user_id, row.document, http, ev);
    if (!stillCurrent()) return;
  } catch (err) {
    if (!stillCurrent()) return;
    failOperation(db, row, err, 'match failed');
    return;
  }
  if (!match) {
    // Unmatched documents can't be pushed; drop this event (a later manual
    // match + fresh sync will re-enqueue). Not an error state.
    markFailed(db, row, 'no book match', false);
    return;
  }

  const cred = decryptCredential(account, db);
  try {
    const result = await connector.push(cred, match, ev, http, { db, userId: row.user_id });
    if (!stillCurrent()) return;
    if (result.ok) {
      // Persist (or clear) the per-book condition so the review UI can show it.
      setMatchNote(db, row.user_id, row.connector_id, row.document, result.note ?? null);
      markDone(db, row.id);
      // A progress push may have established the first match, or a clipping
      // may have arrived while publication was in flight.
      if (row.connector_id === 'microblog') {
        try {
          scheduleMicroblogClippings(db, row.user_id, row.document);
        } catch (err) {
          console.error(JSON.stringify({ msg: 'microblog schedule failed', user_id: row.user_id, document: row.document,
            error: err instanceof Error ? err.message : String(err) }));
        }
      }
      return;
    }
    if (result.needsReauth) {
      setAccountStatus(db, row.user_id, row.connector_id, 'needs_reauth', result.error);
    }
    logPushFailure(row, result.error, result.retryable);
    markFailed(db, row, result.error, result.retryable);
  } catch (err) {
    if (!stillCurrent()) return;
    failOperation(db, row, err, 'push failed');
  }
}

function failOperation(db: DB, row: QueueRow, err: unknown, prefix: string): void {
  const error = `${prefix}: ${errStr(err)}`;
  const retryable = err instanceof ConnectorOperationError ? err.retryable : true;
  if (err instanceof ConnectorOperationError && err.needsReauth) {
    setAccountStatus(db, row.user_id, row.connector_id, 'needs_reauth', err.message);
  }
  logPushFailure(row, error, retryable);
  markFailed(db, row, error, retryable);
}

/** Surface a push failure in stdout (Railway/Docker logs), not just the DB row. */
function logPushFailure(row: QueueRow, error: string | undefined, retryable: boolean): void {
  console.error(
    JSON.stringify({
      msg: 'connector push failed',
      connector: row.connector_id,
      user_id: row.user_id,
      document: row.document,
      kind: row.kind,
      attempts: row.attempts + 1,
      outcome: retryable && row.attempts + 1 < _internals.MAX_ATTEMPTS ? 'retry' : 'dead',
      error: error ?? 'unknown',
    })
  );
}

/** Drain up to `limit` ready events. Returns the number processed. */
export async function drainQueue(
  db: DB,
  http: HttpTransport = fetchTransport,
  limit = 20,
  now = nowSeconds()
): Promise<number> {
  const rows = claimReady(db, limit, now);
  for (const row of rows) {
    await processRow(db, row, http);
  }
  return rows.length;
}

function errStr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Start a periodic drain loop; returns a stop function. */
export function startQueueWorker(db: DB, intervalMs = 15_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return; // never overlap drains
    running = true;
    try {
      await drainQueue(db);
    } catch (err) {
      console.error(JSON.stringify({ msg: 'queue drain error', error: errStr(err) }));
    } finally {
      running = false;
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
