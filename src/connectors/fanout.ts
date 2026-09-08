import type { DB } from '../db/db.js';
import { secretsEnabled } from '../crypto/secrets.js';
import { getConnector } from './registry.js';
import { enqueue } from './queue.js';
import { activeConnectorIds, documentMeta, getMatch } from './store.js';
import { extractTitleAuthor } from './matching.js';
import { nowSeconds } from '../models/sync.js';
import type { Connector, OutboundEvent } from './types.js';

/**
 * Whether it's worth attempting a document on this connector. Metadata-matched
 * services (Hardcover, BookFusion, Audiobookshelf) can only match a book we have
 * title/author for, so a document with no metadata and no existing match would
 * just dead-letter as "no book match" - skip it. Document-keyed connectors (a
 * kosync mirror) always apply. A manual "no match" override also skips.
 */
export function isAttemptable(db: DB, userId: number, conn: Connector, document: string): boolean {
  if (conn.matchBy === 'document') return true;
  const match = getMatch(db, userId, conn.id, document);
  if (match) {
    if (match.external_id != null) return true; // already matched
    if (match.source === 'manual') return false; // explicit "don't sync this"
  }
  // No usable match yet: only attempt if we have metadata to match on.
  return extractTitleAuthor(documentMeta(db, userId, document)) != null;
}

/**
 * Enqueue canonical reading events to every linked connector that carries the
 * event's kind. Best-effort and synchronous-but-cheap (DB inserts only); the
 * queue worker does the network I/O. Never throws into the request path.
 */
function fanOut(
  db: DB,
  userId: number,
  ev: OutboundEvent,
  coalesceKey?: string,
  exceptConnectorId?: string
): void {
  if (!secretsEnabled()) return;
  try {
    for (const connectorId of activeConnectorIds(db, userId)) {
      if (connectorId === exceptConnectorId) continue; // loop suppression: don't echo to the source
      const conn = getConnector(connectorId);
      if (!conn || !conn.capabilities.write || !conn.carries.includes(ev.kind)) continue;
      if (!isAttemptable(db, userId, conn, ev.document)) continue; // no metadata/match: skip
      enqueue(db, userId, connectorId, ev, coalesceKey);
    }
  } catch (err) {
    console.error(
      JSON.stringify({ msg: 'fanout enqueue failed', error: err instanceof Error ? err.message : String(err) })
    );
  }
}

export function fanOutProgress(
  db: DB,
  userId: number,
  document: string,
  percentage: number,
  timestamp: number,
  progress?: string,
  positionJson?: string | null,
  exceptConnectorId?: string
): void {
  const finished = percentage >= 0.98;
  let position: Record<string, unknown> | null = null;
  if (positionJson) {
    try {
      position = JSON.parse(positionJson) as Record<string, unknown>;
    } catch {
      position = null;
    }
  }
  fanOut(
    db,
    userId,
    {
      kind: finished ? 'finished' : 'progress',
      document,
      percentage,
      progress,
      position,
      timestamp,
    },
    undefined,
    exceptConnectorId
  );
}

export function fanOutHighlight(
  db: DB,
  userId: number,
  document: string,
  clippingId: string,
  h: NonNullable<OutboundEvent['highlight']>,
  timestamp: number
): void {
  // Per-clipping coalesce key so distinct highlights on one book each queue.
  fanOut(db, userId, { kind: 'highlight', document, timestamp, highlight: h }, `highlight:${clippingId}`);
}

/**
 * Backfill a single connector with everything already synced ("Sync now").
 * Enqueues the latest progress per document (and highlights, if it carries
 * them) so a freshly linked service catches up on your history. Coalesce keys
 * match live fan-out, so a later real sync collapses onto the backfilled event.
 * Returns the number of items queued.
 */
export function backfillConnector(db: DB, userId: number, connectorId: string): number {
  if (!secretsEnabled()) return 0;
  const conn = getConnector(connectorId);
  if (!conn || !conn.capabilities.write) return 0;
  let queued = 0;

  if (conn.carries.includes('progress') || conn.carries.includes('finished')) {
    const rows = db
      .prepare(
        `SELECT p.document, p.percentage, p.progress, p.position, p.updated_at
         FROM progress p
         WHERE p.user_id = ?
           AND p.updated_at = (
             SELECT MAX(p2.updated_at) FROM progress p2
             WHERE p2.user_id = p.user_id AND p2.document = p.document
           )
           AND p.device_id = (
             SELECT MIN(p3.device_id) FROM progress p3
             WHERE p3.user_id = p.user_id AND p3.document = p.document
               AND p3.updated_at = p.updated_at
           )`
      )
      .all(userId) as {
      document: string;
      percentage: number;
      progress: string;
      position: string | null;
      updated_at: number;
    }[];
    for (const r of rows) {
      const finished = r.percentage >= 0.98;
      const kind = finished ? 'finished' : 'progress';
      if (!conn.carries.includes(kind)) continue;
      if (!isAttemptable(db, userId, conn, r.document)) continue; // no metadata/match: skip
      let position: Record<string, unknown> | null = null;
      if (r.position) {
        try {
          position = JSON.parse(r.position) as Record<string, unknown>;
        } catch {
          position = null;
        }
      }
      enqueue(db, userId, connectorId, {
        kind,
        document: r.document,
        percentage: r.percentage,
        progress: r.progress,
        position,
        timestamp: r.updated_at,
      });
      queued++;
    }
  }

  if (conn.carries.includes('highlight')) {
    const rows = db
      .prepare(
        `SELECT c.id, c.document, c.text, c.note, c.created_at, d.title, d.author
         FROM clippings c
         LEFT JOIN documents d ON d.user_id = c.user_id AND d.document = c.document
         WHERE c.user_id = ? AND c.deleted = 0`
      )
      .all(userId) as {
      id: string;
      document: string;
      text: string;
      note: string | null;
      created_at: number;
      title: string | null;
      author: string | null;
    }[];
    for (const r of rows) {
      enqueue(
        db,
        userId,
        connectorId,
        {
          kind: 'highlight',
          document: r.document,
          timestamp: r.created_at || nowSeconds(),
          highlight: {
            text: r.text,
            note: r.note,
            title: r.title,
            author: r.author,
            highlightedAt: r.created_at > 0 ? r.created_at : null,
          },
        },
        `highlight:${r.id}`
      );
      queued++;
    }
  }

  return queued;
}
