import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp, md5, DOC, registerUser } from './helpers.js';
import { resetSessionSecretCache } from '../src/auth/session.js';

type App = ReturnType<typeof makeTestApp>['app'];

afterEach(() => resetSessionSecretCache());

async function signup(app: App, handle: string) {
  return app.request('/auth/signup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ handle }),
  });
}

async function signupSession(app: App, handle: string): Promise<{ token: string; cookie: string }> {
  const res = await signup(app, handle);
  const body = await res.json();
  return { token: body.token, cookie: res.headers.get('set-cookie')!.split(';')[0] };
}

async function createKosync(app: App, cookie: string, username = 'julia', password = 'reader-pw') {
  const res = await app.request('/account/kosync', {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  return { status: res.status, data: await res.json() };
}

describe('master (website) account', () => {
  it('signup issues an xp1_ login token and a session cookie', async () => {
    const { app } = makeTestApp();
    const res = await signup(app, 'julia');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.handle).toBe('julia');
    expect(body.token).toMatch(/^xp1_\d+_[0-9a-f]{32}$/);
    const cookie = res.headers.get('set-cookie')!.split(';')[0];
    const me = await app.request('/auth/me', { headers: { cookie } });
    expect((await me.json()).handle).toBe('julia');
  });

  it('the master token is NOT a kosync device secret', async () => {
    const { app } = makeTestApp();
    const { token } = await signupSession(app, 'julia');
    const auth = await app.request('/users/auth', {
      headers: { 'x-auth-user': 'julia', 'x-auth-key': md5(token) },
    });
    expect(auth.status).toBe(401);
  });

  it('login with the token establishes a session', async () => {
    const { app } = makeTestApp();
    const { token } = await signupSession(app, 'julia');
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(login.status).toBe(200);
  });

  it('recover a lost token: sign in with the linked sync account creds', async () => {
    const { app } = makeTestApp();
    const { cookie } = await signupSession(app, 'julia');
    await createKosync(app, cookie, 'juliareader', 'syncpw');
    // Lost the token; sign in with the sync username + password instead.
    const login = await app.request('/auth/login-kosync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'juliareader', password: 'syncpw' }),
    });
    expect(login.status).toBe(200);
    const c2 = login.headers.get('set-cookie')!.split(';')[0];
    // Logged into the SAME master account.
    expect((await (await app.request('/auth/me', { headers: { cookie: c2 } })).json()).handle).toBe('julia');
  });

  it('sync-account login claims a master for an orphan (device-created) sync account', async () => {
    const { app } = makeTestApp();
    // Device registers a kosync account directly, no web account.
    await app.request('/users/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'reader1', password: md5('devpw') }),
    });
    const login = await app.request('/auth/login-kosync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'reader1', password: 'devpw' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    // A master account now exists and the sync account is linked (v1 works).
    expect((await app.request('/api/v1/connectors', { headers: { cookie } })).status).toBe(200);
    // kosync status shows the linked account.
    expect((await (await app.request('/account/kosync', { headers: { cookie } })).json()).username).toBe('reader1');
  });

  it('rejects sync-account login with a wrong password', async () => {
    const { app } = makeTestApp();
    const { cookie } = await signupSession(app, 'julia');
    await createKosync(app, cookie, 'juliareader', 'syncpw');
    const login = await app.request('/auth/login-kosync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'juliareader', password: 'wrong' }),
    });
    expect(login.status).toBe(401);
  });

  it('v1 data endpoints return 409 until a kosync account is linked', async () => {
    const { app } = makeTestApp();
    const { cookie } = await signupSession(app, 'julia');
    const res = await app.request('/api/v1/connectors', { headers: { cookie } });
    expect(res.status).toBe(409);
  });
});

