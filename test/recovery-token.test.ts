import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { backfillMasterAccounts } from '../src/routes/auth.js';
import { hashKey } from '../src/auth/password.js';
import { makeTestApp, md5, registerUser } from './helpers.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY = 'c'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });

describe('recovery token', () => {
  it('is shown in settings and resets the sync password from sign-in', async () => {
    const { app } = makeTestApp();
    const { username, headers } = await registerUser(app);
    const shown = await (await app.request('/api/v1/account/recovery-token', { headers })).json();
    expect(shown.token).toMatch(/^xp1_\d+_[0-9a-f]{32}$/);

    const recover = (token: string) => app.request('/auth/recover', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token, key: md5('new password') }),
    });
    expect((await recover(shown.token.slice(0, -1) + (shown.token.endsWith('0') ? '1' : '0'))).status).toBe(401);
    const res = await recover(shown.token);
    expect(await res.json()).toEqual({ username });
    const auth = (key: string) => app.request('/users/auth', { headers: { ...headers, 'x-auth-key': key } });
    expect((await auth(md5('new password'))).status).toBe(200);
    expect((await auth(headers['x-auth-key'])).status).toBe(401);

    // Replacing it revokes the old one and settings shows the new one.
    const next = await (await app.request('/api/v1/account/recovery-token', { method: 'POST', headers: { ...headers, 'x-auth-key': md5('new password') } })).json();
    expect(next.token).not.toBe(shown.token);
    expect((await recover(shown.token)).status).toBe(401);
  });

  it('backfills master accounts for existing sync accounts in batches', async () => {
    const { db } = makeTestApp();
    for (const name of ['old', 'old2', 'old3']) db.prepare('INSERT INTO users (username, key_hash, created_at) VALUES (?, ?, 0)').run(name, hashKey(md5('pw')));
    expect(await backfillMasterAccounts(db, 2)).toBe(3);
    expect(await backfillMasterAccounts(db)).toBe(0);
    const row = db.prepare('SELECT a.token_enc FROM users u JOIN accounts a ON a.id = u.account_id WHERE u.username = ?').get('old') as { token_enc: string };
    expect(row.token_enc).toBeTruthy();
  });
});
