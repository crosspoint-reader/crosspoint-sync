import { runInNewContext } from 'node:vm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('Micro.blog web setup', () => {
  // These exercise the old server-rendered pages.
  beforeAll(() => void (process.env.LEGACY_WEB = '1'));
  afterAll(() => void delete process.env.LEGACY_WEB);

  it('lists Micro.blog on the public services page', async () => {
    const { app } = makeTestApp();
    const html = await (await app.request('/')).text();
    expect(html).toContain('Micro.blog');
    expect(html).toContain('Currently reading');
    expect(html).toContain('Finished reading');

    const icon = await app.request('/icons/microblog.png');
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/png');
    expect([...new Uint8Array(await icon.arrayBuffer()).slice(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
  });

  it('renders where to create the pasted app token', async () => {
    const { app } = makeTestApp();
    const signup = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: `web-${Date.now()}` }),
    });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const html = await (await app.request('/link/microblog', { headers: { cookie } })).text();

    const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
    expect(script).toBeTruthy();
    const elements = new Map<string, { textContent: string; innerHTML: string; hidden: boolean; disabled: boolean; onclick?: () => void }>();
    const getElement = (id: string) => {
      let element = elements.get(id);
      if (!element) {
        element = { textContent: '', innerHTML: '', hidden: false, disabled: false };
        elements.set(id, element);
      }
      return element;
    };

    runInNewContext(script!, {
      location: { pathname: '/link/microblog', protocol: 'https:', hostname: 'sync.example.com' },
      document: { getElementById: getElement },
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ connectors: [{ id: 'microblog', name: 'Micro.blog', credential_kind: 'token' }] }),
      }),
      setTimeout: () => 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(getElement('desc').textContent).toBe(
      'Connect an app token to keep your Currently reading and Finished reading bookshelves in sync.',
    );
    expect(getElement('form').innerHTML).toContain('Sign in to Micro.blog');
    expect(getElement('form').innerHTML).toContain('https://micro.blog/account/apps');
    expect(getElement('form').innerHTML).toContain('Account → App tokens');
    expect(getElement('form').innerHTML).toContain('CrossPoint Sync');
    expect(getElement('form').innerHTML).toContain('Copy the new token and paste it below');
    expect(getElement('form').innerHTML).toContain('full access to your Micro.blog account');
    expect(getElement('form').innerHTML).toContain('type="password"');
  });

  it('does not submit a token over non-loopback HTTP', async () => {
    const { app } = makeTestApp();
    const signup = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: `web-insecure-${Date.now()}` }),
    });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const html = await (await app.request('/link/microblog', { headers: { cookie } })).text();
    const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
    const elements = new Map<string, { textContent: string; innerHTML: string; hidden: boolean; disabled: boolean; value: string; onclick?: () => void }>();
    const getElement = (id: string) => {
      let element = elements.get(id);
      if (!element) {
        element = { textContent: '', innerHTML: '', hidden: false, disabled: false, value: '' };
        elements.set(id, element);
      }
      return element;
    };
    let fetches = 0;

    runInNewContext(script!, {
      location: { pathname: '/link/microblog', protocol: 'http:', hostname: 'sync.example.com' },
      document: { getElementById: getElement },
      fetch: async () => {
        fetches += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ connectors: [{ id: 'microblog', name: 'Micro.blog', credential_kind: 'token' }] }),
        };
      },
      setTimeout: () => 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    getElement('tok').value = 'secret-token';
    await getElement('go').onclick?.();

    expect(fetches).toBe(1);
    expect(getElement('e').textContent).toContain('HTTPS');
  });

  it('escapes apostrophes in catalog data embedded in match-picker attributes', async () => {
    const { app } = makeTestApp();
    const signup = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: `web-picker-${Date.now()}` }),
    });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const html = await (await app.request('/review/microblog', {
      headers: { cookie },
    })).text();
    const script = html.match(/<script>\n([\s\S]*?)\n<\/script>/)?.[1];
    const escDeclaration = script?.match(/const esc = .*?;\n/)?.[0];

    expect(escDeclaration).toBeTruthy();
    const escaped = runInNewContext(`${escDeclaration}esc(input)`, {
      input: `The Sorcerer's Stone' onmouseover="alert(1)`,
    });
    expect(escaped).toBe(
      'The Sorcerer&#39;s Stone&#39; onmouseover=&quot;alert(1)',
    );
  });
});
