import { describe, expect, it } from 'vitest';
import { migrate, openDatabase, type DB } from '../src/db/db.js';
import {
  claimReady,
  enqueue,
  markDone,
  markFailed,
  queueDepth,
  queueErrors,
  _internals,
} from '../src/connectors/queue.js';
import type { OutboundEvent } from '../src/connectors/types.js';

function freshDb(): DB {
  const db = openDatabase(':memory:');
  migrate(db);
  db.prepare('INSERT INTO users (id, username, key_hash, created_at) VALUES (1, ?, ?, 0)').run(
    'u',
    'h'
  );
  return db;
}

const ev = (over: Partial<OutboundEvent> = {}): OutboundEvent => ({
  kind: 'progress',
  document: 'a'.repeat(32),
  percentage: 0.5,
  timestamp: 1000,
  ...over,
});

describe('connector queue', () => {
  it('groups delivery errors by type and removes recovered errors from the status', () => {
    const db = freshDb();
    for (const key of ['highlight:a', 'highlight:b']) {
      enqueue(db, 1, 'bookorbit', ev({ kind: 'highlight' }), key, 100);
    }
    const rows = claimReady(db, 10, 100);
    for (const row of rows) markFailed(db, row, 'clipping has no position', false, 100);
    expect(queueErrors(db, 1, 'bookorbit', 100)).toEqual([{ kind: 'clipping', message: 'clipping has no position', count: 2, titles: ['Untitled book'] }]);
    expect(queueErrors(db, 1, 'hardcover', 100)).toEqual([]);
    enqueue(db, 1, 'bookorbit', ev({ kind: 'highlight' }), 'highlight:a', 101);
    expect(queueErrors(db, 1, 'bookorbit', 101)[0].count).toBe(1);
    markDone(db, rows[1], 102);
    expect(queueErrors(db, 1, 'bookorbit', 102)).toEqual([]);
  });

  it('names the books behind an error, once per book, and drops old given-up ones', () => {
    const db = freshDb();
    const piranesi = 'p'.repeat(32);
    db.prepare("INSERT INTO documents (user_id, document, title, updated_at) VALUES (1, ?, 'Piranesi', 0)").run(piranesi);
    enqueue(db, 1, 'audiobookshelf', ev({ document: piranesi }), 'progress', 100);
    enqueue(db, 1, 'audiobookshelf', ev({ document: piranesi, kind: 'finished' }), 'finished', 100);
    for (const row of claimReady(db, 10, 100)) markFailed(db, row, 'no book match', false, 100);
    expect(queueErrors(db, 1, 'audiobookshelf', 100)).toEqual([{ kind: 'book', message: 'no book match', count: 1, titles: ['Piranesi'] }]);
    expect(queueErrors(db, 1, 'audiobookshelf', 100 + 15 * 86400)).toEqual([]);
  });

  it('coalesces same (connector, document, kind) to the latest payload', () => {
    const db = freshDb();
    enqueue(db, 1, 'hardcover', ev({ percentage: 0.3 }), 'progress', 100);
    enqueue(db, 1, 'hardcover', ev({ percentage: 0.6 }), 'progress', 101);
    const ready = claimReady(db, 10, 200);
    expect(ready).toHaveLength(1);
    expect(JSON.parse(ready[0].payload).percentage).toBe(0.6);
  });

  it('keeps distinct highlight coalesce keys separate', () => {
    const db = freshDb();
    enqueue(db, 1, 'readwise', ev({ kind: 'highlight' }), 'highlight:c1', 100);
    enqueue(db, 1, 'readwise', ev({ kind: 'highlight' }), 'highlight:c2', 100);
    expect(claimReady(db, 10, 200)).toHaveLength(2);
  });

  it('only returns rows whose next_try_at has passed', () => {
    const db = freshDb();
    enqueue(db, 1, 'hardcover', ev(), 'progress', 500);
    expect(claimReady(db, 10, 400)).toHaveLength(0);
    expect(claimReady(db, 10, 500)).toHaveLength(1);
  });

  it('markDone removes the row from the ready set', () => {
    const db = freshDb();
    enqueue(db, 1, 'hardcover', ev(), 'progress', 100);
    const [row] = claimReady(db, 10, 200);
    markDone(db, row, 200);
    expect(claimReady(db, 10, 300)).toHaveLength(0);
    expect(queueDepth(db, 1, 'hardcover')).toEqual({ pending: 0, dead: 0 });
  });

  it('keeps a newer event that replaced the row while the older one was processed', () => {
    const db = freshDb();
    enqueue(db, 1, 'hardcover', ev(), 'progress', 100);
    enqueue(db, 1, 'readwise', ev(), 'progress', 100);
    const [hc, rw] = claimReady(db, 10, 200);
    enqueue(db, 1, 'hardcover', ev({ percentage: 0.6 }), 'progress', 201);
    enqueue(db, 1, 'readwise', ev({ percentage: 0.6 }), 'progress', 201);
    markDone(db, hc, 202);
    markFailed(db, rw, 'permanent', false, 202);
    const left = claimReady(db, 10, 300);
    expect(left.map((r) => [r.connector_id, JSON.parse(r.payload).percentage])).toEqual([['hardcover', 0.6], ['readwise', 0.6]]);
  });

  it('retryable failure backs off; non-retryable dead-letters immediately', () => {
    const db = freshDb();
    enqueue(db, 1, 'hardcover', ev(), 'progress', 100);
    let [row] = claimReady(db, 10, 100);
    markFailed(db, row, 'boom', true, 100);
    // Not ready immediately after backoff window start
    expect(claimReady(db, 10, 100)).toHaveLength(0);
    expect(claimReady(db, 10, 100 + _internals.BACKOFF[0])).toHaveLength(1);

    enqueue(db, 1, 'readwise', ev(), 'highlight:x', 100);
    [row] = claimReady(db, 10, 100).filter((r) => r.connector_id === 'readwise');
    markFailed(db, row, 'permanent', false, 100);
    expect(queueDepth(db, 1, 'readwise')).toEqual({ pending: 0, dead: 1 });
  });

  it('dead-letters after MAX_ATTEMPTS retryable failures', () => {
    const db = freshDb();
    enqueue(db, 1, 'hardcover', ev(), 'progress', 0);
    let t = 0;
    for (let i = 0; i < _internals.MAX_ATTEMPTS; i++) {
      const ready = claimReady(db, 10, t);
      expect(ready).toHaveLength(1);
      markFailed(db, ready[0], 'again', true, t);
      t += 1_000_000; // jump past any backoff
    }
    expect(queueDepth(db, 1, 'hardcover')).toEqual({ pending: 0, dead: 1 });
  });
});
