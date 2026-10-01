// Run after npm run build and pio run -e simulator. Uses only loopback and fresh in-memory/SD fixtures.
import { createApp } from '../dist/app.js';
import { migrate, openDatabase } from '../dist/db/db.js';
import { serve } from '@hono/node-server';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const program = resolve(process.argv[2]);
const db = openDatabase(':memory:');
migrate(db);
const app = createApp(db, { registrationDisabled: false, authRateLimitPerMinute: 0, trustProxy: false, corsOrigins: '*' });
let oldServer = false;
const server = serve({ fetch: async (request, ...args) => {
  if (oldServer && request.method === 'PUT' && new URL(request.url).pathname === '/api/v1/stats/global') {
    const body = await request.json(); delete body.daily;
    const response = await app.fetch(new Request(request.url, { method: 'PUT', headers: request.headers, body: JSON.stringify(body) }), ...args);
    const reply = await response.json(); delete reply.accepted_daily;
    return new Response(JSON.stringify(reply), { status: response.status, headers: { 'content-type': 'application/json' } });
  }
  return app.fetch(request, ...args);
}, hostname: '127.0.0.1', port: 0 });
await new Promise(resolve => server.once('listening', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
try {
  for (const mode of ['shared', 'manual', 'old-server']) {
    const manual = mode === 'manual'; oldServer = mode === 'old-server';
    const user = `daily-${mode}-fixture`;
    const password = 'synthetic-local-only';
    const key = createHash('md5').update(password).digest('hex');
    const registered = await app.request('/users/create', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: user, password: key }) });
    assert.equal(registered.status, 201);
    const root = mkdtempSync(join(tmpdir(), 'daily-firmware-smoke-'));
    try {
      const env = { ...process.env, SDL_VIDEODRIVER: 'dummy', CROSSPOINT_SIM_SD: join(root, 'sd'),
        CROSSINK_SIMULATOR_SMOKE_TEST: '1', CROSSINK_STATS_TEST_SERVER: url, CROSSINK_STATS_TEST_USER: user,
        CROSSINK_STATS_TEST_PASSWORD: password, CROSSINK_STATS_TEST_DAILY: '1' };
      if (manual) env.CROSSINK_STATS_TEST_EMPTY_LIBRARY = '1';
      if (oldServer) env.CROSSINK_STATS_TEST_DAILY_NO_ACK = '1';
      const child = spawn(program, [], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b);
      const timeout = setTimeout(() => child.kill('SIGKILL'), 60000);
      const code = await new Promise(resolve => child.on('close', resolve)); clearTimeout(timeout);
      assert.equal(code, 0, output.slice(-8000));
      const headers = { 'x-auth-user': user, 'x-auth-key': key };
      const summary = await (await app.request('/api/v1/stats/summary', { headers })).json();
      if (oldServer) {
        assert.equal(summary.daily.length, 0);
        const day = readFileSync(join(root, 'sd/.crosspoint/daily_reading/09769.bin'));
        assert.equal(day.readUInt32LE(1), 61); assert.equal(day.readUInt32LE(5), 0);
        console.log('Old server: aggregate compatible, daily history stays pending without acknowledgment');
        continue;
      }
      assert.equal(summary.daily.length, 1);
      assert.equal(summary.daily[0].seconds, manual ? 61 : 70);
      const day = readFileSync(join(root, 'sd/.crosspoint/daily_reading/09769.bin'));
      assert.equal(day.readUInt32LE(1), manual ? 61 : 70);
      assert.equal(day.readUInt32LE(5), manual ? 61 : 70);
      console.log(`${manual ? 'Manual stats activity' : 'Shared sender retry/increment'}: daily seconds and durable acknowledgment verified`);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
} finally { await new Promise(resolve => server.close(resolve)); db.close(); }
