import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script, runInNewContext } from 'node:vm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { fromEnv } from '../src/config.js';
import { makeTestApp, md5, type TestServer } from './helpers.js';

const servers: TestServer[] = [];
let webDir: string;
beforeAll(() => {
  webDir = mkdtempSync(join(tmpdir(), 'crosspoint-base-path-'));
  mkdirSync(join(webDir, 'assets'));
  writeFileSync(join(webDir, 'index.html'), '<script src="./assets/app.js"></script>');
  writeFileSync(join(webDir, 'assets/app.js'), '/* app */');
});
afterEach(() => {
  for (const { db } of servers.splice(0)) db.close();
  vi.unstubAllEnvs();
});
afterAll(() => rmSync(webDir, { recursive: true }));

describe('BASE_PATH configuration', () => {
  it.each(['', '/'])('treats %j as a root deployment', (basePath) => {
    expect(fromEnv({ BASE_PATH: basePath }).basePath).toBe('');
  });
  it('defaults to root and normalizes trailing slashes', () => {
    expect(fromEnv({}).basePath).toBe('');
    expect(fromEnv({ BASE_PATH: '/services/reading/' }).basePath).toBe('/services/reading');
  });
  it.each(['reading', '//', '//example.com/reading', '/a//b', '/a/../b', '/a/./b', '/a?b', '/a#b', '/a%2fb', "/a'b", '/a\\b'])('rejects %j', (basePath) => {
    expect(() => fromEnv({ BASE_PATH: basePath })).toThrow('BASE_PATH');
  });
});

