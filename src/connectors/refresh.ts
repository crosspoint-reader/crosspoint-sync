import type { DB } from '../db/db.js';
import { pollConnector } from './fanin.js';
import { fetchTransport } from './registry.js';
import { getAccount, getMatch } from './store.js';
import type { HttpTransport } from './types.js';

export type ProgressRefresh = (userId: number, document: string) => Promise<void>;

/** Shared by both progress endpoints; only overlapping requests share a refresh. */
export function createProgressRefresh(db: DB, http: HttpTransport = fetchTransport): ProgressRefresh {
  const pending = new Map<string, Promise<void>>();
  return (userId, document) => {
    const account = getAccount(db, userId, 'bookfusion');
    const match = getMatch(db, userId, 'bookfusion', document);
    if (!account?.enabled || match?.source !== 'sidecar' || !match.external_id) return Promise.resolve();
    if (account.status !== 'ok') return Promise.reject(new Error('BookFusion account needs attention'));
    const key = JSON.stringify([userId, document]);
    const existing = pending.get(key);
    if (existing) return existing;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new DOMException('BookFusion progress refresh timed out', 'TimeoutError');
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
      pollConnector(db, userId, 'bookfusion', bounded, { document, signal: controller.signal, throwOnError: true }),
      deadline,
    ]).then(() => {}).finally(() => {
      clearTimeout(timer);
      pending.delete(key);
    });
    pending.set(key, refresh);
    return refresh;
  };
}
