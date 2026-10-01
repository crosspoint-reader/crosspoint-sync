import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';

const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');

describe('app account endpoints', () => {
  it('changes the sync password', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const r = await app.request('/api/v1/account/password', { method: 'POST', headers, body: JSON.stringify({ key: md5('new secret') }) });
    expect(r.status).toBe(200);
    expect((await app.request('/users/auth', { headers })).status).toBe(401); // old password stops working
    const fresh = { ...headers, 'x-auth-key': md5('new secret') };
    expect((await app.request('/users/auth', { headers: fresh })).status).toBe(200);
  });

  it('rejects a password that is not an MD5 key', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const r = await app.request('/api/v1/account/password', { method: 'POST', headers, body: JSON.stringify({ key: 'plain' }) });
    expect(r.status).toBe(400);
  });

  it('clears reading data but keeps the account', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    await app.request('/syncs/progress', { method: 'PUT', headers, body: JSON.stringify({ document: DOC, progress: '/body/DocFragment[2]', percentage: 0.3, device: 'X4', device_id: 'x4' }) });
    expect((await app.request('/api/v1/account/data', { method: 'DELETE', headers })).status).toBe(200);
    const list = (await (await app.request('/api/v1/progress', { headers })).json()) as { items: unknown[] };
    expect(list.items).toHaveLength(0);
    expect((await app.request('/users/auth', { headers })).status).toBe(200);
  });

  it('deletes the account', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    expect((await app.request('/api/v1/account', { method: 'DELETE', headers })).status).toBe(200);
    expect((await app.request('/users/auth', { headers })).status).toBe(401);
  });
});
