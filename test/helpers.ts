import crypto from 'node:crypto';
import type { Hono } from 'hono';
import { createApp, type AppOptions } from '../src/app.js';
import type { Config } from '../src/config.js';
import { migrate, openDatabase, type DB } from '../src/db/db.js';
import type { AppEnv } from '../src/auth/middleware.js';

export function md5(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

export interface TestServer {
  app: Hono<AppEnv>;
  db: DB;
}

export function makeTestApp(
  configOverrides: Partial<Config> = {},
  opts: AppOptions = {}
): TestServer {
  const db = openDatabase(':memory:');
  migrate(db);
  const config: Config = {
    basePath: '',
    registrationDisabled: false,
    authRateLimitPerMinute: 0, // disabled in tests (limiter state is per-app anyway)
    trustProxy: false,
    corsOrigins: '*',
    kindleServerRegistration: false,
    ...configOverrides,
  };
  return { app: createApp(db, config, opts), db };
}

let userCounter = 0;

/** Registers a fresh user and returns the auth headers the firmware sends. */
export async function registerUser(
  app: Hono<AppEnv>,
  password = 'correct horse battery staple'
): Promise<{ username: string; headers: Record<string, string> }> {
  const username = `user${++userCounter}-${Math.random().toString(36).slice(2, 8)}`;
  const key = md5(password);
  const res = await app.request('/users/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: key }),
  });
  if (res.status !== 201) throw new Error(`register failed: ${res.status}`);
  return {
    username,
    headers: {
      'x-auth-user': username,
      'x-auth-key': key,
      accept: 'application/vnd.koreader.v1+json',
      'content-type': 'application/json',
    },
  };
}

export const DOC = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

/** A BookOrbit `GET /reading-progress?fileId=71` response holding the given file progress. */
export function orbitProgressList(row: {
  percentage: number; updatedAt?: string | null; textUpdatedAt?: string | null;
  cfi?: string | null; koreaderProgress?: string | null;
}) {
  return { items: [{
    fileId: 71, percentage: row.percentage, updatedAt: row.updatedAt ?? null,
    text: { cfi: row.cfi ?? null, page: null, updatedAt: row.textUpdatedAt ?? null },
    narration: { seconds: null, fragment: null, sectionIndex: null, percentage: null, updatedAt: null },
    kobo: { source: null, type: null, value: null, contentPercent: null },
    koreader: row.koreaderProgress ?? null,
  }] };
}

/** The single write in a BookOrbit `PUT /reading-progress` request body. */
export function orbitWrite(body: string | undefined): Record<string, unknown> {
  return JSON.parse(body!).writes[0];
}
