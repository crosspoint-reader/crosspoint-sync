// npm run build, then pass the matching CrossInk simulator executable as argv[2].
// All accounts, requests and SD files are disposable, loopback-only fixtures.
import { createApp } from '../dist/app.js';
import { migrate, openDatabase } from '../dist/db/db.js';
import { serve } from '@hono/node-server';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const program = resolve(process.argv[2]);
const db = openDatabase(':memory:');
migrate(db);
const app = createApp(db, { basePath: '', registrationDisabled: false, authRateLimitPerMinute: 0,
  trustProxy: false, corsOrigins: '*', kindleServerRegistration: false });
const today = Math.floor((Date.now() - Date.UTC(2000, 0, 1)) / 86400000);
let mode, downloads, userId;
const server = serve({ fetch: async (request) => {
  if (new URL(request.url).pathname === '/api/v1/stats/streak') {
    downloads++;
    if (mode === 'old-server') return new Response('', { status: 404 });
    if (downloads > 1) {
      if (mode === 'auth') return new Response('', { status: 401 });
      if (mode === 'server') return new Response('', { status: 500 });
      if (mode === 'html') return new Response('<html>proxy page</html>');
      if (mode === 'oversized') return new Response(' '.repeat(300));
      if (mode === 'bitmap') return Response.json({ v: 1, anchor_day: today, streak: 4, history_b64: '!'.repeat(123) + '=' });
      if (mode === 'ok') db.prepare('DELETE FROM progress_log WHERE user_id = ?').run(userId);
    }
  }
  return app.fetch(request);
}, hostname: '127.0.0.1', port: 0 });
await new Promise(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  for (mode of ['ok', 'empty', 'old-server', 'html', 'oversized', 'bitmap', 'auth', 'server']) {
    downloads = 0;
    const user = `streak-${mode}-fixture`, password = 'synthetic-loopback-only';
    const key = createHash('md5').update(password).digest('hex');
    const headers = { 'x-auth-user': user, 'x-auth-key': key, 'content-type': 'application/json' };
    assert.equal((await app.request('/users/create', { method: 'POST', headers,
      body: JSON.stringify({ username: user, password: key }) })).status, 201);
    userId = db.prepare('SELECT id FROM users WHERE username = ?').get(user).id;
    const history = Buffer.alloc(92); history[0] = 10; // yesterday and three days ago
    assert.equal((await app.request('/api/v1/stats/global', { method: 'PUT', headers,
      body: JSON.stringify({ device_id: 'other-reader', v: 5, sessions: 2, seconds: 120, pages: 0, completed: 0,
        tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0], anchor_day: today, history_b64: history.toString('base64'), streak: 1 }),
    })).status, 200);
    db.prepare('INSERT INTO progress_log (user_id, document, percentage, at, device_id) VALUES (?, ?, ?, ?, ?)')
      .run(userId, 'a'.repeat(32), .1, Date.UTC(2000, 0, 1) / 1000 + (today - 2) * 86400 + 43200, 'third-reader');
    const root = mkdtempSync(join(tmpdir(), 'streak-firmware-smoke-'));
    try {
      const child = spawn(program, [], { cwd: root, env: { ...process.env, SDL_VIDEODRIVER: 'dummy',
        CROSSPOINT_SIM_SD: join(root, 'sd'), CROSSINK_SIMULATOR_SMOKE_TEST: '1',
        CROSSINK_STATS_TEST_SERVER: url, CROSSINK_STATS_TEST_USER: user, CROSSINK_STATS_TEST_PASSWORD: password,
        CROSSINK_STATS_TEST_STREAK: mode, CROSSINK_STATS_TEST_STREAK_DAY: String(today),
      }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
      const timeout = setTimeout(() => child.kill('SIGKILL'), 60000);
      const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
      clearTimeout(timeout);
      assert.equal(code, 0, `${mode}: ${output.slice(-8000)}`);
      assert.equal(downloads, mode === 'old-server' || mode === 'empty' ? 1 : 2);
      const globals = await (await app.request('/api/v1/stats/global', { headers })).json();
      const own = globals.devices.find(d => d.device_id !== 'other-reader');
      if (mode === 'empty') assert.equal(own, undefined);
      else {
        assert.equal(own.stats.seconds, 60); assert.equal(own.stats.sessions, 1);
        assert.equal(Buffer.from(own.stats.history_b64, 'base64')[0], 1);
      }
      // Persistence survived the child process, with a CRC-protected separate calendar.
      const cache = readdirSync(join(root, 'sd/.crosspoint')).filter(p => /^server_streak_.*\.bin$/.test(p));
      assert.equal(cache.length, mode === 'old-server' ? 0 : 1);
      if (cache.length) assert.equal(readFileSync(join(root, 'sd/.crosspoint', cache[0])).length, 103);
      console.log(`${mode}: streak round trip, persistence and device-only upload verified`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
} finally { await new Promise(resolve => server.close(resolve)); db.close(); }
