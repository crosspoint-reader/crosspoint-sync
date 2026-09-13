import type { DB } from '../db/db.js';
import { nowSeconds } from '../models/sync.js';
import { getConnector, fetchTransport } from './registry.js';
import { fanOutProgress } from './fanout.js';
import { nearestProgressSample, recordProgressSample, upsertProgress } from '../routes/kosync.js';
import {
  decryptCredential,
  documentForExternal,
  getAccount,
  getPullCursor,
  latestProgress,
  listMatches,
  getMatch,
  setAccountStatus,
  listAllEnabledAccounts,
  setPullCursor,
} from './store.js';
import { ConnectorOperationError, type InboundChange, type HttpTransport } from './types.js';

// Skip an inbound change whose percentage already matches our stored progress
// (within this window). This suppresses the echo of a value we just pushed OUT
// to the same service, so read->push->pull doesn't loop.
const ECHO_EPSILON = 0.005;

/**
 * Pull position changes from one connector and apply them to canonical progress.
 * Maps each change back to our document via the match table, writes it as a
 * per-connector "device" row so the reader picks it up (newest-wins kosync GET),
 * and re-fans-out to the OTHER services (not back to the source). Returns the
 * number of changes applied.
 */
export async function pollConnector(
  db: DB,
  userId: number,
  connectorId: string,
  http: HttpTransport = fetchTransport,
  options: { document?: string; signal?: AbortSignal; throwOnError?: boolean } = {}
): Promise<number> {
  const conn = getConnector(connectorId);
  const account = getAccount(db, userId, connectorId);
  if (!conn || !account || !account.enabled || account.status === 'needs_reauth' ||
      (!conn.pullChanges && !conn.pullProgress) || !conn.capabilities.read) return 0;

  function apply(ch: InboundChange, document: string): number {
    const exact = ch.progress !== undefined;
    const current = latestProgress(db, userId, document);
    const updatedAt = exact ? Math.floor(ch.updatedAtMs / 1000) : nowSeconds();
    if (exact && current && updatedAt <= current.updated_at) return 0;
    const pct = exact ? ch.percentage : ch.finished || ch.percentage >= 0.999 ? 1 : ch.percentage;
    const samePosition = current && Math.abs(current.percentage - pct) < (exact ? 0.000001 : ECHO_EPSILON) &&
      (!exact || current.progress.replace(/\[1\]/g, '') === ch.progress!.replace(/\[1\]/g, ''));
    if (samePosition && !exact) return 0;
    // Percentage-only providers use recorded samples; exact providers never borrow a stale page.
    const sample = exact ? null : nearestProgressSample(db, userId, document, pct);
    const progress = ch.progress ?? sample?.progress ?? `${connectorId}:${Math.round(pct * 1_000_000)}`;
    const position = sample?.position ?? null;
    upsertProgress(db, {
      userId, document, deviceId: connectorId, device: conn!.displayName,
      percentage: pct, progress, position, metadata: null, updatedAt,
    });
    if (exact) recordProgressSample(db, userId, document, pct, progress, null, updatedAt);
    if (samePosition) return 0; // Remember the source timestamp without echoing our own push.
    fanOutProgress(db, userId, document, pct, updatedAt, progress, position, connectorId);
    return 1;
  }

  if (conn.pullProgress) {
    let applied = 0;
    const credential = decryptCredential(account);
    const matches = options.document ? [getMatch(db, userId, connectorId, options.document)] : listMatches(db, userId, connectorId);
    for (const match of matches) {
      if (!match?.external_id) continue;
      try {
        const current = latestProgress(db, userId, match.document);
        const change = await conn.pullProgress(credential, {
          externalId: match.external_id, confidence: match.confidence, fromSidecar: match.source === 'sidecar',
        }, http, (current?.updated_at ?? 0) * 1000);
        options.signal?.throwIfAborted();
        // The account, match, or canonical progress can change while the request is in flight.
        const freshAccount = getAccount(db, userId, connectorId);
        if (!freshAccount?.enabled || freshAccount.cred_enc !== account.cred_enc || freshAccount.status !== 'ok') break;
        const freshMatch = getMatch(db, userId, connectorId, match.document);
        if (change && freshMatch?.external_id === match.external_id && freshMatch.source === match.source) {
          applied += apply(change, match.document);
        }
      } catch (err) {
        console.error(JSON.stringify({ msg: 'connector pull failed', connector: connectorId, user_id: userId,
          document: match.document, error: err instanceof Error ? err.message : 'pull failed' }));
        if (err instanceof ConnectorOperationError && err.needsReauth) {
          setAccountStatus(db, userId, connectorId, 'needs_reauth', err.message);
          if (options.throwOnError) throw err;
          break;
        }
        if (options.throwOnError) throw err;
      }
    }
    return applied;
  }

  const since = getPullCursor(db, userId, connectorId);
  let changes;
  try {
    changes = await conn.pullChanges!(decryptCredential(account), http, since);
  } catch {
    return 0; // best-effort; try again next tick
  }
  let applied = 0;
  let maxCursor = since;
  for (const ch of changes) {
    if (ch.updatedAtMs > maxCursor) maxCursor = ch.updatedAtMs;
    const document = documentForExternal(db, userId, connectorId, ch.externalId);
    if (document) applied += apply(ch, document);
  }

  if (maxCursor > since) setPullCursor(db, userId, connectorId, maxCursor);
  return applied;
}

/** Poll library-wide providers; per-book providers refresh on progress requests. */
export async function pollAll(db: DB, http: HttpTransport = fetchTransport): Promise<number> {
  let total = 0;
  for (const { user_id, connector_id } of listAllEnabledAccounts(db)) {
    const conn = getConnector(connector_id);
    if (!conn?.capabilities.read || !conn.pullChanges) continue;
    total += await pollConnector(db, user_id, connector_id, http);
  }
  return total;
}

/** Start the periodic fan-in poller; returns a stop function. */
export function startFanInWorker(db: DB, intervalMs = 5 * 60_000): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await pollAll(db);
    } catch (err) {
      console.error(
        JSON.stringify({ msg: 'fan-in poll error', error: err instanceof Error ? err.message : String(err) })
      );
    } finally {
      running = false;
    }
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
