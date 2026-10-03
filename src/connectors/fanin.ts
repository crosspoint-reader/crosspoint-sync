import { createHash } from 'node:crypto';
import { withTransaction, type DB } from '../db/db.js';
import { nowSeconds } from '../models/sync.js';
import { getConnector, fetchTransport } from './registry.js';
import { fanOutHighlight, fanOutProgress } from './fanout.js';
import { clippingDocuments } from '../models/merge.js';
import { nearestProgressSample, recordProgressSample, upsertProgress } from '../routes/kosync.js';
import {
  decryptCredential,
  documentMeta,
  documentForExternal,
  getAccount,
  getPullCursor,
  latestProgress,
  listMatches,
  getMatch,
  setAccountStatus,
  listAllEnabledAccounts,
  setPullCursor,
  usersWithMatches,
  inProgressDocuments,
  seedMatchSnapshots,
} from './store.js';
import { resolveMatch } from './runner.js';
import { spotifyPaused } from './spotify.js';
import { ConnectorOperationError, type InboundChange, type InboundHighlight, type HttpTransport } from './types.js';

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
    // Furthest-read-only sources (Kindle FRL): apply only when ADVANCING the
    // canonical position. A lower-or-equal value is always stale — FRL can't be
    // behind when the user has read further anywhere — so this also covers
    // undated annotations, which can't be ordered by timestamp at all.
    if (ch.furthestReadOnly && current && pct <= current.percentage) return 0;
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
    const credential = decryptCredential(account, db);
    const matches = options.document ? [getMatch(db, userId, connectorId, options.document)] : listMatches(db, userId, connectorId);
    for (const match of matches) {
      if (!match?.external_id) continue;
      try {
        const current = latestProgress(db, userId, match.document);
        const change = await conn.pullProgress(credential, {
          externalId: match.external_id, externalEdition: match.external_edition,
          confidence: match.confidence, fromSidecar: match.source === 'sidecar',
        }, http, (current?.updated_at ?? 0) * 1000, { db, userId });
        options.signal?.throwIfAborted();
        // The account, match, or canonical progress can change while the request is in flight.
        const freshAccount = getAccount(db, userId, connectorId);
        if (!freshAccount?.enabled || freshAccount.cred_enc !== account.cred_enc || freshAccount.status !== 'ok') break;
        const freshMatch = getMatch(db, userId, connectorId, match.document);
        if (change && freshMatch?.external_id === match.external_id && freshMatch.source === match.source) {
          applied += apply(change, match.document);
        }
        if (conn.pullHighlights && freshMatch?.external_id === match.external_id) {
          const known = clippingTexts(db, userId, match.document);
          const highlights = await conn.pullHighlights(credential, {
            externalId: match.external_id, externalEdition: match.external_edition, confidence: match.confidence,
          }, http, (t) => known.has(squash(t)));
          options.signal?.throwIfAborted();
          importHighlights(db, userId, match.document, highlights, connectorId);
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
    changes = await conn.pullChanges!(decryptCredential(account, db), http, since);
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

// Whitespace and soft hyphens differ between device clipping text and provider quotes.
const squash = (t: string) => t.replace(/[\s\u00ad]+/g, '');
const MAX_TEXT = 4096;

/** Every quote ever clipped on this book (tombstones too, so deletions stay deleted). */
function clippingTexts(db: DB, userId: number, document: string): Set<string> {
  const docs = clippingDocuments(db, userId, document);
  const rows = db.prepare(
    `SELECT text FROM clippings WHERE user_id = ? AND document IN (${docs.map(() => '?').join(',')}) AND text IS NOT NULL`
  ).all(userId, ...docs) as { text: string }[];
  return new Set(rows.map((r) => squash(r.text)));
}

/**
 * Store provider highlights as clippings so devices pick them up on their next
 * clippings sync, then fan them out to the other highlight services. Ids follow
 * the clipping rule (SHA-256 of created_at + text); an existing id, live or
 * tombstoned, is left alone.
 */
function importHighlights(db: DB, userId: number, document: string, items: InboundHighlight[], source: string): void {
  const known = clippingTexts(db, userId, document);
  const fresh = items.filter((h) => Buffer.byteLength(h.text) <= MAX_TEXT);
  if (!fresh.length) return;
  const now = nowSeconds();
  const bump = db.prepare('UPDATE clipping_sync_clock SET revision = revision + 1 WHERE id = 1');
  const insert = db.prepare(
    `INSERT INTO clippings (user_id, document, id, spine_index, start_page, end_page, page_count,
                            start_word, end_word, word_count, paragraph_index, chapter_title, text,
                            note, color, created_at, deleted, updated_at, layout_signature, start_offset, end_offset, revision)
     VALUES (?, ?, ?, ?, 0, 0, 1, 0, 0, 0, NULL, ?, ?, ?, NULL, ?, 0, ?, 0, ?, ?,
             (SELECT revision FROM clipping_sync_clock WHERE id = 1))
     ON CONFLICT(user_id, document, id) DO NOTHING`
  );
  const added: { id: string; h: InboundHighlight }[] = [];
  withTransaction(db, () => {
    for (const h of fresh) {
      if (known.has(squash(h.text))) continue;
      const id = createHash('sha256').update(`${h.createdAt}${h.text}`).digest('hex').slice(0, 16);
      const note = h.note && Buffer.byteLength(h.note) <= 4096 ? h.note : null;
      bump.run();
      const r = insert.run(userId, document, id, h.spine, (h.chapter ?? '').slice(0, 64), h.text, note,
        h.createdAt, now, h.startOffset, h.endOffset);
      if (r.changes) { added.push({ id, h }); known.add(squash(h.text)); }
    }
  });
  const meta = documentMeta(db, userId, document);
  for (const { id, h } of added) {
    fanOutHighlight(db, userId, document, id, {
      text: h.text, note: h.note, title: meta.title, author: meta.author,
      highlightedAt: h.createdAt || null, spine: h.spine, startOffset: h.startOffset,
      endOffset: h.endOffset, chapter: h.chapter,
    }, now, source);
  }
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

/**
 * Spotify's hourly pull, for every healthy account with a matched book: the same
 * per-book pull as a progress request. Revoked tokens mark the account
 * needs_reauth (pollConnector), and a 429 stops the run until next time.
 */
export async function pollSpotify(db: DB, http: HttpTransport = fetchTransport): Promise<number> {
  let total = 0;
  for (const userId of usersWithMatches(db, 'spotify')) {
    if (spotifyPaused()) break;
    total += await pollConnector(db, userId, 'spotify', http);
  }
  return total;
}

/**
 * Right after Spotify is first linked: match every book in progress, then take
 * Spotify's position wherever it's ahead. Matching from a zero snapshot makes
 * any real listening (past the threshold) count as a change seen now.
 */
export async function spotifyFirstSync(db: DB, userId: number, http: HttpTransport = fetchTransport): Promise<number> {
  // ponytail: sequential, about two calls per book; batch if libraries get large.
  for (const document of inProgressDocuments(db, userId)) {
    if (spotifyPaused()) break;
    await resolveMatch(db, 'spotify', userId, document, http).catch(() => null);
  }
  seedMatchSnapshots(db, userId, 'spotify', { chapterIndex: 0, offsetMs: 0, finished: false });
  return pollConnector(db, userId, 'spotify', http);
}

/** Start a periodic fan-in poller (pollAll by default); returns a stop function. */
export function startFanInWorker(db: DB, intervalMs = 5 * 60_000, poll = pollAll): () => void {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await poll(db);
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