describe('kosync account linked under a master account', () => {
  it('uses the app-selected account for reads and writes even with another account cookie', async () => {
    const { app, db } = makeTestApp();
    const { cookie } = await signupSession(app, 'uxj4');
    expect((await createKosync(app, cookie, 'uxj4')).status).toBe(200);
    const other = await registerUser(app);
    for (const [username, percentage] of [['uxj4', 0.4], [other.username, 0.3]] as const) {
      const res = await app.request('/syncs/progress', {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-auth-user': username, 'x-auth-key': username === 'uxj4' ? md5('reader-pw') : other.headers['x-auth-key'] },
        body: JSON.stringify({ document: DOC, progress: '/body/DocFragment[2]', percentage, device: 'X4', device_id: 'x4' }),
      });
      expect(res.status).toBe(200);
    }
    const headers = { ...other.headers, cookie };
    const list = await app.request('/api/v1/progress', { headers });
    expect(list.status).toBe(200);
    expect(list.headers.get('Cache-Control')).toBe('no-store');
    expect((await list.json()).items[0].percentage).toBe(0.3);
    expect((await (await app.request('/api/v1/progress', { headers: { cookie } })).json()).items[0].percentage).toBe(0.4);
    const change = await app.request(`/api/v1/documents/${DOC}/status`, { method: 'PUT', headers, body: JSON.stringify({ status: 'finished' }) });
    expect(change.status).toBe(200);
    const status = db.prepare('SELECT status FROM documents WHERE user_id = (SELECT id FROM users WHERE username = ?) AND document = ?');
    expect(status.get(other.username, DOC)).toMatchObject({ status: 'finished' });
    expect(status.get('uxj4', DOC)).not.toMatchObject({ status: 'finished' });
    db.close();
  });

  it('rejects invalid or incomplete app credentials instead of falling back to a valid cookie', async () => {
    const { app, db } = makeTestApp();
    const { cookie } = await signupSession(app, 'uxj4');
    await createKosync(app, cookie, 'uxj4');
    for (const headers of [
      { 'x-auth-user': 'uxj4', 'x-auth-key': md5('wrong') },
      { 'x-auth-user': 'uxj4' },
      { 'x-auth-key': md5('reader-pw') },
      { 'x-auth-user': '', 'x-auth-key': '' },
    ]) {
      expect((await app.request('/api/v1/progress', { headers: { cookie, ...headers } })).status).toBe(401);
    }
    db.close();
  });

  it('create a kosync account with a chosen password; reader + web both work', async () => {
    const { app } = makeTestApp();
    const { cookie } = await signupSession(app, 'julia');
    const { status, data } = await createKosync(app, cookie, 'julia', 'reader-pw');
    expect(status).toBe(200);
    expect(data.username).toBe('julia');
    expect(data.token).toBeUndefined(); // no auto-generated secret
    // The chosen password authenticates the reader (device sends MD5(password)).
    const auth = await app.request('/users/auth', {
      headers: { 'x-auth-user': 'julia', 'x-auth-key': md5('reader-pw') },
    });
    expect(auth.status).toBe(200);
    const conn = await app.request('/api/v1/connectors', { headers: { cookie } });
    expect(conn.status).toBe(200);
  });

  it('rejects create without a password', async () => {
    const { app } = makeTestApp();
    const { cookie } = await signupSession(app, 'julia');
    const res = await app.request('/account/kosync', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'julia' }),
    });
    expect(res.status).toBe(400);
  });

  it('kosync status reflects linked state', async () => {
    const { app } = makeTestApp();
    const { cookie } = await signupSession(app, 'julia');
    expect((await (await app.request('/account/kosync', { headers: { cookie } })).json()).linked).toBe(false);
    await createKosync(app, cookie);
    const status = await (await app.request('/account/kosync', { headers: { cookie } })).json();
    expect(status).toMatchObject({ linked: true, username: 'julia' });
  });

  it('link an existing (device-created) kosync account by password', async () => {
    const { app } = makeTestApp();
    const password = 'reader-pass';
    await app.request('/users/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'reader1', password: md5(password) }),
    });
    const { cookie } = await signupSession(app, 'julia');
    const link = await app.request('/account/kosync', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'reader1', password }),
    });
    expect(link.status).toBe(200);
    expect((await app.request('/api/v1/connectors', { headers: { cookie } })).status).toBe(200);
  });

  it('rejects linking with a wrong password', async () => {
    const { app } = makeTestApp();
    await app.request('/users/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'reader1', password: md5('right') }),
    });
    const { cookie } = await signupSession(app, 'julia');
    const link = await app.request('/account/kosync', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'reader1', password: 'wrong' }),
    });
    expect(link.status).toBe(401);
  });

  it('change password revokes the old one', async () => {
    const { app } = makeTestApp();
    const { cookie } = await signupSession(app, 'julia');
    await createKosync(app, cookie, 'julia', 'oldpw');
    const res = await app.request('/account/kosync/password', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'newpw' }),
    });
    expect(res.status).toBe(200);
    expect((await app.request('/users/auth', { headers: { 'x-auth-user': 'julia', 'x-auth-key': md5('newpw') } })).status).toBe(200);
    expect((await app.request('/users/auth', { headers: { 'x-auth-user': 'julia', 'x-auth-key': md5('oldpw') } })).status).toBe(401);
  });

  it('device sync data is readable from the web session', async () => {
    const { app } = makeTestApp();
    const { cookie } = await signupSession(app, 'julia');
    const { data } = await createKosync(app, cookie, 'julia', 'reader-pw');
    const headers = { 'x-auth-user': data.username, 'x-auth-key': md5('reader-pw'), 'content-type': 'application/json' };
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: 'p', percentage: 0.4, device_id: 'd1' }),
    });
    const list = await app.request('/api/v1/progress', { headers: { cookie } });
    expect(list.status).toBe(200);
    expect((await list.json()).items[0].document).toBe(DOC);
  });

  it('respects REGISTRATION_DISABLED for master signup', async () => {
    const { app } = makeTestApp({ registrationDisabled: true });
    expect((await signup(app, 'nope')).status).toBe(403);
  });
});

describe('deletion', () => {
  it('deletes the kosync account and its data, freeing the username', async () => {
    const { app } = makeTestApp();
    const { cookie } = await signupSession(app, 'julia');
    await createKosync(app, cookie, 'julia', 'pw');
    // Push some data.
    const headers = { 'x-auth-user': 'julia', 'x-auth-key': md5('pw'), 'content-type': 'application/json' };
    await app.request('/syncs/progress', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ document: DOC, progress: 'p', percentage: 0.4, device_id: 'd1' }),
    });
    const del = await app.request('/account/kosync/data', { method: 'DELETE', headers: { cookie } });
    expect(del.status).toBe(200);
    // kosync auth no longer works; v1 falls back to 409 (no linked sync).
    expect((await app.request('/users/auth', { headers })).status).toBe(401);
    expect((await app.request('/api/v1/connectors', { headers: { cookie } })).status).toBe(409);
    // Username is free to reuse.
    const status = await (await app.request('/account/kosync', { headers: { cookie } })).json();
    expect(status.linked).toBe(false);
  });

  it('deletes the master account, its kosync account, and clears the session', async () => {
    const { app } = makeTestApp();
    const { cookie, token } = await signupSession(app, 'julia');
    await createKosync(app, cookie, 'julia', 'pw');
    const del = await app.request('/account', { method: 'DELETE', headers: { cookie } });
    expect(del.status).toBe(200);
    // Master login token no longer works.
    const login = await app.request('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    expect(login.status).toBe(401);
    // kosync account is gone too.
    expect(
      (await app.request('/users/auth', { headers: { 'x-auth-user': 'julia', 'x-auth-key': md5('pw') } })).status
    ).toBe(401);
  });
});
