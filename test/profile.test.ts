import { describe, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { syncStreak } from '../src/routes/profile.js';

describe('public profile', () => {
  it('is off by default, shows reading and finished books when on, and 404s once off', async () => {
    const { app } = makeTestApp();
    const { headers } = await registerUser(app);
    const other = 'b'.repeat(32);
    for (const [document, title, percentage] of [[DOC, 'Foundryside <b>', 0.4], [other, 'Piranesi', 1]] as const) {
      await app.request('/syncs/progress', { method: 'PUT', headers, body: JSON.stringify({ document, progress: 'x', percentage, device: 'X4', device_id: 'x4' }) });
      await app.request('/api/v1/documents', { method: 'PUT', headers, body: JSON.stringify({ items: [{ document, title }] }) });
      await app.request(`/api/v1/documents/${document}/info`, { method: 'PUT', headers, body: JSON.stringify({ page_count: document === DOC ? 250 : 0 }) });
    }
    expect(await (await app.request('/api/v1/profile', { headers })).json()).toEqual({ slug: null, display_name: null });

    const { slug } = (await (await app.request('/api/v1/profile', { method: 'PUT', headers, body: JSON.stringify({ enabled: true }) })).json()) as { slug: string };
    const page = await app.request(`/u/${slug}`);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Foundryside &lt;b&gt;');
    expect(html.indexOf('Reading now')).toBeLessThan(html.indexOf('Foundryside'));
    expect(html.indexOf('Finished')).toBeLessThan(html.indexOf('Piranesi'));
    // No device stats uploaded: no reading time, but pages come from the sync history.
    expect(html).not.toContain('hours read');
    expect(html).toContain('<b>100</b><span>pages read</span>');

    await app.request('/api/v1/profile', { method: 'PUT', headers, body: JSON.stringify({ enabled: false }) });
    expect((await app.request(`/u/${slug}`)).status).toBe(404);
  });
});

describe('display name', () => {
  it('keeps case and inner spaces, trims, clears when blank, and titles the public page', async () => {
    const { app } = makeTestApp();
    const { headers, username } = await registerUser(app);
    const put = (body: unknown) => app.request('/api/v1/profile', { method: 'PUT', headers, body: JSON.stringify(body) });
    const { slug } = (await (await put({ enabled: true })).json()) as { slug: string };
    expect(await (await app.request(`/u/${slug}`)).text()).toContain(`<h1>${username}'s reading</h1>`);

    expect(await (await put({ display_name: '  Jane  Q. <Reader> ' })).json()).toEqual({ slug, display_name: 'Jane  Q. <Reader>' });
    expect(await (await app.request(`/u/${slug}`)).text()).toContain("<h1>Jane  Q. &lt;Reader&gt;'s reading</h1>");

    expect((await put({ display_name: 'x'.repeat(65) })).status).toBe(400);
    expect((await put({ display_name: 'a\nb' })).status).toBe(400);
    expect((await put({ display_name: 5 })).status).toBe(400);
    expect((await put({})).status).toBe(400);

    expect(await (await put({ display_name: '   ' })).json()).toEqual({ slug, display_name: null });
  });
});

describe('syncStreak', () => {
  const now = Date.parse('2026-10-25T12:00:00Z');
  it('counts back from today, or from yesterday when today has no reading', () => {
    expect(syncStreak(['2026-10-23', '2026-10-24', '2026-10-25'], now)).toBe(3);
    expect(syncStreak(['2026-10-22', '2026-10-23', '2026-10-24'], now)).toBe(3);
    expect(syncStreak(['2026-10-21', '2026-10-23'], now)).toBe(0);
  });
});
