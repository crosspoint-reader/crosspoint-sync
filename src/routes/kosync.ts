import type { ProgressRefresh } from '../connectors/refresh.js';
import { Hono } from 'hono';
import { withTransaction, type DB } from '../db/db.js';
import type { Config } from '../config.js';
import { autoFinish, autoPause, autoUnpause } from '../models/pause.js';
import {
  authMiddleware,
  invalidateAuthCache,
  kosyncError,
  rateLimiter,
  type AppEnv,
} from '../auth/middleware.js';
import { hashKey, looksLikeMd5, md5Hex } from '../auth/password.js';
import { parsePosition } from '../models/position.js';
import { resolveDocument } from '../models/merge.js';
import { nowSeconds } from '../models/sync.js';
import { nextChangeSeq } from '../models/changes.js';
import { fanOutProgress } from '../connectors/fanout.js';
import { seedSidecarMatches } from '../connectors/store.js';
import { getConnector } from '../connectors/registry.js';

export const USERNAME_RE = /^[A-Za-z0-9._@+-]{1,64}$/;

export function isValidDocument(v: unknown): v is string {
  // KOReader sends a 32-hex MD5, but the key is opaque - stay lenient.
  return typeof v === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(v);
}

export interface ProgressUpsert {
  userId: number;
  document: string;
  deviceId: string;
  device: string;
  percentage: number;
  progress: string;
  position: string | null;
  metadata: DocumentMetadata | null;
  updatedAt: number;
}

/** Optional document metadata sent by CrossPoint/KOReader (KOReader PR #15306). */
export interface DocumentMetadata {
  filename: string | null;
  title: string | null;
  authors: string | null;
  /**
   * Service book ids from the CrossPoint plugin sidecar ("<book>.meta.json"),
   * keyed by service name. A plugin that downloads a book records e.g.
   * `{"bookfusion_id": "36835"}`; the firmware forwards any `<service>_id`
   * field here so we can push progress to that exact record instead of
   * fuzzy-matching by title. Empty when no sidecar id was sent.
   */
  externalIds: Record<string, string>;
}

// Sidecar convention: a flat `<service>_id` field names the connector
// ("bookfusion_id" -> connector "bookfusion"). Reserved keys are not ids.
const RESERVED_META_KEYS = new Set(['filename', 'title', 'authors', 'source']);

function parseMetadata(raw: unknown): DocumentMetadata | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v.slice(0, 512) : null);
  const externalIds: Record<string, string> = {};
  for (const [key, value] of Object.entries(o)) {
    if (RESERVED_META_KEYS.has(key)) continue;
    const m = /^([a-z0-9]+)_id$/.exec(key);
    const id = str(value);
    if (m && id) externalIds[m[1]] = id;
  }
  const meta: DocumentMetadata = {
    filename: str(o.filename),
    title: str(o.title),
    authors: str(o.authors),
    externalIds,
  };
  const hasId = Object.keys(externalIds).length > 0;
  return meta.filename || meta.title || meta.authors || hasId ? meta : null;
}

/** Stores progress-PUT metadata without clobbering fields the client didn't send. */
export function upsertDocumentMetadata(
  db: DB,
  userId: number,
  document: string,
  meta: DocumentMetadata,
  updatedAt: number
): void {
  db.prepare(
    `INSERT INTO documents (user_id, document, title, author, filename, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, document) DO UPDATE SET
       title = CASE WHEN documents.meta_manual THEN documents.title ELSE COALESCE(excluded.title, documents.title) END,
       author = CASE WHEN documents.meta_manual THEN documents.author ELSE COALESCE(excluded.author, documents.author) END,
       filename = COALESCE(excluded.filename, documents.filename),
       updated_at = excluded.updated_at`
  ).run(userId, document, meta.title, meta.authors, meta.filename, updatedAt);
}

/**
 * A "real" KOReader position we can later replay: an xpointer (EPUB, starts with
 * "/") or a page number (PDF). Synthetic connector strings (e.g.
 * "audiobookshelf:405000") are excluded - replaying one seeks nowhere.
 */
export function isRealPosition(progress: string | null | undefined): boolean {
  if (!progress) return false;
  return progress.startsWith('/') || /^\d+(\.\d+)?$/.test(progress);
}

