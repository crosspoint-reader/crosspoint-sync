/**
 * Reading-stats snapshots mirror CrossInk's GlobalReadingStats / BookReadingStats
 * (stats_v5). Each device uploads its own snapshot; snapshots are never merged into
 * each other - the server aggregates across devices on read, same model as the
 * firmware's nearby P2P stats sync.
 */

export const HISTORY_BYTES = 92;
export const HISTORY_DAYS = 730;

export interface GlobalStatsSnapshot {
  v: number;
  sessions: number;
  seconds: number;
  pages: number;
  completed: number;
  tod: number[]; // [morning, afternoon, evening, night] seconds
  dow: number[]; // Mon..Sun seconds
  /** Days since 2000-01-01 of the most recent day covered by the history bitmap. */
  anchor_day: number;
  /** Base64 of 92 bytes; bit 0 = anchor day, bit N = anchor_day - N. */
  history_b64: string;
  /** Device-reported all-time longest streak (may predate the 730-day window). */
  streak: number;
}

export interface BookStatsSnapshot {
  v: number;
  sessions: number;
  seconds: number;
  pages: number;
  completed: boolean;
  avg_fwd: number;
  pace_n: number;
  eta: number;
  start_manual: boolean;
  finish_manual: boolean;
  start_date: number;
  finished_date: number;
  tod: number[];
  dow: number[];
}

/** SQL predicate for device completion, including copies merged with stats.
 *  Arguments are internal SQL column expressions, never request values. */
export function completedBookStatsSql(userId: string, document: string): string {
  return `EXISTS (
    SELECT 1 FROM stats_device_book s
    WHERE s.user_id = ${userId} AND json_extract(s.payload, '$.completed') = 1
      AND (s.document = ${document} OR s.document IN (
        SELECT a.alias FROM document_aliases a
        WHERE a.user_id = ${userId} AND a.document = ${document} AND a.merge_stats = 1
      ))
  )`;
}

function isCount(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

function isCountArray(v: unknown, len: number): v is number[] {
  return Array.isArray(v) && v.length === len && v.every((x) => isCount(x));
}

export function parseGlobalStats(raw: unknown): GlobalStatsSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (
    !isCount(o.v) ||
    !isCount(o.sessions) ||
    !isCount(o.seconds) ||
    !isCount(o.pages) ||
    !isCount(o.completed) ||
    !isCountArray(o.tod, 4) ||
    !isCountArray(o.dow, 7) ||
    !isCount(o.anchor_day) ||
    !isCount(o.streak) ||
    typeof o.history_b64 !== 'string'
  ) {
    return null;
  }
  let history: Buffer;
  try {
    history = Buffer.from(o.history_b64, 'base64');
  } catch {
    return null;
  }
  if (history.length > HISTORY_BYTES) return null;
  return {
    v: o.v,
    sessions: o.sessions,
    seconds: o.seconds,
    pages: o.pages,
    completed: o.completed,
    tod: o.tod,
    dow: o.dow,
    anchor_day: o.anchor_day,
    history_b64: o.history_b64,
    streak: o.streak,
  };
}

export function parseBookStats(raw: unknown): BookStatsSnapshot | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (
    !isCount(o.v) ||
    !isCount(o.sessions) ||
    !isCount(o.seconds) ||
    !isCount(o.pages) ||
    typeof o.completed !== 'boolean' ||
    !isCount(o.avg_fwd) ||
    !isCount(o.pace_n) ||
    !isCount(o.eta) ||
    typeof o.start_manual !== 'boolean' ||
    typeof o.finish_manual !== 'boolean' ||
    !isCount(o.start_date) ||
    !isCount(o.finished_date) ||
    !isCountArray(o.tod, 4) ||
    !isCountArray(o.dow, 7)
  ) {
    return null;
  }
  return {
    v: o.v,
    sessions: o.sessions,
    seconds: o.seconds,
    pages: o.pages,
    completed: o.completed,
    avg_fwd: o.avg_fwd,
    pace_n: o.pace_n,
    eta: o.eta,
    start_manual: o.start_manual,
    finish_manual: o.finish_manual,
    start_date: o.start_date,
    finished_date: o.finished_date,
    tod: o.tod,
    dow: o.dow,
  };
}

function getBit(buf: Buffer, bit: number): boolean {
  const byte = bit >> 3;
  if (byte >= buf.length) return false;
  return (buf[byte] & (1 << (bit & 7))) !== 0;
}

function setBit(buf: Buffer, bit: number): void {
  const byte = bit >> 3;
  if (byte >= buf.length) return;
  buf[byte] |= 1 << (bit & 7);
}

/**
 * OR device history bitmaps together, re-anchored to the most recent anchor day
 * across devices. A device's bit N covers day (anchor_day - N); in the combined
 * bitmap that day lands on bit (combinedAnchor - anchor_day + N). Days older than
 * the 730-day window fall off.
 */
