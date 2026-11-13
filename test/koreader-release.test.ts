import { afterEach, expect, it } from 'vitest';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function run(mode = '', args = ['koreader-v0.1.0']) {
  const dir = mkdtempSync(join(tmpdir(), 'crosspoint-release-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'scripts'));
  mkdirSync(join(dir, 'bin'));
  copyFileSync('scripts/release-koreader.sh', join(dir, 'scripts/release-koreader.sh'));
  const fake = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const mode = process.env.RELEASE_TEST_MODE;
const log = { command, args };
if (command === 'gh' && args[0] === 'release') log.notes = fs.readFileSync(args[args.indexOf('--notes-file') + 1], 'utf8');
fs.appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify(log) + '\\n');
if (command === 'git') {
  if (args[0] === 'status' && mode === 'dirty') console.log(' M file');
  if (args[0] === 'show-ref') process.exit(mode === 'local-tag' ? 0 : 1);
  if (args[0] === 'rev-parse') console.log('a'.repeat(40));
  if (args[0] === 'ls-remote' && mode === 'remote-tag') console.log('a'.repeat(40) + ' refs/tags/koreader-v0.1.0');
}
if (command === 'gh') {
  if (args[0] === 'repo') console.log('owner/crosspoint-sync');
  if (args[0] === 'api' && mode === 'unpushed') process.exit(1);
}
if (command === 'npm') {
  if ((mode === 'test-failed' && args[1] === 'test:koreader') || (mode === 'build-failed' && args[1] === 'build:koreader')) process.exit(1);
  if (args[1] === 'build:koreader') { fs.mkdirSync('dist'); fs.writeFileSync('dist/crosspoint-koreader.zip', 'test fixture'); }
}
`;
  for (const name of ['git', 'npm', 'gh']) writeFileSync(join(dir, 'bin', name), fake, { mode: 0o755 });
  const log = join(dir, 'calls.jsonl');
  const result = spawnSync('bash', [join(dir, 'scripts/release-koreader.sh'), ...args], {
    encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      RELEASE_TEST_MODE: mode, RELEASE_TEST_LOG: log },
  });
  let calls: { command: string; args: string[]; notes?: string }[] = [];
  try { calls = readFileSync(log, 'utf8').trim().split('\n').map(s => JSON.parse(s)); } catch { /* no commands for bad arguments */ }
  return { result, calls };
}

it('tests and packages before creating the exact tagged release with its ZIP and instructions', () => {
  const { result, calls } = run();
  expect(result.status, result.stderr).toBe(0);
  expect(calls.filter(c => c.command === 'npm').map(c => c.args)).toEqual([['run', 'test:koreader'], ['run', 'build:koreader']]);
  const release = calls.at(-1)!;
  expect(release.command).toBe('gh');
  expect(release.args.slice(0, 4)).toEqual(['release', 'create', 'koreader-v0.1.0', 'dist/crosspoint-koreader.zip']);
  expect(release.args).toContain('--latest=false');
  expect(release.args[release.args.indexOf('--target') + 1]).toBe('a'.repeat(40));
  expect(release.args[release.args.indexOf('--repo') + 1]).toBe('owner/crosspoint-sync');
  expect(release.notes).toContain('owner/crosspoint-sync/blob/koreader-v0.1.0/koreader/crosspoint.koplugin/README.md');
});

it.each(['dirty', 'local-tag', 'remote-tag', 'unpushed', 'test-failed', 'build-failed'])('never publishes when %s', mode => {
  const { result, calls } = run(mode);
  expect(result.status).not.toBe(0);
  expect(calls.some(c => c.command === 'gh' && c.args[0] === 'release')).toBe(false);
});

it.each([{ args: [] }, { args: ['v0.1.0'] }, { args: ['koreader-v0.1.0', 'extra'] }])('rejects invalid tag arguments $args', ({ args }) => {
  const { result, calls } = run('', args);
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('Usage:');
  expect(calls).toEqual([]);
});