/**
 * Record a (percentage -> real position) sample for a document. Bucketed to
 * 0.1% so the table stays bounded; the newest position wins within a bucket.
 * These samples let fan-in translate a percentage-only update into a real
 * position (see nearestProgressSample).
 */
export function recordProgressSample(
  db: DB,
  userId: number,
  document: string,
  percentage: number,
  progress: string,
  position: string | null,
  updatedAt: number
): void {
  if (!isRealPosition(progress)) return;
  const pct = Math.max(0, Math.min(1, percentage));
  const bucket = Math.round(pct * 1000);
  db.prepare(
    `INSERT INTO progress_samples (user_id, document, pct_bucket, percentage, progress, position, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, document, pct_bucket) DO UPDATE SET
       percentage = excluded.percentage,
       progress = excluded.progress,
       position = excluded.position,
       updated_at = excluded.updated_at`
  ).run(userId, document, bucket, pct, progress, position, updatedAt);
}

/**
 * Find the real position whose recorded percentage is closest to `pct`. Used to
 * turn a percentage-only fan-in update into a position stock KOReader can seek
 * to. Returns null when we've never seen a real position for this document.
 */
/** How far (0..1) a recorded real position may be from a percentage-only one and still stand in for it: about 2 pages of a 400-page book. */
export const SAMPLE_REACH = 0.005;

export function nearestProgressSample(
  db: DB,
  userId: number,
  document: string,
  pct: number
): { progress: string; position: string | null; percentage: number } | null {
  const row = db
    .prepare(
      `SELECT progress, position, percentage
       FROM progress_samples
       WHERE user_id = ? AND document = ?
       ORDER BY ABS(percentage - ?) ASC
       LIMIT 1`
    )
    .get(userId, document, Math.max(0, Math.min(1, pct))) as
    | { progress: string; position: string | null; percentage: number }
    | undefined;
  // Only a nearby real position stands in for this one. A far one (you listened
  // past anything the reader has seen) would send the reader to the wrong place,
  // and CrossPoint compares locations: a borrowed copy of its own reads as
  // "already synced". Without one, the percentage alone goes out; CrossPoint
  // opens that, stock KOReader can't.
  return row && Math.abs(row.percentage - pct) <= SAMPLE_REACH ? row : null;
}

/** The shared device id every CrossInk reader sent before per-reader ids. */
export const LEGACY_CROSSINK_DEVICE_ID = 'crossink-device';

/**
 * The percentage a progress write is compared against to decide whether it is
 * a new history entry. Normally that device's own previous row. A device with
 * no row yet compares against:
 * 1. the legacy shared CrossInk row, for a per-reader CrossInk id, so switching
 *    ids logs exactly what the shared row would have; otherwise
 * 2. the document's newest row from any device, so a new reader re-pushing a
 *    position another device already reported adds no reading day.
 */
function previousPercentage(db: DB, p: ProgressUpsert): number | undefined {
  const own = db
    .prepare('SELECT percentage FROM progress WHERE user_id = ? AND document = ? AND device_id = ?')
    .get(p.userId, p.document, p.deviceId) as { percentage: number } | undefined;
  if (own) return own.percentage;
  if (p.deviceId.startsWith('crossink-') && p.deviceId !== LEGACY_CROSSINK_DEVICE_ID) {
    const legacy = db
      .prepare('SELECT percentage FROM progress WHERE user_id = ? AND document = ? AND device_id = ?')
      .get(p.userId, p.document, LEGACY_CROSSINK_DEVICE_ID) as { percentage: number } | undefined;
    if (legacy) return legacy.percentage;
  }
  const newest = db
    .prepare(
      `SELECT percentage FROM progress WHERE user_id = ? AND document = ?
       ORDER BY updated_at DESC, device_id LIMIT 1`
    )
    .get(p.userId, p.document) as { percentage: number } | undefined;
  return newest?.percentage;
}

