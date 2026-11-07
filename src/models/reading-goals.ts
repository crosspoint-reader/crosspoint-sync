import type { DB } from '../db/db.js';
import { readingActivity, activityOffset, type ActivityTimezone } from './activity.js';
import { aliasesByDocument } from './merge.js';

export const goalYear = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 2000 && Number(value) <= 9999;
export const goalTarget = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 10000;
export function goalTimezone(raw: string | undefined): number {
  const tz = Number(raw ?? 0);
  return Number.isFinite(tz) && Math.abs(tz) <= 840 ? tz : 0;
}

/** Account-wide progress: never derived from a paginated/filtered library. */
export function readingGoals(db: DB, userId: number, tz: number) {
  const today = new Date(Date.now() - tz * 60000).toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const targets = db.prepare('SELECT year, target FROM reading_goals WHERE user_id=? ORDER BY year').all(userId) as { year: number; target: number }[];
  if (!targets.length) return { year, goals: [] };
  const { counts, recent_finished } = readingYearSummary(db, userId, tz);
  return { year, goals: targets.map(g => ({ ...g, completed: counts.get(g.year) ?? 0 })), recent_finished };
}

/** Shared canonical completion calendar, including books with only uploaded stats. */
export function readingYearSummary(db: DB, userId: number, tz: ActivityTimezone) {
  const now = Date.now();
  const today = new Date(now - activityOffset(tz, now / 1000) * 60000).toISOString().slice(0, 10);
  const year = Number(today.slice(0, 4));
  const aliases = new Set([...aliasesByDocument(db, userId).values()].flat());
  const counts = new Map<number, number>();
  const recent: { document: string; at: number }[] = [];
  for (const b of readingActivity(db, userId, tz, { includeStatsOnly: true }).books) {
    if (!b.finished_at || aliases.has(b.document)) continue;
    const day = new Date((b.finished_at - activityOffset(tz, b.finished_at) * 60) * 1000).toISOString().slice(0, 10);
    if (day > today) continue;
    const finishedYear = Number(day.slice(0, 4));
    counts.set(finishedYear, (counts.get(finishedYear) ?? 0) + 1);
    if (finishedYear === year) recent.push({ document: b.document, at: b.finished_at });
  }
  const title = db.prepare('SELECT title, filename FROM documents WHERE user_id=? AND document=?');
  const recent_finished = recent.sort((a, b) => b.at - a.at).slice(0, 4).map(b => {
    const info = title.get(userId, b.document);
    return { document: b.document, title: String(info?.title || info?.filename || 'Untitled book') };
  });
  return { year, counts, recent_finished };
}