describe.each(['', '/reading', '/services/reading'])('deployment at %j', (basePath) => {
  function setup(legacy = false) {
    vi.stubEnv('WEB_APP_DIR', webDir);
    vi.stubEnv('LEGACY_WEB', legacy ? '1' : '');
    const server = makeTestApp({ basePath });
    servers.push(server);
    return server.app;
  }

  it('serves pages, redirects and static app assets without escaping the prefix', async () => {
    const app = setup();
    if (basePath) {
      const redirect = await app.request(`${basePath}?hello=world`);
      expect(redirect.status).toBe(308);
      expect(redirect.headers.get('location')).toBe(`${basePath}/?hello=world`);
      expect((await app.request('/healthz')).status).toBe(404);
      expect((await app.request(`${basePath}-other/healthz`)).status).toBe(404);
    }
    const html = await (await app.request(`${basePath}/`)).text();
    expect(html).toContain(`href="${basePath}/app/"`);
    expect(html).toContain(`srcset="${basePath}/landing/`);
    expect(html).toContain(`url(${basePath}/fonts/`);
    for (const [path, target] of [
      ['/app', '/app/'], ['/account', '/app/#/settings'],
      ['/review/hardcover', '/app/#/settings/hardcover'], ['/progress', '/app/'],
    ]) {
      expect((await app.request(basePath + path)).headers.get('location')).toBe(basePath + target);
    }
    expect((await app.request(`${basePath}/kindle`)).headers.get('location'))
      .toBe(`${basePath}/signin?next=${basePath}/kindle#get-started`);
    const index = await app.request(`${basePath}/app/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('./assets/app.js');
    const asset = await app.request(`${basePath}/app/assets/app.js`);
    expect(await asset.text()).toBe('/* app */');
    expect((await app.request(`${basePath}/logo.png`)).status).toBe(200);
    expect((await app.request(`${basePath}/kindle-link.zip`)).status).toBe(200);
  });

  it('serves the app at the explicit index URL', async () => {
    const app = setup();
    const index = await app.request(`${basePath}/app/index.html`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain('./assets/app.js');
  });

  it('supports KOSync, the extended API and API CORS under the prefix', async () => {
    const app = setup();
    const headers = { 'content-type': 'application/json', 'x-auth-user': 'reader', 'x-auth-key': md5('password') };
    expect((await app.request(`${basePath}/users/create`, {
      method: 'POST', headers, body: JSON.stringify({ username: 'reader', password: md5('password') }),
    })).status).toBe(201);
    expect((await app.request(`${basePath}/users/auth`, { headers })).status).toBe(200);
    expect((await app.request(`${basePath}/api/v1/progress`, { headers })).status).toBe(200);
    const login = await app.request(`${basePath}/auth/login-kosync`, {
      method: 'POST', headers, body: JSON.stringify({ username: 'reader', password: 'password' }),
    });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toContain(`Path=${basePath || '/'};`);
    const health = await app.request(`${basePath}/healthz`, { headers: { origin: 'https://reader.test' } });
    expect((await health.json()).status).toBe('ok');
    expect(health.headers.get('access-control-allow-origin')).toBe('*');
    const preflight = await app.request(`${basePath}/api/v1/progress`, {
      method: 'OPTIONS', headers: { origin: 'https://reader.test', 'access-control-request-method': 'GET' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('scopes session cookies consistently for signup, login, logout and deletion', async () => {
    const app = setup();
    const post = (path: string, body: unknown) => app.request(basePath + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const signup = await post('/auth/signup', { handle: 'reader' });
    const cookie = signup.headers.get('set-cookie')!;
    expect(cookie).toContain(`Path=${basePath || '/'};`);
    const { token } = await signup.json();
    const login = await post('/auth/login', { token });
    expect(login.headers.get('set-cookie')).toContain(`Path=${basePath || '/'};`);
    const headers = { cookie: cookie.split(';')[0] };
    expect((await app.request(`${basePath}/auth/me`, { headers })).status).toBe(200);
    const logout = await post('/auth/logout', {});
    expect(logout.headers.get('set-cookie')!.split(';').map((s) => s.trim())).toContain(`Path=${basePath || '/'}`);
    const deleted = await app.request(`${basePath}/account`, { method: 'DELETE', headers });
    expect(deleted.status).toBe(200);
    expect(deleted.headers.get('set-cookie')!.split(';').map((s) => s.trim())).toContain(`Path=${basePath || '/'}`);
  });

  it('prefixes legacy links, inline scripts and reader setup URLs', async () => {
    const app = setup(true);
    const signup = await app.request(`${basePath}/auth/signup`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'reader' }),
    });
    const headers = { cookie: signup.headers.get('set-cookie')!.split(';')[0] };
    for (const path of ['/', '/account', '/progress', '/link/kindle', '/review/kindle', '/kindle', '/spotify']) {
      const html = await (await app.request(basePath + path, { headers: path === '/' ? {} : headers })).text();
      expect(html).toContain(`href="${basePath}/favicon.png"`);
      if (basePath) {
        expect(html).not.toMatch(/(?:href|src|srcset)="\/(?!services\/reading\/|reading\/)/);
        expect(html).not.toMatch(/(?:fetch|jget|jsend|post)\('\/(?!services\/reading\/|reading\/)/);
      }
      for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        expect(() => new Script(script)).not.toThrow();
      }
      if (path === '/account') expect(html).toContain(`window.location.origin + '${basePath}'`);
    }
  });

  it('keeps sign-in return URLs inside this deployment', async () => {
    const app = setup();
    const html = await (await app.request(`${basePath}/signin`)).text();
    const next = html.match(/const NEXT = ([\s\S]*?\}\)\(\));/)![1];
    const resolve = (value: string) => runInNewContext(next, {
      URL, URLSearchParams, location: { origin: 'https://books.test', search: `?next=${encodeURIComponent(value)}` },
    });
    expect(resolve(`${basePath}/kindle?setup=1#start`)).toBe(`${basePath}/kindle?setup=1#start`);
    for (const value of ['https://other.test', '//other.test', '/\\other.test', '']) {
      expect(resolve(value)).toBe(`${basePath}/account`);
    }
    if (basePath) expect(resolve(`${basePath}/../../outside`)).toBe(`${basePath}/account`);
  });

  it('keeps OS association files at domain root with prefixed callback paths', async () => {
    vi.stubEnv('APPLE_TEAM_ID', 'TEAM');
    vi.stubEnv('ANDROID_CERT_SHA256', 'certificate');
    const app = setup();
    const apple = await (await app.request('/.well-known/apple-app-site-association')).json();
    expect(apple.applinks.details[0].components).toEqual([{ '/': `${basePath}/connectors/*/callback` }]);
    expect((await app.request('/.well-known/assetlinks.json')).status).toBe(200);
  });
});
