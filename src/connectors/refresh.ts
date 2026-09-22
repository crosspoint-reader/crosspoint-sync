import type { DB } from '../db/db.js';
import { pollConnector } from './fanin.js';
import { fetchTransport } from './registry.js';
import { resolveMatch } from './runner.js';
import { getAccount, getMatch } from './store.js';
import type { HttpTransport } from './types.js';

export type ProgressRefresh = (userId: number, document: string) => Promise<void>;

/**
 * Per-book fan-in pullers consulted when a device asks for progress. This is the
 * ONLY time these services hear from us — there is no background polling — so
 * request rates stay at human reading cadence.
 *
 * strict:        a puller whose failure fails the progress GET (BookFusion: its
 *                sidecar matches are treated as authoritative for the position).
 *                Non-strict pullers (Kindle) are best-effort: a sick Amazon session
 *                must never break a device's sync, so errors are logged and skipped.
 * sidecarOnly:   only poll when the match came from the book's plugin sidecar.
 * matchOnDemand: when no match exists yet, resolve one right here, so a read-only
 *                connector still gets auto-matching without fan-out ever running.
 *                Kindle's match searches the uploaded library snapshot plus the
 *                cached purchased-book list; a cold cache costs one network fetch
 *                inside the progress GET, bounded by the refresh deadline. A stale
 *                'not found' is retried only when the credential (which carries
 *                the library) was re-uploaded since.
 */
const PER_BOOK_PULLERS: { id: string; strict: boolean; sidecarOnly: boolean; matchOnDemand?: boolean }[] = [
  { id: 'bookfusion', strict: true, sidecarOnly: true },
  { id: 'kindle', strict: false, sidecarOnly: false, matchOnDemand: true },
];

/** Shared by both progress endpoints; only overlapping requests share a refresh. */
export function createProgressRefresh(db: DB, http: HttpTransport = fetchTransport): ProgressRefresh {
  const pending = new Map<string, Promise<void>>();
  return async (userId, document) => {
    const pullers: typeof PER_BOOK_PULLERS = [];
    for (const p of PER_BOOK_PULLERS) {
      const account = getAccount(db, userId, p.id);
      if (!account?.enabled) continue;
      let match = getMatch(db, userId, p.id, document);
      if (!match?.external_id && p.matchOnDemand && match?.source !== 'manual' &&
          (!match || match.updated_at < account.updated_at)) {
        await resolveMatch(db, p.id, userId, document, http).catch(() => null);
        match = getMatch(db, userId, p.id, document);
      }
      if (!match?.external_id) continue;
      if (p.sidecarOnly && match.source !== 'sidecar') continue;
      pullers.push(p);
    }
    if (pullers.length === 0) return;
    for (const p of pullers) {
      if (!p.strict) continue;
      const account = getAccount(db, userId, p.id);
      if (account && account.status !== 'ok') {
        throw new Error(`${p.id} account needs attention`);
      }
    }
    const key = JSON.stringify([userId, document]);
    const existing = pending.get(key);
    if (existing) return existing;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new DOMException('Progress refresh timed out', 'TimeoutError');
        controller.abort(error);
        reject(error);
      }, 10_000);
    });
    const bounded: HttpTransport = (url, init) => {
      controller.signal.throwIfAborted();
      return http(url, {
        ...init, signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
      });
    };
    const refresh = Promise.race([
      Promise.all(
        pullers.map((p) =>
          pollConnector(db, userId, p.id, bounded, {
            document,
            signal: controller.signal,
            throwOnError: p.strict,
          })
        )
      ),
      deadline,
    ]).then(() => {}).finally(() => {
      clearTimeout(timer);
      pending.delete(key);
    });
    pending.set(key, refresh);
    return refresh;
  };
}
