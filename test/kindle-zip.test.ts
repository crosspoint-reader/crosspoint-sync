import { describe, expect, it } from 'vitest';
import { fromBufferPromise } from 'yauzl';
import { buildZip } from '../src/kindle-zip.js';
import { makeTestApp } from './helpers.js';

async function unzipEntries(buf: Buffer): Promise<Map<string, string>> {
  const zip = await fromBufferPromise(buf, { lazyEntries: true });
  const out = new Map<string, string>();
  await new Promise<void>((resolve, reject) => {
    zip.on('error', reject);
    zip.on('end', () => resolve());
    zip.on('entry', async (entry) => {
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(c as Buffer);
      out.set(entry.fileName, Buffer.concat(chunks).toString('utf8'));
      zip.readEntry();
    });
    zip.readEntry();
  });
  return out;
}

describe('buildZip', () => {
  it('produces a valid store-only archive', async () => {
    const zip = buildZip([
      { name: 'manifest.json', data: Buffer.from('{"name":"test"}') },
      { name: 'code.js', data: Buffer.from('console.log(1)') },
    ]);
    const entries = await unzipEntries(zip);
    expect(entries.get('manifest.json')).toBe('{"name":"test"}');
    expect(entries.get('code.js')).toBe('console.log(1)');
  });

  it('is deterministic (fixed timestamps)', () => {
    const entries = [{ name: 'a.txt', data: Buffer.from('a') }];
    expect(buildZip(entries).equals(buildZip(entries))).toBe(true);
  });
});

describe('GET /kindle-link.zip', () => {
  it('serves the extension as a zip attachment', async () => {
    const { app } = makeTestApp();
    const res = await app.request('/kindle-link.zip');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain('crosspoint-kindle-link.zip');
    const entries = await unzipEntries(Buffer.from(await res.arrayBuffer()));
    const manifest = JSON.parse(entries.get('manifest.json') ?? '{}');
    expect(manifest.name).toContain('Kindle');
    for (const f of ['background.js', 'lib.mjs', 'popup.html', 'popup.js']) {
      expect(entries.has(f), `zip contains ${f}`).toBe(true);
    }
  });
});

describe('GET /kindle (stealth landing page)', () => {
  it('requires a session and ships the instructions + caution', async () => {
    const { app } = makeTestApp();
    expect((await app.request('/kindle')).status).toBe(302);
    const signup = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: `web-${Date.now()}` }),
    });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const res = await app.request('/kindle', { headers: { cookie } });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('/kindle-link.zip');
    expect(html).toContain('chrome://extensions');
    expect(html).toContain('Terms of Service');
    expect(html).toContain('Experimental');
    expect(html).toContain('/api/v1/connectors/kindle/reveal');
  });
});

describe('Kindle connector page (dashboard)', () => {
  it('ships the download, load-unpacked instructions, and the ToS caution', async () => {
    const { app } = makeTestApp();
    const signup = await app.request('/auth/signup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: `web-${Date.now()}` }),
    });
    const cookie = signup.headers.get('set-cookie')!.split(';')[0];
    const html = await (await app.request('/link/kindle', { headers: { cookie } })).text();
    expect(html).toContain('/kindle-link.zip');
    expect(html).toContain('chrome://extensions');
    expect(html).toContain('Load unpacked');
    expect(html).toContain('Manage Your Content');
    expect(html).toContain('against Amazon');
    expect(html).toContain('Terms of Service');
    expect(html).toContain('experimental');
  });
});
