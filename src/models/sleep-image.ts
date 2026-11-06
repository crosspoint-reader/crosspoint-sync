import type { DB } from '../db/db.js';
import { readingActivity } from './activity.js';
import { readingYearSummary } from './reading-goals.js';
import { combineReadingStreak } from './reading-streak.js';
import { readBookorbitStats } from './bookorbit-stats.js';
import type { GlobalStatsSnapshot } from './stats.js';

export class SleepImageError extends Error {}
export const MAX_SLEEP_PIXELS = 2_000_000;
export const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;
export const SLEEP_METRICS = ['books', 'goal', 'current', 'streak'] as const;
export type SleepMetric = typeof SLEEP_METRICS[number];
export interface SleepOptions {
  width: number;
  height: number;
  mode: 'overlay' | 'custom';
  placement: 'top' | 'bottom';
  timezone: string;
  metrics: SleepMetric[];
  preview?: boolean;
}
export interface SleepMetrics {
  year: number;
  finished: number;
  target: number | null;
  currentPercent: number | null;
  streak: number;
}

/** JS getTimezoneOffset sign, recalculated at render time for seasonal changes. */
export function timezoneOffset(timezone: string, date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const get = (key: string) => Number(parts.find(p => p.type === key)!.value);
    const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return Math.round((Math.floor(date.getTime() / 1000) * 1000 - local) / 60000);
  } catch { throw new SleepImageError('Choose a valid IANA timezone.'); }
}

export function parseSleepOptions(query: Record<string, string | undefined>): SleepOptions {
  const dimension = (raw: string | undefined, fallback: number) => {
    const n = raw === undefined ? fallback : /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 240 || n > 1600) throw new SleepImageError('Dimensions must be integers from 240 to 1600.');
    return n;
  };
  const width = dimension(query.width, 480), height = dimension(query.height, 800);
  if (width * height > MAX_SLEEP_PIXELS) throw new SleepImageError('Image exceeds 2,000,000 pixels.');
  const mode = query.mode ?? 'overlay', placement = query.placement ?? 'bottom';
  if (mode !== 'overlay' && mode !== 'custom') throw new SleepImageError('Choose overlay or custom mode.');
  if (placement !== 'top' && placement !== 'bottom') throw new SleepImageError('Choose top or bottom placement.');
  const metrics = [...new Set((query.metrics ?? SLEEP_METRICS.join(',')).split(','))];
  if (!metrics.length || metrics.some(m => !SLEEP_METRICS.includes(m as SleepMetric))) throw new SleepImageError('Choose supported metrics.');
  const timezone = query.timezone ?? 'UTC';
  if (timezone.length > 100) throw new SleepImageError('Invalid timezone.');
  timezoneOffset(timezone);
  if (query.preview !== undefined && query.preview !== '0' && query.preview !== '1') throw new SleepImageError('Preview must be 0 or 1.');
  return { width, height, mode, placement, timezone, metrics: metrics as SleepMetric[], preview: query.preview === '1' };
}

export function sleepMetrics(db: DB, userId: number, timezone: string, percent?: string): SleepMetrics {
  const tz = timezoneOffset(timezone);
  const { year, counts } = readingYearSummary(db, userId, tz);
  const goal = db.prepare('SELECT target FROM reading_goals WHERE user_id=? AND year=?').get(userId, year);
  const activity = readingActivity(db, userId, tz);
  const snapshots = db.prepare('SELECT payload FROM stats_device_global WHERE user_id=?').all(userId)
    .map(r => JSON.parse(r.payload as string) as GlobalStatsSnapshot);
  const imported = readBookorbitStats(db, userId);
  if (imported.global.sessions) snapshots.push(imported.global);
  const daily = db.prepare('SELECT DISTINCT date FROM stats_device_day WHERE user_id=? AND seconds>0').all(userId).map(r => r.date as string);
  daily.push(...imported.daily.filter(d => d.seconds > 0).map(d => d.date));
  const n = percent !== undefined && /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(percent) ? Number(percent) : NaN;
  return {
    year, finished: counts.get(year) ?? 0, target: goal ? Number(goal.target) : null,
    currentPercent: Number.isFinite(n) && n >= 0 && n <= 100 ? n : null,
    streak: combineReadingStreak(snapshots, [...activity.reading_days, ...daily], tz).current_streak,
  };
}
