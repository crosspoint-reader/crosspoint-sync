import { baseUrl } from '../connectors/audiobookshelf.js';
import { createHash } from 'node:crypto';
import type { Credential } from '../connectors/types.js';

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

export function parseReadingSession(raw: unknown, now: number): ReadingSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as ReadingSession;
  if (typeof s.session_id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(s.session_id) ||
      typeof s.document !== 'string' || !/^[a-fA-F0-9]{32}$/.test(s.document) ||
      !Number.isSafeInteger(s.started_at) || !Number.isSafeInteger(s.ended_at) ||
      s.started_at < 946684800 || s.ended_at < s.started_at || s.ended_at > now + 300 ||
      s.ended_at - s.started_at > 7 * 86400 || !Number.isSafeInteger(s.seconds) ||
      s.seconds < 10 || s.seconds > s.ended_at - s.started_at ||
      !Number.isInteger(s.utc_offset_minutes) || s.utc_offset_minutes < -720 || s.utc_offset_minutes > 840) return null;
  return { session_id: s.session_id, document: s.document, started_at: s.started_at,
    ended_at: s.ended_at, seconds: s.seconds, utc_offset_minutes: s.utc_offset_minutes };
}

// Contains no password/token; reconnecting the same destination preserves ownership.
export function bookorbitDestination(cred: Credential): string {
  const server = typeof cred.server === 'string' ? cred.server.trim() : '';
  const canonical = new URL(baseUrl(server)).toString().replace(/\/+$/, '');
  const username = typeof cred.username === 'string' ? cred.username.trim() : '';
  return createHash('sha256').update(JSON.stringify([canonical, username])).digest('hex');
}
