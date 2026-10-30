import { Hono } from 'hono';
import { withTransaction, type DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { isValidDocument } from '../kosync.js';
import { nowSeconds } from '../../models/sync.js';
import {
  combineBookStats,
  combineGlobalStats,
  parseBookStats,
  parseGlobalStats,
  parseDailyReading,
  type BookStatsSnapshot,
  type DailyReading,
  type GlobalStatsSnapshot,
} from '../../models/stats.js';
import { readingActivity } from '../../models/activity.js';
import { documentInfo } from '../../models/cover.js';
import { resolveDocument, statsAliases, statsDocuments } from '../../models/merge.js';
import type { HttpTransport } from '../../connectors/types.js';
import { bookorbitExclusions, readBookorbitStats } from '../../models/bookorbit-stats.js';

import { parseReadingSession } from '../../models/reading-sessions.js';
import { importBookorbitStats } from '../../connectors/bookorbit-stats.js';

const MAX_BOOK_BATCH = 20;
const DEFAULT_BOOK_PAGE = 50;
const MAX_BOOK_PAGE = 200;
const MAX_INFO_LOOKUPS = 25;

const EPOCH_DAY = Date.UTC(2000, 0, 1) / 86400000;
const DEFAULT_OVERVIEW_DAYS = 365;
const MAX_OVERVIEW_DAYS = 3650;
// Genre groups can be many; the overview returns the ones with the most reading days.
const MAX_OVERVIEW_GROUPS = 20;

/** A YYYY-MM-DD date as days since 2000-01-01. */
function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000) - EPOCH_DAY;
}

/** Days from a date -> seconds map, in date order. */
function sortedDays(days: Map<string, number>): DailyReading[] {
  return [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, seconds]) => ({ date, seconds }));
}

interface BookInfo {
  language: string | null;
  genres: string[];
  author: string | null;
}

interface OverviewTime {
  seconds: number;
  sessions: number;
  perDay: Map<number, number>;
}

/**
 * The overview's book filters. `null` for an invalid one; `active` false when none is given. Language
 * matches by main subtag, genre by name, author by part of the name; all ignore case.
 */
function bookFilter(language?: string, genre?: string, author?: string) {
  const clean = (v: string | undefined) => (v === undefined ? undefined : v.trim().toLowerCase());
  const lang = clean(language)?.split('-')[0];
  const g = clean(genre);
  const a = clean(author);
  for (const v of [lang, g, a]) if (v !== undefined && (v.length === 0 || v.length > 64)) return null;
  return {
    active: lang !== undefined || g !== undefined || a !== undefined,
    matches: (info: BookInfo | undefined) =>
      !!info &&
      (lang === undefined || info.language === lang) &&
      (g === undefined || info.genres.some((x) => x.toLowerCase() === g)) &&
      (a === undefined || (info.author ?? '').toLowerCase().includes(a)),
  };
}

/** The caller's UTC offset in minutes as JS getTimezoneOffset() gives it; 0 when absent or implausible. */
/** `device_id` and `since` filters: an empty device_id means no filter, a bad since means from the start. */
function deviceSince(device: string | undefined, sinceRaw: string | undefined) {
  const since = Number(sinceRaw ?? 0);
  return { deviceId: device || undefined, since: Number.isSafeInteger(since) && since > 0 ? since : 0 };
}

function tzFrom(raw: string | undefined): number {
  const tz = Number(raw ?? 0);
  return Number.isFinite(tz) && Math.abs(tz) <= 14 * 60 ? tz : 0;
}

function deviceIdFrom(o: Record<string, unknown>): string | null {
  return typeof o.device_id === 'string' && o.device_id.length > 0 && o.device_id.length <= 128
    ? o.device_id
    : null;
}