export function combineHistory(
  snapshots: Pick<GlobalStatsSnapshot, 'anchor_day' | 'history_b64'>[]
): { anchorDay: number; history: Buffer } {
  const withBits = snapshots.filter((s) => s.anchor_day > 0);
  const combined = Buffer.alloc(HISTORY_BYTES);
  if (withBits.length === 0) return { anchorDay: 0, history: combined };
  const anchorDay = Math.max(...withBits.map((s) => s.anchor_day));
  for (const s of withBits) {
    const shift = anchorDay - s.anchor_day;
    const bits = Buffer.from(s.history_b64, 'base64');
    for (let n = 0; n < HISTORY_DAYS - shift; n++) {
      if (getBit(bits, n)) setBit(combined, n + shift);
    }
  }
  return { anchorDay, history: combined };
}

/** Longest run of consecutive reading days within the bitmap window. */
export function longestStreak(history: Buffer): number {
  let longest = 0;
  let run = 0;
  for (let n = 0; n < HISTORY_DAYS; n++) {
    if (getBit(history, n)) {
      run++;
      if (run > longest) longest = run;
    } else {
      run = 0;
    }
  }
  return longest;
}

/** Streak ending at the anchor day (today counts if set; else counts from yesterday). */
export function currentStreak(history: Buffer): number {
  let streak = 0;
  let n = getBit(history, 0) ? 0 : 1;
  while (n < HISTORY_DAYS && getBit(history, n)) {
    streak++;
    n++;
  }
  return streak;
}

export interface GlobalStatsSummary {
  sessions: number;
  seconds: number;
  pages: number;
  completed: number;
  tod: number[];
  dow: number[];
  anchor_day: number;
  history_b64: string;
  streak: number;
  current_streak: number;
}

export function combineGlobalStats(snapshots: GlobalStatsSnapshot[]): GlobalStatsSummary {
  const sum: GlobalStatsSummary = {
    sessions: 0,
    seconds: 0,
    pages: 0,
    completed: 0,
    tod: [0, 0, 0, 0],
    dow: [0, 0, 0, 0, 0, 0, 0],
    anchor_day: 0,
    history_b64: '',
    streak: 0,
    current_streak: 0,
  };
  for (const s of snapshots) {
    sum.sessions += s.sessions;
    sum.seconds += s.seconds;
    sum.pages += s.pages;
    sum.completed += s.completed;
    for (let i = 0; i < 4; i++) sum.tod[i] += s.tod[i];
    for (let i = 0; i < 7; i++) sum.dow[i] += s.dow[i];
  }
  const { anchorDay, history } = combineHistory(snapshots);
  sum.anchor_day = anchorDay;
  sum.history_b64 = history.toString('base64');
  // A device-reported streak can predate the 730-day window, so keep the max of both.
  sum.streak = Math.max(longestStreak(history), ...snapshots.map((s) => s.streak), 0);
  sum.current_streak = currentStreak(history);
  return sum;
}

export interface BookStatsCombined {
  sessions: number;
  seconds: number;
  pages: number;
  completed: boolean;
  avg_fwd: number;
  start_date: number;
  finished_date: number;
  tod: number[];
  dow: number[];
}

export function combineBookStats(snapshots: BookStatsSnapshot[]): BookStatsCombined {
  const out: BookStatsCombined = {
    sessions: 0,
    seconds: 0,
    pages: 0,
    completed: false,
    avg_fwd: 0,
    start_date: 0,
    finished_date: 0,
    tod: [0, 0, 0, 0],
    dow: [0, 0, 0, 0, 0, 0, 0],
  };
  let paceWeight = 0;
  let paceSum = 0;
  for (const s of snapshots) {
    out.sessions += s.sessions;
    out.seconds += s.seconds;
    out.pages += s.pages;
    out.completed = out.completed || s.completed;
    for (let i = 0; i < 4; i++) out.tod[i] += s.tod[i];
    for (let i = 0; i < 7; i++) out.dow[i] += s.dow[i];
    if (s.pace_n > 0) {
      paceWeight += s.pace_n;
      paceSum += s.avg_fwd * s.pace_n;
    }
    if (s.start_date > 0 && (out.start_date === 0 || s.start_date < out.start_date)) {
      out.start_date = s.start_date;
    }
    if (s.finished_date > out.finished_date) {
      out.finished_date = s.finished_date;
    }
  }
  out.avg_fwd = paceWeight > 0 ? Math.round(paceSum / paceWeight) : 0;
  return out;
}

/** Local dates already include the reader's configured UTC offset. Never re-zone them. */
export interface DailyReading { date: string; seconds: number }

export function parseDailyReading(raw: unknown): DailyReading[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 20) return null;
  const dates = new Set<string>();
  const out: DailyReading[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const { date, seconds } = item as Record<string, unknown>;
    if (typeof date !== 'string' || !/^20\d{2}-\d{2}-\d{2}$/.test(date) ||
        !Number.isSafeInteger(seconds) || (seconds as number) < 0 || (seconds as number) > 0xffffffff ||
        dates.has(date)) return null;
    const parsed = new Date(date + 'T00:00:00Z');
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
    dates.add(date);
    out.push({ date, seconds: seconds as number });
  }
  return out;
}
