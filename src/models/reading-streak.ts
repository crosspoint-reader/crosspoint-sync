import { HISTORY_BYTES, HISTORY_DAYS, currentStreak, type GlobalStatsSnapshot } from './stats.js';

const DAY_MS = 86400000;
const EPOCH = Date.UTC(2000, 0, 1);

/** Same dated-history rule as the web calendar, with a fixed 730-day reader window. */
export function combineReadingStreak(
  snapshots: Pick<GlobalStatsSnapshot, 'anchor_day' | 'history_b64'>[],
  readingDays: string[],
  tzOffsetMinutes = 0,
  now = Date.now(),
) {
  const today = Math.floor((now - tzOffsetMinutes * 60000 - EPOCH) / DAY_MS);
  const days = new Set<number>();
  for (const date of readingDays) {
    const day = (Date.parse(`${date}T00:00:00Z`) - EPOCH) / DAY_MS;
    if (Number.isInteger(day) && day >= 0 && day <= today) days.add(day);
  }
  for (const snapshot of snapshots) {
    if (snapshot.anchor_day <= 0) continue;
    const bytes = Buffer.from(snapshot.history_b64, 'base64');
    for (let n = 0; n < Math.min(HISTORY_DAYS, bytes.length * 8); n++) {
      const day = snapshot.anchor_day - n;
      if (day >= 0 && day <= today && (bytes[n >> 3] & (1 << (n & 7)))) days.add(day);
    }
  }
  const history = Buffer.alloc(HISTORY_BYTES);
  let longest = 0, run = 0, previous = -2;
  for (const day of [...days].sort((a, b) => a - b)) {
    run = day === previous + 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
    previous = day;
    const bit = today - day;
    if (bit < HISTORY_DAYS) history[bit >> 3] |= 1 << (bit & 7);
  }
  return {
    v: 1,
    anchor_day: today,
    history_b64: history.toString('base64'),
    streak: longest,
    current_streak: currentStreak(history),
  };
}