export function upsertProgress(db: DB, p: ProgressUpsert): void {
  withTransaction(db, () => {
    const previous = db.prepare(
      `SELECT device_id FROM progress WHERE user_id = ? AND document = ?
       ORDER BY updated_at DESC, device_id LIMIT 1`
    ).get(p.userId, p.document) as { device_id: string } | undefined;
    const seq = nextChangeSeq(db);
    // History for server-derived activity stats; skip re-pushes of the same spot.
    if (previousPercentage(db, p) !== p.percentage) {
      db.prepare('INSERT INTO progress_log (user_id, document, device_id, percentage, at) VALUES (?, ?, ?, ?, ?)').run(
        p.userId,
        p.document,
        p.deviceId,
        p.percentage,
        p.updatedAt
      );
      autoUnpause(db, p.userId, p.document, p.updatedAt);
      autoFinish(db, p.userId, p.document, p.percentage, p.updatedAt);
    }
    // Every write gets a fresh feed sequence number, even a same-spot re-push:
    // it may have become the document's newest row.
    db.prepare(
      `INSERT INTO progress (user_id, document, device_id, device, percentage, progress, position, updated_at, change_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, document, device_id) DO UPDATE SET
         device = excluded.device,
         percentage = excluded.percentage,
         progress = excluded.progress,
         position = COALESCE(excluded.position, progress.position),
         updated_at = excluded.updated_at,
         change_seq = excluded.change_seq`
    ).run(
      p.userId,
      p.document,
      p.deviceId,
      p.device,
      p.percentage,
      p.progress,
      p.position,
      p.updatedAt,
      seq
    );
    if (p.metadata) {
      upsertDocumentMetadata(db, p.userId, p.document, p.metadata, p.updatedAt);
      // Exact service ids from the plugin sidecar bypass fuzzy matching: seed the
      // connector match cache so the runner pushes straight to that record.
      if (Object.keys(p.metadata.externalIds).length > 0) {
        seedSidecarMatches(
          db,
          p.userId,
          p.document,
          p.metadata.externalIds,
          (id) => getConnector(id) !== undefined,
          p.updatedAt
        );
      }
    }
    // A write can lower the previous winner's timestamp (for example after a
    // merge). If an untouched row now wins, give that effective position this
    // write's sequence and mark it as a server-made change for every reader.
    if (previous?.device_id === p.deviceId) {
      db.prepare(
        `UPDATE progress SET change_seq = ?, server_change_seq = ?
         WHERE rowid = (
           SELECT rowid FROM progress WHERE user_id = ? AND document = ?
           ORDER BY updated_at DESC, device_id LIMIT 1
         ) AND device_id <> ?`
      ).run(seq, seq, p.userId, p.document, p.deviceId);
    }
  });
}

/**
 * Validates a kosync progress PUT body. Returns the upsert-ready record or an
 * error message. Also captures an optional rich `position` object (CrossPoint
 * superset) when present and valid.
 */
export function parseProgressBody(
  userId: number,
  body: unknown
): { ok: true; record: ProgressUpsert } | { ok: false; code: number; message: string } {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, code: 2003, message: 'Invalid request' };
  }
  const o = body as Record<string, unknown>;
  if (!isValidDocument(o.document)) {
    return { ok: false, code: 2004, message: "Field 'document' not provided." };
  }
  if (typeof o.progress !== 'string' || o.progress.length === 0 || o.progress.length > 4096) {
    return { ok: false, code: 2003, message: 'Invalid request' };
  }
  const percentage = typeof o.percentage === 'string' ? Number(o.percentage) : o.percentage;
  if (typeof percentage !== 'number' || !Number.isFinite(percentage) || percentage < 0 || percentage > 1) {
    return { ok: false, code: 2003, message: 'Invalid request' };
  }
  const device = typeof o.device === 'string' ? o.device.slice(0, 128) : '';
  const deviceId =
    typeof o.device_id === 'string' && o.device_id.length > 0
      ? o.device_id.slice(0, 128)
      : device; // some KOReader configs omit device_id
  let position: string | null = null;
  if (o.position !== undefined) {
    const parsed = parsePosition(o.position);
    if (parsed) position = JSON.stringify(parsed);
  }
  return {
    ok: true,
    record: {
      userId,
      document: o.document,
      deviceId,
      device,
      percentage,
      progress: o.progress,
      position,
      metadata: parseMetadata(o.metadata),
      updatedAt: nowSeconds(),
    },
  };
}

