import type { DB } from '../db/db.js';
import { getConnector, fetchTransport } from './registry.js';
import { decryptCredential, getAccount, listAccounts } from './store.js';
import type { Connector, Credential, HttpTransport } from './types.js';

export interface Revocation {
  conn: Connector;
  cred: Credential;
}

/**
 * The credentials a user's links hold, for connectors that revoke them. Read
 * before the accounts are deleted or replaced; revoke with revokeSoon after.
 */
export function revocations(db: DB, userId: number, connectorId?: string): Revocation[] {
  const accounts = connectorId ? [getAccount(db, userId, connectorId)] : listAccounts(db, userId);
  const out: Revocation[] = [];
  for (const account of accounts) {
    const conn = account && getConnector(account.connector_id);
    if (!conn?.revoke) continue;
    try {
      out.push({ conn, cred: decryptCredential(account!) });
    } catch {
      // unreadable (e.g. the encryption key changed): nothing to revoke with
    }
  }
  return out;
}

/** Revoke in the background, so the user never waits on the service. Failures are logged. */
export function revokeSoon(list: Revocation[], userId: number, http: HttpTransport = fetchTransport): void {
  for (const { conn, cred } of list) {
    void conn.revoke!(cred, http).catch((err) =>
      console.error(JSON.stringify({ msg: 'connector revoke failed', connector: conn.id, user_id: userId,
        error: err instanceof Error ? err.message : String(err) })));
  }
}
