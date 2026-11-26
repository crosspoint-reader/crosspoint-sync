import { baseUrl } from '../connectors/audiobookshelf.js';
import { createHash } from 'node:crypto';
import type { Credential } from '../connectors/types.js';
import { withTransaction, type DB } from '../db/db.js';

export interface ReadingSession {
  session_id: string;
  document: string;
  started_at: number;
  ended_at: number;
  seconds: number;
  utc_offset_minutes: number;
}

// Time zone offset of the per-day sessions in GET /stats/sessions/export. No real zone is UTC+00:01, so a
// reader that uploads a seeded log back is recognized and its seeds are not stored twice.
export const SEED_UTC_OFFSET = 1;

// Why one uploaded session is not stored. invalid: a malformed record. future: dated more than five
// minutes ahead of the server, so measured with a wrong clock. conflict: its ID already belongs to a
// session with another book or start time.
export type SessionRefusal = 'invalid' | 'future' | 'conflict';

const SESSION_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_FUTURE_SECONDS = 300;

export function checkReadingSession(raw: unknown, now: number): ReadingSession | Exclude<SessionRefusal, 'conflict'> {
  if (!raw || typeof raw !== 'object') return 'invalid';
  const s = raw as ReadingSession;
  if (typeof s.session_id !== 'string' || !SESSION_ID.test(s.session_id) ||
      typeof s.document !== 'string' || !/^[a-fA-F0-9]{32}$/.test(s.document) ||
      !Number.isSafeInteger(s.started_at) || !Number.isSafeInteger(s.ended_at) ||
      s.started_at < 946684800 || s.ended_at < s.started_at ||
      s.ended_at - s.started_at > 7 * 86400 || !Number.isSafeInteger(s.seconds) ||
      s.seconds < 10 || s.seconds > s.ended_at - s.started_at ||
      !Number.isInteger(s.utc_offset_minutes) || s.utc_offset_minutes < -720 || s.utc_offset_minutes > 840) return 'invalid';
  if (s.ended_at > now + MAX_FUTURE_SECONDS) return 'future';
  return { session_id: s.session_id, document: s.document, started_at: s.started_at,
    ended_at: s.ended_at, seconds: s.seconds, utc_offset_minutes: s.utc_offset_minutes };
}

export function parseReadingSession(raw: unknown, now: number): ReadingSession | null {
  const checked = checkReadingSession(raw, now);
  return typeof checked === 'string' ? null : checked;
}

export interface StoredSessions {
  // Every ID the reader may clear from its outbox: stored, already held, or refused for good.
  acknowledged: string[];
  refused: { session_id: string; reason: SessionRefusal }[];
  // Documents of the sessions that were not refused.
  documents: string[];
}

// Stores one upload batch session by session, so a session the server will never accept cannot hold back the
// rest of the batch. A reader resends its oldest unacknowledged sessions first, so a refusal that is not
// acknowledged would block every later session from that reader; refused IDs are acknowledged and listed.
// Checkpoints of one session (same ID, book and start) keep the larger duration and end.
export function storeReadingSessions(db: DB, userId: number, deviceId: string, items: unknown[], now: number): StoredSessions {
  const acknowledged = new Set<string>();
  const refused: StoredSessions['refused'] = [];
  const documents = new Set<string>();
  const existing = db.prepare('SELECT document, started_at FROM reading_sessions WHERE user_id=? AND device_id=? AND session_id=?');
  const insert = db.prepare(`INSERT INTO reading_sessions
    (user_id, device_id, session_id, document, started_at, ended_at, seconds, utc_offset_minutes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id,device_id,session_id) DO UPDATE SET
      seconds=MAX(reading_sessions.seconds, excluded.seconds),
      ended_at=MAX(reading_sessions.ended_at, excluded.ended_at)`);
  // A reader seeded from /stats/sessions/export uploads that history back under its own IDs:
  // acknowledge it without storing it again.
  const known = db.prepare(`SELECT 1 FROM reading_sessions WHERE user_id=? AND document=? AND started_at=?
    AND seconds=? AND NOT (device_id=? AND session_id=?)`);
  const refuse = (id: string, reason: SessionRefusal) => {
    refused.push({ session_id: id, reason });
    acknowledged.add(id);
  };
  withTransaction(db, () => {
    for (const raw of items) {
      const s = checkReadingSession(raw, now);
      if (typeof s === 'string') {
        const id = (raw as { session_id?: unknown } | null)?.session_id;
        // Without a usable ID there is nothing the reader could match an acknowledgment to.
        if (typeof id === 'string' && SESSION_ID.test(id)) refuse(id, s);
        continue;
      }
      if (s.utc_offset_minutes === SEED_UTC_OFFSET) {
        acknowledged.add(s.session_id);
        documents.add(s.document);
        continue;
      }
      const old = existing.get(userId, deviceId, s.session_id) as { document: string; started_at: number } | undefined;
      if (old && (old.document !== s.document || Number(old.started_at) !== s.started_at)) {
        refuse(s.session_id, 'conflict');
        continue;
      }
      acknowledged.add(s.session_id);
      documents.add(s.document);
      // A later checkpoint of a stored session always merges, even when another session matches it.
      if (!old && known.get(userId, s.document, s.started_at, s.seconds, deviceId, s.session_id)) continue;
      insert.run(userId, deviceId, s.session_id, s.document, s.started_at,
        s.ended_at, s.seconds, s.utc_offset_minutes, now);
    }
  });
  return { acknowledged: [...acknowledged], refused, documents: [...documents] };
}

// Contains no password/token; reconnecting the same destination preserves ownership.
export function bookorbitDestination(cred: Credential): string {
  const server = typeof cred.server === 'string' ? cred.server.trim() : '';
  const canonical = new URL(baseUrl(server)).toString().replace(/\/+$/, '');
  const username = typeof cred.username === 'string' ? cred.username.trim() : '';
  return createHash('sha256').update(JSON.stringify([canonical, username])).digest('hex');
}