/**
 * Stores a device's progress write the way the kosync PUT does: under the
 * document's canonical hash, as a position sample for fan-in replays, and fanned
 * out to connected services. Returns the hash the client sent, which responses
 * echo so the device recognizes them. Shared by the kosync PUT and the batch
 * route, so both writes behave identically.
 */
export function writeDeviceProgress(db: DB, record: ProgressUpsert): string {
  const clientDocument = record.document;
  record.document = resolveDocument(db, record.userId, clientDocument);
  upsertProgress(db, record);
  // Harvest this real device position as a (percentage -> position) sample so
  // fan-in can later replay a real position for a percentage-only update.
  recordProgressSample(
    db,
    record.userId,
    record.document,
    record.percentage,
    record.progress,
    record.position,
    record.updatedAt
  );
  return clientDocument;
}

export function fanOutDeviceProgress(db: DB, record: ProgressUpsert): void {
  fanOutProgress(db, record.userId, record.document, record.percentage, record.updatedAt, record.progress, record.position);
}

export function kosyncRoutes(db: DB, config: Config, refreshProgress: ProgressRefresh = async () => {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const auth = authMiddleware(db);

  app.post('/users/create', rateLimiter(config.authRateLimitPerMinute), async (c) => {
    if (config.registrationDisabled) {
      return kosyncError(c, 403, 2003, 'Registration is disabled');
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const o = (body ?? {}) as Record<string, unknown>;
    // New names are stored lowercase; existing mixed-case names are left as-is.
    const username = typeof o.username === 'string' ? o.username.toLowerCase() : o.username;
    const password = o.password;
    if (
      typeof username !== 'string' ||
      !USERNAME_RE.test(username) ||
      typeof password !== 'string' ||
      password.length === 0 ||
      password.length > 128
    ) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const exists = db.prepare('SELECT 1 FROM users WHERE username = ?').get(username);
    if (exists) {
      return kosyncError(c, 402, 2002, 'Username is already registered.');
    }
    // kosync convention: `password` is already MD5(password). Some third-party
    // clients register with the raw password instead; normalize to the MD5 form
    // so the stored hash matches later x-auth-key logins from either kind of
    // client (auth also accepts raw keys by hashing them, see authMiddleware).
    const md5Key = looksLikeMd5(password) ? password : md5Hex(password);
    db.prepare('INSERT INTO users (username, key_hash, created_at) VALUES (?, ?, ?)').run(
      username,
      hashKey(md5Key),
      nowSeconds()
    );
    invalidateAuthCache(username);
    return c.json({ username }, 201);
  });

  app.get('/users/auth', auth, (c) => c.json({ authorized: 'OK' }));

  app.put('/syncs/progress', auth, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    const parsed = parseProgressBody(user.id, body);
    if (!parsed.ok) {
      return kosyncError(c, 403, parsed.code, parsed.message);
    }
    // A merged document stores under its canonical hash; echo the client's own
    // hash back so the device recognizes the response.
    const clientDocument = writeDeviceProgress(db, parsed.record);
    fanOutDeviceProgress(db, parsed.record);
    return c.json({ document: clientDocument, timestamp: parsed.record.updatedAt });
  });

  app.get('/syncs/progress/:document', auth, async (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    const canonical = resolveDocument(db, user.id, document);
    try {
      await refreshProgress(user.id, canonical);
    } catch (error) {
      const status = error instanceof Error && error.name === 'TimeoutError' ? 504 : 502;
      return c.json({ code: 2003, message: 'BookFusion progress refresh failed' }, status);
    }
    autoPause(db, { userId: user.id, document: canonical });
    const row = db
      .prepare(
        `SELECT document, progress, percentage, device, device_id, updated_at
         FROM progress WHERE user_id = ? AND document = ?
         ORDER BY updated_at DESC, device_id LIMIT 1`
      )
      .get(user.id, canonical) as
      | {
          document: string;
          progress: string;
          percentage: number;
          device: string;
          device_id: string;
          updated_at: number;
        }
      | undefined;
    if (!row) {
      // Stock kosync returns 200 with an empty object; KOReader clients rely on it.
      return c.json({});
    }
    return c.json({
      document, // the hash the client asked about, not the canonical one
      progress: row.progress,
      percentage: row.percentage,
      device: row.device,
      device_id: row.device_id,
      timestamp: row.updated_at,
    });
  });

  return app;
}
