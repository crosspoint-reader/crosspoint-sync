import { describe, expect, it } from 'vitest';
import { computeActivity, type DocInfo } from '../src/models/activity.js';

const DAY = 86400;
const T = Date.UTC(2026, 8, 1) / 1000;
const doc = (page_count: number | null, status: string | null = null, status_at: number | null = null): DocInfo => ({
  page_count,
  status,
  status_at,
});

describe('computeActivity', () => {
  it('counts only forward progress after the first sync, as a running max across devices', () => {
    const a = computeActivity(
      [
        { document: 'a', percentage: 0.4, at: T }, // baseline: old reading, not put on a day
        { document: 'a', percentage: 0.5, at: T + DAY },
        { document: 'a', percentage: 0.45, at: T + DAY + 60 }, // other device behind: ignored
        { document: 'a', percentage: 0.99, at: T + 2 * DAY },
      ],
      new Map([['a', doc(200)]])
    );
    expect(a.days).toEqual([
      { day: '2026-09-01', pages: 0, syncs: 1 }, // the baseline sync still marks a reading day
      { day: '2026-09-02', pages: 20, syncs: 2 },
      { day: '2026-09-03', pages: 98, syncs: 1 },
    ]);
    expect(a.books[0]).toMatchObject({ pages_read: 198, finished_at: T + 2 * DAY, started_at: T });
    expect(a.pages_total).toBe(198);
  });

  it('manual status wins for finished; unknown page counts stay null', () => {
    const a = computeActivity(
      [
        { document: 'dnf', percentage: 0.99, at: T },
        { document: 'done', percentage: 0.6, at: T },
      ],
      new Map([
        ['dnf', doc(null, 'dnf', T + 5)],
        ['done', doc(100, 'finished', T + 9)],
      ])
    );
    const by = Object.fromEntries(a.books.map((b) => [b.document, b]));
    expect(by.dnf).toMatchObject({ finished_at: null, pages_read: null });
    expect(by.done).toMatchObject({ finished_at: T + 9, pages_read: 60 });
    // Single syncs with no page count still count as reading days.
    expect(a.days).toEqual([{ day: '2026-09-01', pages: 0, syncs: 2 }]);
  });

  it('buckets days in the client timezone', () => {
    const a = computeActivity(
      [
        { document: 'a', percentage: 0.1, at: T },
        { document: 'a', percentage: 0.2, at: T + 2 * 3600 }, // 02:00 UTC = previous evening in New York
      ],
      new Map([['a', doc(100)]]),
      240
    );
    expect(a.days).toEqual([{ day: '2026-08-31', pages: 10, syncs: 2 }]);
  });
});

describe('progress_log backfill (0013)', () => {
  it('adds only samples older than each book\'s first logged row', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const fs = await import('node:fs');
    const db = new DatabaseSync(':memory:');
    db.exec(`CREATE TABLE progress_log (user_id INTEGER, document TEXT, device_id TEXT, percentage REAL, at INTEGER);
      CREATE TABLE progress_samples (user_id INTEGER, document TEXT, pct_bucket INTEGER, percentage REAL, progress TEXT, position TEXT, updated_at INTEGER);
      INSERT INTO progress_log VALUES (1, 'a', 'X4', 0.5, 300);
      INSERT INTO progress_samples VALUES (1, 'a', 100, 0.1, 'p', NULL, 100), (1, 'a', 300, 0.3, 'p', NULL, 200),
        (1, 'a', 500, 0.5, 'p', NULL, 300), (1, 'a', 600, 0.6, 'p', NULL, 400), (1, 'b', 200, 0.2, 'p', NULL, 50);`);
    db.exec(fs.readFileSync(new URL('../migrations/0013_backfill_progress_log.sql', import.meta.url), 'utf8'));
    const rows = db.prepare('SELECT document, percentage, at FROM progress_log ORDER BY document, at').all();
    expect(rows.map((r) => [r.document, r.at])).toEqual([['a', 100], ['a', 200], ['a', 300], ['b', 50]]);
  });
});