export function statsRoutes(db: DB, http?: HttpTransport): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Device snapshots combined across devices, plus seconds per day.
  function summaryFor(userId: number) {
    const rows = db
      .prepare(
        'SELECT device_id, device, payload, updated_at FROM stats_device_global WHERE user_id = ?'
      )
      .all(userId) as { device_id: string; device: string; payload: string; updated_at: number }[];
    const snapshots = rows.map((r) => JSON.parse(r.payload) as GlobalStatsSnapshot);
    const imported = readBookorbitStats(db, userId);
    if (imported.global.sessions) snapshots.push(imported.global);
    const summary = combineGlobalStats(snapshots);
    const daily = new Map<string, number>();
    for (const d of [...db.prepare(
      'SELECT date, SUM(seconds) AS seconds FROM stats_device_day WHERE user_id = ? GROUP BY date ORDER BY date'
    ).all(userId) as { date: string; seconds: number }[], ...imported.daily]) {
      daily.set(d.date, (daily.get(d.date) ?? 0) + d.seconds);
    }
    return { rows, imported, summary, daily };
  }

  async function activityFor(userId: number, tz: number) {
    // Books never looked up yet get their page count now (bounded per request).
    const pending = db
      .prepare(
        `SELECT document FROM documents WHERE user_id = ? AND cover_checked_at IS NULL
           AND (title IS NOT NULL OR filename IS NOT NULL) LIMIT ?`
      )
      .all(userId, MAX_INFO_LOOKUPS) as { document: string }[];
    await Promise.all(pending.map((d) => documentInfo(db, userId, d.document, http).catch(() => null)));

    return readingActivity(db, userId, tz);
  }


  // Cumulative session checkpoints retain one identity, including stale retries.
  app.put('/stats/sessions', async (c) => {
    let body: any;
    try { body = await c.req.json(); } catch { return kosyncError(c, 403, 2003, 'Invalid request'); }
    const deviceId = body && deviceIdFrom(body);
    const now = nowSeconds();
    if (!deviceId || !Array.isArray(body.items) || !body.items.length || body.items.length > 20) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const items = body.items.map((s: unknown) => parseReadingSession(s, now));
    if (items.some((s: unknown) => !s) || new Set(items.map((s: any) => s.session_id)).size !== items.length) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const userId = c.get('user').id;
    const existing = db.prepare('SELECT * FROM reading_sessions WHERE user_id=? AND device_id=? AND session_id=?');
    for (const s of items) {
      const old = existing.get(userId, deviceId, s.session_id);
      if (old && (['document', 'started_at', 'utc_offset_minutes'].some((key) => old[key] !== s[key]) ||
          !((s.seconds >= Number(old.seconds) && s.ended_at >= Number(old.ended_at)) ||
            (s.seconds <= Number(old.seconds) && s.ended_at <= Number(old.ended_at))))) {
        return kosyncError(c, 403, 2003, 'Session ID already has different data');
      }
    }
    withTransaction(db, () => {
      const insert = db.prepare(`INSERT INTO reading_sessions
        (user_id, device_id, session_id, document, started_at, ended_at, seconds, utc_offset_minutes, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id,device_id,session_id) DO UPDATE SET
          seconds=MAX(reading_sessions.seconds, excluded.seconds),
          ended_at=MAX(reading_sessions.ended_at, excluded.ended_at)`);
      for (const s of items) insert.run(userId, deviceId, s.session_id, s.document, s.started_at,
        s.ended_at, s.seconds, s.utc_offset_minutes, now);
    });
    for (const document of new Set<string>(items.map((s: any) => resolveDocument(db, userId, s.document)))) {
      void importBookorbitStats(db, userId, http, { document }).catch(() => {});
    }
    return c.json({ until: now, accepted_session_ids: items.map((s: any) => s.session_id) });
  });

  app.put('/stats/global', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const o = (body ?? {}) as Record<string, unknown>;
    const deviceId = deviceIdFrom(o);
    const snapshot = parseGlobalStats(o);
    const daily = parseDailyReading(o.daily);
    if (!deviceId || !snapshot || !daily) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const device = typeof o.device === 'string' ? o.device.slice(0, 128) : '';
    const user = c.get('user');
    const now = nowSeconds();
    withTransaction(db, () => {
      db.prepare(
        `INSERT INTO stats_device_global (user_id, device_id, device, payload, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, device_id) DO UPDATE SET
           device = excluded.device, payload = excluded.payload, updated_at = excluded.updated_at`
      ).run(user.id, deviceId, device, JSON.stringify(snapshot), now);
      const upsertDay = db.prepare(
        `INSERT INTO stats_device_day (user_id, device_id, date, seconds, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id, device_id, date) DO UPDATE SET
           seconds = MAX(stats_device_day.seconds, excluded.seconds),
           updated_at = excluded.updated_at`
      );
      for (const day of daily) upsertDay.run(user.id, deviceId, day.date, day.seconds, now);
    });
    // Explicit acknowledgment lets readers retain unsent counters when talking to old servers.
    return c.json({ until: now, accepted_daily: daily.length });
  });

  app.put('/stats/books', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const o = (body ?? {}) as Record<string, unknown>;
    const deviceId = deviceIdFrom(o);
    const items = o.items;
    if (!deviceId || !Array.isArray(items) || items.length === 0 || items.length > MAX_BOOK_BATCH) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const parsed: { document: string; snapshot: BookStatsSnapshot; daily: DailyReading[] }[] = [];
    for (const raw of items) {
      const item = raw as Record<string, unknown>;
      const snapshot = parseBookStats(item);
      // Optional: the book's seconds per local day, like the global upload's `daily`.
      const daily = parseDailyReading(item?.daily);
      if (!isValidDocument(item.document) || !snapshot || !daily) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      parsed.push({ document: item.document, snapshot, daily });
    }
    const user = c.get('user');
    const now = nowSeconds();
    const upsert = db.prepare(
      `INSERT INTO stats_device_book (user_id, device_id, document, payload, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, device_id, document) DO UPDATE SET
         payload = excluded.payload,
         updated_at = excluded.updated_at`
    );
    const upsertDay = db.prepare(
      `INSERT INTO stats_device_book_day (user_id, device_id, document, date, seconds, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, device_id, document, date) DO UPDATE SET
         seconds = MAX(stats_device_book_day.seconds, excluded.seconds),
         updated_at = excluded.updated_at`
    );
    withTransaction(db, () => {
      for (const p of parsed) {
        upsert.run(user.id, deviceId, p.document, JSON.stringify(p.snapshot), now);
        for (const d of p.daily) upsertDay.run(user.id, deviceId, p.document, d.date, d.seconds, now);
      }
    });
    return c.json({ until: now, accepted: parsed.length, accepted_daily: parsed.reduce((n, p) => n + p.daily.length, 0) });
  });

  // `device_id` keeps one device; `since` (an earlier answer's `until`) keeps only the days uploaded since.
  app.get('/stats/global', (c) => {
    const user = c.get('user');
    const { deviceId, since } = deviceSince(c.req.query('device_id'), c.req.query('since'));
    const now = nowSeconds();
    const rows = db
      .prepare(
        'SELECT device_id, device, payload, updated_at FROM stats_device_global WHERE user_id = ? AND (? IS NULL OR device_id = ?)'
      )
      .all(user.id, deviceId ?? null, deviceId ?? null) as { device_id: string; device: string; payload: string; updated_at: number }[];
    const days = db.prepare(
      'SELECT date, seconds FROM stats_device_day WHERE user_id = ? AND device_id = ? AND updated_at >= ? ORDER BY date'
    );
    const devices = rows.map((r) => ({
        device_id: r.device_id,
        device: r.device,
        updated_at: r.updated_at,
        stats: { ...JSON.parse(r.payload), daily: days.all(user.id, r.device_id, since) },
      }));
    const imported = readBookorbitStats(db, user.id);
    // Imported days carry no upload time of their own: all of them, once the import changed since.
    if (imported.global.sessions && (!deviceId || deviceId === 'connector:bookorbit') && imported.updated_at >= since) {
      devices.push({
        device_id: 'connector:bookorbit', device: 'BookOrbit', updated_at: imported.updated_at,
        stats: { ...imported.global, daily: imported.daily },
      });
    }
    return c.json({
      devices,
      bookorbit: bookorbitExclusions(imported),
      // Pass as `since` next time. Inclusive, so a day uploaded in this same second comes again.
      until: now,
    });
  });

  app.get('/stats/summary', (c) => {
    const user = c.get('user');
    const { rows, imported, summary, daily } = summaryFor(user.id);
    return c.json({
      ...summary,
      daily: [...daily].sort(([a], [b]) => a.localeCompare(b)).map(([date, seconds]) => ({ date, seconds, minutes: seconds / 60 })),
      bookorbit: bookorbitExclusions(imported),
      devices: [...rows.map((r) => ({
        device_id: r.device_id,
        device: r.device,
        updated_at: r.updated_at,
      })), ...(imported.global.sessions ? [{ device_id: 'connector:bookorbit', device: 'BookOrbit', updated_at: imported.updated_at }] : [])],
    });
  });

  app.get('/stats/books/:document', (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    // Merged copies keep their stats under their own hash; fold in the ones
    // merged with stats.
    const documents = statsDocuments(db, user.id, resolveDocument(db, user.id, document));
    const rows = db
      .prepare(
        `SELECT device_id, document, payload, updated_at FROM stats_device_book
         WHERE user_id = ? AND document IN (${documents.map(() => '?').join(',')})`
      )
      .all(user.id, ...documents) as {
      device_id: string;
      document: string;
      payload: string;
      updated_at: number;
    }[];
    const snapshots = rows.map((r) => JSON.parse(r.payload) as BookStatsSnapshot);
    const imported = readBookorbitStats(db, user.id, documents);
    if (imported.book.sessions) snapshots.push(imported.book);
    const days = bookDays(user.id, documents);
    // Each device's days, then the sum of every device's (BookOrbit's included) per date.
    const combinedDays = new Map<string, number>();
    for (const list of [...days.values(), imported.daily]) {
      for (const d of list) combinedDays.set(d.date, (combinedDays.get(d.date) ?? 0) + d.seconds);
    }
    return c.json({
      document,
      combined: { ...combineBookStats(snapshots), daily: sortedDays(combinedDays) },
      bookorbit: bookorbitExclusions(imported),
      devices: [...rows.map((r) => ({
        device_id: r.device_id,
        document: r.document,
        updated_at: r.updated_at,
        stats: { ...JSON.parse(r.payload), daily: days.get(`${r.device_id}\n${r.document}`) ?? [] },
      })), ...(imported.book.sessions ? [{ device_id: 'connector:bookorbit', document,
        updated_at: imported.updated_at, stats: { ...imported.book, daily: imported.daily } }] : [])],
    });
  });

  // Every book's stats, a page at a time, for clients that restore or show them all: one item per
  // device and book, with the book's metadata so a client can match it to a file without the hash.
  // `device_id` keeps one device's; `cursor` is the previous page's `next`; `since` (a previous answer's
  // `until`) keeps the books uploaded since then.
  app.get('/stats/books', (c) => {
    const user = c.get('user');
    const { deviceId, since } = deviceSince(c.req.query('device_id'), c.req.query('since'));
    const now = nowSeconds();
    const cursor = c.req.query('cursor') ?? '';
    const limitRaw = Number(c.req.query('limit') ?? DEFAULT_BOOK_PAGE);
    const limit = Number.isInteger(limitRaw) && limitRaw >= 1 ? Math.min(limitRaw, MAX_BOOK_PAGE) : DEFAULT_BOOK_PAGE;
    // Documents never contain ':', so the first one splits the document from the device id.
    const sep = cursor.indexOf(':');
    const afterDocument = sep < 0 ? '' : cursor.slice(0, sep);
    const afterDevice = sep < 0 ? '' : cursor.slice(sep + 1);
    const rows = db
      .prepare(
        `SELECT s.device_id, s.document, s.payload, s.updated_at, d.title, d.author, d.filename, d.language
         FROM stats_device_book s
         LEFT JOIN documents d ON d.user_id = s.user_id AND d.document = s.document
         WHERE s.user_id = ? AND (? IS NULL OR s.device_id = ?) AND s.updated_at >= ?
           AND (s.document > ? OR (s.document = ? AND s.device_id > ?))
         ORDER BY s.document, s.device_id LIMIT ?`
      )
      .all(user.id, deviceId ?? null, deviceId ?? null, since, afterDocument, afterDocument, afterDevice, limit + 1) as {
      device_id: string;
      document: string;
      payload: string;
      updated_at: number;
      title: string | null;
      author: string | null;
      filename: string | null;
      language: string | null;
    }[];
    const page = rows.slice(0, limit);
    const days = bookDays(user.id, [...new Set(page.map((r) => r.document))], deviceId);
    const last = page[page.length - 1];
    return c.json({
      items: page.map((r) => ({
        device_id: r.device_id,
        document: r.document,
        title: r.title,
        author: r.author,
        filename: r.filename,
        language: r.language,
        updated_at: r.updated_at,
        stats: { ...JSON.parse(r.payload), daily: days.get(`${r.device_id}\n${r.document}`) ?? [] },
      })),
      next: rows.length > limit ? `${last.document}:${last.device_id}` : null,
      // Pass as `since` next time. Inclusive, so a book uploaded in this same second comes again.
      until: now,
    });
  });

  // Pages/books activity from the progress history (print pages), for readers
  // that don't send stats. ?tz= is the client's Date#getTimezoneOffset().
  app.get('/stats/activity', async (c) => c.json(await activityFor(c.get('user').id, tzFrom(c.req.query('tz')))));

  // A device-sized digest of what the Stats page shows: the same finished counts, pages and streaks,
  // and reading days from every source. Counts cover all history; only the reading-day bitmap is
  // windowed (`days`, default 365, at most 3650) so the response stays a few hundred bytes.
  // `language`, `genre` and `author` narrow it to matching books; `group_by=language|genre` adds one
  // digest per value under `groups`.
  app.get('/stats/overview', async (c) => {
    const user = c.get('user');
    const tz = tzFrom(c.req.query('tz'));
    const daysRaw = Number(c.req.query('days') ?? DEFAULT_OVERVIEW_DAYS);
    const days = Number.isInteger(daysRaw) && daysRaw >= 1 ? Math.min(daysRaw, MAX_OVERVIEW_DAYS) : DEFAULT_OVERVIEW_DAYS;
    const filter = bookFilter(c.req.query('language'), c.req.query('genre'), c.req.query('author'));
    const groupBy = c.req.query('group_by');
    const weekStart = c.req.query('week_start');
    if (
      filter === null ||
      (groupBy !== undefined && groupBy !== 'language' && groupBy !== 'genre') ||
      (weekStart !== undefined && weekStart !== '0' && weekStart !== '1')
    ) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const activity = await activityFor(user.id, tz);
    const day = (t: number) => Math.floor(t / 86400000) - EPOCH_DAY; // days since 2000-01-01
    const today = day(Date.now() - tz * 60000);
    const year = new Date(Date.now() - tz * 60000).getUTCFullYear();
    // week_seconds: the last 7 days, or the days since Sunday (week_start=0) or Monday (1).
    // 2000-01-01 was a Saturday, so (today + 6) % 7 is the weekday with Sunday as 0.
    const weekDays = weekStart === undefined ? 7 : ((today + 6 - Number(weekStart)) % 7) + 1;

    const digest = (read: Set<number>, books: typeof activity.books, pages: number, time: OverviewTime) => {
      const past = [...read].filter((d) => d <= today).sort((a, b) => a - b);
      let longest = 0;
      for (let i = 0, run = 0; i < past.length; i++) {
        run = i > 0 && past[i] === past[i - 1] + 1 ? run + 1 : 1;
        longest = Math.max(longest, run);
      }
      // Today counts once read; until then the streak runs to yesterday.
      let current = 0;
      for (let d = read.has(today) ? today : today - 1; read.has(d); d--) current++;
      const history = Buffer.alloc(Math.ceil(days / 8));
      for (const d of past) if (today - d < days) history[(today - d) >> 3] |= 1 << ((today - d) & 7);
      const finished = books.filter((b) => b.finished_at);
      return {
        anchor_day: today,
        days,
        history_b64: history.toString('base64'),
        reading_days: past.length,
        current_streak: current,
        longest_streak: longest,
        books_finished: books.filter(b => b.completed || b.finished_at).length,
        finished_this_year: finished.filter((b) => new Date((b.finished_at! - tz * 60) * 1000).getUTCFullYear() === year).length,
        pages_read: pages,
        // Reading time as the reader measured it (devices that upload stats); none for synced-only books.
        seconds: time.seconds,
        sessions: time.sessions,
        today_seconds: time.perDay.get(today) ?? 0,
        week_seconds: Array.from({ length: weekDays }, (_, n) => time.perDay.get(today - n) ?? 0).reduce((a, b) => a + b, 0),
      };
    };

    // The whole account: device snapshots and daily totals count too, not only per-book data.
    const account = () => {
      const { summary, daily } = summaryFor(user.id);
      const read = new Set<number>();
      for (const d of activity.reading_days) read.add(dayNumber(d));
      for (const [d, seconds] of daily) if (seconds > 0) read.add(dayNumber(d));
      if (summary.anchor_day > 0 && summary.history_b64) {
        const bits = Buffer.from(summary.history_b64, 'base64');
        for (let n = 0; n < bits.length * 8; n++) if (bits[n >> 3] & (1 << (n & 7))) read.add(summary.anchor_day - n);
      }
      const perDay = new Map([...daily].map(([d, seconds]) => [dayNumber(d), seconds] as [number, number]));
      return digest(read, activity.books, activity.pages_total, { seconds: summary.seconds, sessions: summary.sessions, perDay });
    };
    if (!filter.active && !groupBy) return c.json(account());

    // Per-book view: what each book's day, finish and time data says, for the books a filter keeps.
    const books = booksFor(user.id);
    const forBooks = (keep: (d: string) => boolean) => {
      const read = new Set<number>();
      for (const d of activity.days) if (d.books.some((b) => keep(b.document))) read.add(dayNumber(d.day));
      const perDay = new Map<number, number>();
      let seconds = 0;
      let sessions = 0;
      for (const [document, b] of books.time) {
        if (!keep(document)) continue;
        for (const [d, s] of b.perDay) {
          read.add(d);
          perDay.set(d, (perDay.get(d) ?? 0) + s);
        }
        seconds += b.seconds;
        sessions += b.sessions;
      }
      const kept = activity.books.filter((b) => keep(b.document));
      return digest(read, kept, kept.reduce((sum, b) => sum + (b.pages_read ?? 0), 0), { seconds, sessions, perDay });
    };
    const matches = (document: string) => filter.matches(books.info.get(document));
    const out: Record<string, unknown> = filter.active ? forBooks(matches) : account();
    if (groupBy) {
      // A book counts in each of its genres; languages by their main subtag ("en-GB" is "en"). Values
      // that differ only in case are one group, named as first seen.
      const keys = new Map<string, { name: string; docs: Set<string> }>();
      for (const [document, info] of books.info) {
        if (filter.active && !filter.matches(info)) continue;
        const values = groupBy === 'language' ? (info.language ? [info.language] : []) : info.genres;
        for (const v of values) {
          const key = v.toLowerCase();
          if (!keys.has(key)) keys.set(key, { name: v, docs: new Set() });
          keys.get(key)!.docs.add(document);
        }
      }
      const groups = [...keys.values()].map(({ name, docs }) => [name, forBooks((d) => docs.has(d))] as const);
      groups.sort((a, b) => b[1].reading_days - a[1].reading_days || a[0].localeCompare(b[0]));
      out.groups = Object.fromEntries(groups.slice(0, MAX_OVERVIEW_GROUPS));
    }
    return c.json(out);
  });

  /** Per-book days by "device_id\ndocument", in date order; only `deviceId`'s when given. */
  function bookDays(userId: number, documents: string[], deviceId?: string) {
    const out = new Map<string, DailyReading[]>();
    if (!documents.length) return out;
    const rows = db
      .prepare(
        `SELECT device_id, document, date, seconds FROM stats_device_book_day
         WHERE user_id = ? AND document IN (${documents.map(() => '?').join(',')}) AND (? IS NULL OR device_id = ?)
         ORDER BY date`
      )
      .all(userId, ...documents, deviceId ?? null, deviceId ?? null) as {
      device_id: string;
      document: string;
      date: string;
      seconds: number;
    }[];
    for (const r of rows) {
      const key = `${r.device_id}\n${r.document}`;
      (out.get(key) ?? out.set(key, []).get(key)!).push({ date: r.date, seconds: Number(r.seconds) });
    }
    return out;
  }

  /** Language, genres and author per book, and each book's measured time per day (merged copies folded). */
  function booksFor(userId: number) {
    // Merged copies: their time counts toward the book they were merged into (unless kept apart),
    // and their own metadata row is left out in favour of that book's.
    const resolve = statsAliases(db, userId);
    const canonical = (d: string) => resolve.get(d) ?? d;
    const aliases = new Set(
      (db.prepare('SELECT alias FROM document_aliases WHERE user_id = ?').all(userId) as { alias: string }[]).map((r) => r.alias)
    );
    const info = new Map<string, BookInfo>();
    for (const r of db.prepare('SELECT document, language, genres, author FROM documents WHERE user_id = ?').all(userId) as {
      document: string;
      language: string | null;
      genres: string | null;
      author: string | null;
    }[]) {
      if (aliases.has(r.document)) continue;
      let genres: string[] = [];
      try {
        const list = r.genres ? JSON.parse(r.genres) : [];
        if (Array.isArray(list)) genres = list.filter((g): g is string => typeof g === 'string');
      } catch {
        // a malformed list counts as none
      }
      info.set(r.document, {
        language: r.language ? r.language.split('-')[0].toLowerCase() : null,
        genres,
        author: r.author,
      });
    }
    // Totals from the per-book snapshots, time per day from their uploaded days; reading sessions on top.
    const time = new Map<string, OverviewTime>();
    const entry = (d: string) => {
      const key = canonical(d);
      let t = time.get(key);
      if (!t) time.set(key, (t = { seconds: 0, sessions: 0, perDay: new Map() }));
      return t;
    };
    const snapshots = new Map<string, BookStatsSnapshot[]>();
    for (const r of db.prepare('SELECT document, payload FROM stats_device_book WHERE user_id = ?').all(userId) as {
      document: string;
      payload: string;
    }[]) {
      const key = canonical(r.document);
      (snapshots.get(key) ?? snapshots.set(key, []).get(key)!).push(JSON.parse(r.payload) as BookStatsSnapshot);
    }
    for (const [document, list] of snapshots) {
      const combined = combineBookStats(list);
      const t = entry(document);
      t.seconds = combined.seconds;
      t.sessions = combined.sessions;
    }
    // Per-book days devices uploaded with their snapshots, every device's summed.
    for (const r of db
      .prepare('SELECT document, date, SUM(seconds) AS seconds FROM stats_device_book_day WHERE user_id = ? GROUP BY document, date HAVING SUM(seconds) > 0')
      .all(userId) as {
      document: string;
      date: string;
      seconds: number;
    }[]) {
      const t = entry(r.document);
      const d = dayNumber(r.date);
      t.perDay.set(d, (t.perDay.get(d) ?? 0) + Number(r.seconds));
    }
    // Time imported from BookOrbit is one more device's. Only books matched to a BookOrbit book have
    // any, so those are the only ones read.
    const matched = new Set(
      (db.prepare("SELECT DISTINCT document FROM connector_matches WHERE user_id = ? AND connector_id = 'bookorbit'")
        .all(userId) as { document: string }[]).map((r) => canonical(r.document))
    );
    for (const document of matched) {
      if (!info.has(document)) continue;
      const imported = readBookorbitStats(db, userId, statsDocuments(db, userId, document));
      if (!imported.book.sessions) continue;
      const t = entry(document);
      t.seconds += imported.book.seconds;
      t.sessions += imported.book.sessions;
      for (const day of imported.daily) {
        const d = dayNumber(day.date);
        t.perDay.set(d, (t.perDay.get(d) ?? 0) + day.seconds);
      }
    }
    const sessionTotals = new Map<string, { seconds: number; count: number; perDay: Map<number, number> }>();
    for (const s of db.prepare('SELECT document, started_at, seconds, utc_offset_minutes FROM reading_sessions WHERE user_id = ?').all(userId) as {
      document: string;
      started_at: number;
      seconds: number;
      utc_offset_minutes: number;
    }[]) {
      const key = canonical(s.document);
      const total = sessionTotals.get(key) ?? { seconds: 0, count: 0, perDay: new Map<number, number>() };
      const d = Math.floor((Number(s.started_at) + Number(s.utc_offset_minutes) * 60) / 86400) - EPOCH_DAY;
      total.perDay.set(d, (total.perDay.get(d) ?? 0) + Number(s.seconds));
      total.seconds += Number(s.seconds);
      total.count += 1;
      sessionTotals.set(key, total);
    }
    // A book's sessions and its snapshots measure the same reading: take whichever saw more, in
    // total and per day.
    for (const [document, total] of sessionTotals) {
      const t = entry(document);
      t.seconds = Math.max(t.seconds, total.seconds);
      t.sessions = Math.max(t.sessions, total.count);
      for (const [d, s] of total.perDay) t.perDay.set(d, Math.max(t.perDay.get(d) ?? 0, s));
    }
    return { info, time };
  }

  return app;
}
