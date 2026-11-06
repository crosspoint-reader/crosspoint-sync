import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeTestApp, registerUser, DOC } from './helpers.js';
import { parseSleepOptions, sleepMetrics, timezoneOffset } from '../src/models/sleep-image.js';
import { PNG } from 'pngjs';

afterEach(() => vi.useRealTimers());

describe('sleep image data', () => {
  it('uses the account goal and canonical completion dates without writing progress', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-01-01T02:00:00Z'));
    const s = makeTestApp();
    try {
      const u = await registerUser(s.app);
      const id = Number(s.db.prepare('SELECT id FROM users WHERE username=?').get(u.username)!.id);
      s.db.prepare('INSERT INTO progress_log (user_id,document,device_id,percentage,at) VALUES (?,?,?,1,?)')
        .run(id, DOC, 'reader', Date.parse('2027-01-01T01:00:00Z') / 1000);
      const before = s.db.prepare('SELECT COUNT(*) AS n FROM progress_log').get()!.n;
      expect(sleepMetrics(s.db, id, 'America/New_York', '42')).toMatchObject({ year: 2026, finished: 1, target: null, currentPercent: 42, streak: 1 });
      s.db.prepare('INSERT INTO reading_goals (user_id,year,target) VALUES (?,?,?)').run(id, 2026, 1);
      expect(sleepMetrics(s.db, id, 'America/New_York', '100')).toMatchObject({ year: 2026, finished: 1, target: 1, currentPercent: 100 });
      expect(sleepMetrics(s.db, id, 'UTC', undefined)).toMatchObject({ year: 2027, finished: 1, target: null, currentPercent: null });
      expect(s.db.prepare('SELECT COUNT(*) AS n FROM progress_log').get()!.n).toBe(before);
    } finally { s.db.close(); }
  });

  it.each([undefined, '', '{event.percent}', '-1', '101', 'NaN', 'Infinity', '4x'])('omits unavailable percentage %s', async value => {
    const s = makeTestApp();
    try {
      const u = await registerUser(s.app);
      const id = Number(s.db.prepare('SELECT id FROM users WHERE username=?').get(u.username)!.id);
      expect(sleepMetrics(s.db, id, 'UTC', value).currentPercent).toBeNull();
    } finally { s.db.close(); }
  });

  it('uses seasonal timezone offsets and rejects invalid zones', () => {
    expect(timezoneOffset('America/New_York', new Date('2026-07-01T12:00Z'))).toBe(240);
    expect(timezoneOffset('America/New_York', new Date('2026-12-01T12:00Z'))).toBe(300);
    expect(() => timezoneOffset('Imaginary/Place')).toThrow(/timezone/i);
  });

  it('bounds output and accepts all supported metric selections', () => {
    expect(parseSleepOptions({ width: '1200', height: '1600', mode: 'custom', metrics: 'books,goal,current,streak', placement: 'top', timezone: 'UTC' }))
      .toMatchObject({ width: 1200, height: 1600, mode: 'custom', placement: 'top' });
    for (const query of [{ width: '239' }, { width: '1601' }, { width: '1600', height: '1600' }, { height: 'NaN' }, { mode: 'cover' }, { metrics: 'secrets' }, { placement: 'middle' }, { timezone: 'bad' }]) {
      expect(() => parseSleepOptions(query)).toThrow();
    }
    expect(() => parseSleepOptions({ metrics: '' })).toThrow();
  });
});

describe('authenticated sleep image API', () => {
  it('renders account images, supports prefixed installs, and keeps backgrounds private', async () => {
    const s = makeTestApp({ basePath: '/sync' });
    try {
      const user = async (name: string) => {
        const key = 'a'.repeat(32);
        expect((await s.app.request('/sync/users/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: name, password: key }) })).status).toBe(201);
        return { 'x-auth-user': name, 'x-auth-key': key };
      };
      const first = await user('sleep-first'), second = await user('sleep-second');
      const base = '/sync/api/v1/stats/sleep-image';
      expect((await s.app.request(base)).status).toBe(401);
      expect((await s.app.request(base, { headers: { ...first, 'x-auth-key': 'b'.repeat(32) } })).status).toBe(401);
      const status = async (headers: Record<string,string>) => (await s.app.request(base + '/status', { headers })).json();
      expect(await status(first)).toMatchObject({ version: 1, background: false });
      const image = await s.app.request(base + '?mode=overlay&timezone=America%2FNew_York', { headers: { ...first, 'X-Sleep-Percent': '56' } });
      expect(image.status).toBe(200);
      expect(image.headers.get('content-type')).toBe('image/png');
      expect(image.headers.get('cache-control')).toBe('private, no-store');
      expect(PNG.sync.read(Buffer.from(await image.arrayBuffer())).width).toBe(480);
      const bytes = PNG.sync.write(new PNG({ width: 240, height: 240 }));
      const put = (body: Buffer) => s.app.request(base + '/background', { method: 'PUT', headers: { ...first, 'Content-Type': 'image/png' }, body: new Uint8Array(body) });
      expect((await put(bytes)).status).toBe(200);
      expect(await status(first)).toMatchObject({ background: true });
      expect(await status(second)).toMatchObject({ background: false });
      expect((await s.app.request(base + '/background', { headers: second })).status).toBe(404);
      expect((await put(Buffer.from('bad'))).status).toBe(400);
      const saved = await s.app.request(base + '/background', { headers: first });
      expect(PNG.sync.read(Buffer.from(await saved.arrayBuffer())).width).toBe(240);
      expect((await put(Buffer.alloc(8 * 1024 * 1024 + 1))).status).toBe(413);
      expect((await s.app.request(base + '?width=9999', { headers: first })).status).toBe(400);
      const bmp = await s.app.request(base + '?mode=custom', { headers: first });
      expect(bmp.headers.get('content-type')).toBe('image/bmp');
      expect(Buffer.from(await bmp.arrayBuffer()).toString('ascii', 0, 2)).toBe('BM');
      expect((await s.app.request(base + '/background', { method: 'DELETE', headers: first })).status).toBe(200);
      expect(await status(first)).toMatchObject({ background: false });
      await put(bytes);
      expect((await s.app.request('/sync/api/v1/account/data', { method: 'DELETE', headers: first })).status).toBe(200);
      expect(await status(first)).toMatchObject({ background: false });
    } finally { s.db.close(); }
  });
});
