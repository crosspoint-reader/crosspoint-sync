import { afterEach, describe, expect, it } from 'vitest';
import { makeTestApp } from './helpers.js';

describe('website mode', () => {
  afterEach(() => void delete process.env.LEGACY_WEB);

  it('sends the old pages to the app by default, keeping Kindle', async () => {
    const { app } = makeTestApp();
    const landing = await (await app.request('/')).text();
    expect(landing).toContain('href="/app/"');
    expect(landing).not.toContain('id="ksLogin"');
    expect((await app.request('/account')).headers.get('location')).toBe('/app/#/settings');
    expect((await app.request('/progress')).headers.get('location')).toBe('/app/');
    expect((await app.request('/review/hardcover')).headers.get('location')).toBe('/app/#/settings/hardcover');
    expect((await app.request('/link/hardcover')).headers.get('location')).toBe('/app/#/settings');
    expect((await app.request('/kindle')).headers.get('location')).toBe('/signin?next=/kindle#get-started');
    expect(await (await app.request('/signin')).text()).toContain('id="ksLogin"');
  });

  it('keeps the whole old site with LEGACY_WEB=1', async () => {
    process.env.LEGACY_WEB = '1';
    const { app } = makeTestApp();
    expect(await (await app.request('/')).text()).toContain('id="ksLogin"');
    expect((await app.request('/account')).headers.get('location')).toBe('/');
  });
});
