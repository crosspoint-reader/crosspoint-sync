// Actual firmware snapshots -> local server; no real accounts or devices.
// node --import tsx test/stats-counter-firmware-smoke.mjs /path/to/simulator/program
import assert from 'node:assert/strict';
import { serve } from '@hono/node-server';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { makeTestApp, registerUser } from './helpers.ts';

const program = resolve(process.argv[2]);
const { app, db } = makeTestApp();
const password = 'isolated-stats-test';
const { username, headers } = await registerUser(app, password);
const root = mkdtempSync(join(tmpdir(), 'stats-counter-firmware-'));
let oldServer = false, legacyWrites = 0;
const server = serve({ hostname: '127.0.0.1', port: 0, fetch: (request, ...args) => {
  const path = new URL(request.url).pathname;
  if (oldServer && path.startsWith('/api/v1/stats/counters/')) return new Response('{}', { status: 404 });
  if (oldServer && request.method === 'PUT' && ['/api/v1/stats/global', '/api/v1/stats/books'].includes(path)) legacyWrites++;
  return app.fetch(request, ...args);
} });
await new Promise(resolve => server.once('listening', resolve));
const summary = async () => (await app.request('/api/v1/stats/summary', { headers })).json();
async function run(mode, sd) {
  const child = spawn(program, [], { cwd: root, env: { ...process.env, SDL_VIDEODRIVER: 'dummy',
    CROSSPOINT_SIM_SD: sd, CROSSINK_SIMULATOR_SMOKE_TEST: '1',
    ...(mode === 'reader-reset' ? { CROSSINK_STATS_TEST_READER_RESET: '1' } : { CROSSINK_STATS_TEST_RESET: mode }),
    CROSSINK_STATS_TEST_SERVER: `http://127.0.0.1:${server.address().port}`,
    CROSSINK_STATS_TEST_USER: username, CROSSINK_STATS_TEST_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output = (output + data).slice(-16000); });
  child.stderr.on('data', data => { output = (output + data).slice(-16000); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 60000);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  clearTimeout(timeout);
  assert.equal(code, 0, output);
}
try {
  await run('reader-reset', join(root, 'reader-reset-sd'));
  const sd = join(root, 'sd');
  await run('seed', sd);
  cpSync(sd, join(root, 'backup'), { recursive: true });
  assert.equal((await summary()).seconds, 3600);
  await run('reset', sd);
  assert.equal((await summary()).seconds, 3660);
  assert.equal((await summary()).daily[0].seconds, 660);
  await run('fresh', join(root, 'fresh-sd'));
  assert.equal((await summary()).seconds, 3720);
  assert.equal((await summary()).daily[0].seconds, 720);
  await run('restore', join(root, 'backup'));
  assert.equal((await summary()).seconds, 3720);
  const book = await (await app.request('/api/v1/stats/books/0123456789abcdef0123456789abcdef', { headers })).json();
  assert.equal(book.combined.seconds, 3720);
  assert.equal(book.devices.length, 1);
  oldServer = true;
  await run('old-server', join(root, 'old-server-sd'));
  assert.equal(legacyWrites, 0, 'never fall back to destructive old write endpoints');
  assert.equal((await summary()).seconds, 3720);
  console.log('PASS: real firmware migration, resets, fresh SD, same-day addition, retries, restored backup and old-server protection');
} finally {
  await new Promise(resolve => server.close(resolve));
  db.close();
  rmSync(root, { recursive: true, force: true });
}
