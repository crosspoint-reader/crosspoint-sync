import { describe, expect, it } from 'vitest';
import { hashKey, verifyKey } from '../src/auth/password.js';
import { makeTestApp, md5 } from './helpers.js';

describe('password hashing', () => {
  it('hashes and verifies the md5 auth key', () => {
    const key = md5('hunter2');
    const stored = hashKey(key);
    expect(stored.startsWith('pbkdf2$10000$')).toBe(true);
    expect(verifyKey(key, stored)).toBe(true);
    expect(verifyKey(md5('wrong'), stored)).toBe(false);
  });

  it('rejects malformed stored hashes without throwing', () => {
    expect(verifyKey('abc', 'garbage')).toBe(false);
    expect(verifyKey('abc', 'pbkdf2$notanumber$aa$bb')).toBe(false);
  });
});

describe('registration validation', () => {
  it('rejects bad usernames and empty passwords', async () => {
    const { app } = makeTestApp();
    for (const body of [
      { username: 'has spaces', password: md5('x') },
      { username: '', password: md5('x') },
      { username: 'ok', password: '' },
      { username: 'ok' },
      {},
    ]) {
      const res = await app.request('/users/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(403);
    }
  });

  it('healthz is unauthenticated', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('ok');
  });
});

describe('session secret persistence', () => {
  it('keeps web sessions valid across restarts without SESSION_SECRET', async () => {
    const { openDatabase, migrate } = await import('../src/db/db.js');
    const { loadSessionSecret, signSession, verifySession, resetSessionSecretCache } =
      await import('../src/auth/session.js');
    const db = openDatabase(':memory:');
    migrate(db);
    const boot1: NodeJS.ProcessEnv = {};
    loadSessionSecret(db, boot1);
    const cookie = signSession(7, 60, boot1);
    resetSessionSecretCache(); // simulate a new process
    const boot2: NodeJS.ProcessEnv = {};
    loadSessionSecret(db, boot2);
    expect(boot2.SESSION_SECRET).toBe(boot1.SESSION_SECRET);
    expect(verifySession(cookie, boot2)).toEqual({ uid: 7 });
    resetSessionSecretCache();
  });
});

describe('new usernames are stored lowercase', () => {
  it('authenticates and blocks duplicate registration regardless of case', async () => {
    const { app } = makeTestApp();
    const create = (username: string) =>
      app.request('/users/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password: md5('pw') }),
      });
    expect((await create('Alice')).status).toBe(201);
    expect((await create('alice')).status).toBe(402);
    const auth = await app.request('/users/auth', {
      headers: { 'x-auth-user': 'ALICE', 'x-auth-key': md5('pw') },
    });
    expect(auth.status).toBe(200);
  });
});
