import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { DB } from './db/db.js';
import type { Config } from './config.js';
import { sessionOrKeyAuth, type AppEnv } from './auth/middleware.js';
import { kosyncRoutes } from './routes/kosync.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/account.js';
import { webRoutes } from './routes/web.js';
import { progressRoutes } from './routes/v1/progress.js';
import { bookmarkRoutes } from './routes/v1/bookmarks.js';
import { clippingRoutes } from './routes/v1/clippings.js';
import { statsRoutes } from './routes/v1/stats.js';
import { documentRoutes } from './routes/v1/documents.js';
import { connectorRoutes } from './routes/v1/connectors.js';
import { kindleRegisterRoutes } from './routes/v1/kindle-register.js';
import { createProgressRefresh } from './connectors/refresh.js';
import type { HttpTransport } from './connectors/types.js';

// Injected at build time via package.json; read lazily to keep this file dependency-free.
export const VERSION = process.env.npm_package_version ?? '0.1.0';

export interface AppOptions {
  /** Override the connector HTTP transport (tests inject a fake). */
  connectorTransport?: HttpTransport;
}

export function createApp(db: DB, config: Config, opts: AppOptions = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const refreshProgress = createProgressRefresh(db, opts.connectorTransport);

  // CORS for browser-based kosync clients (PWAs, WebView readers). Applied only
  // to the header-authenticated API surfaces - never to the cookie-based web UI
  // routes (/auth, /account) - so a wildcard origin stays safe: without
  // Access-Control-Allow-Credentials, browsers never attach session cookies.
  const apiCors = cors({
    origin: config.corsOrigins === '*' ? '*' : config.corsOrigins,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Accept', 'x-auth-user', 'x-auth-key'],
    maxAge: 86400,
  });
  app.use('/users/*', apiCors);
  app.use('/syncs/*', apiCors);
  app.use('/api/v1/*', apiCors);
  app.use('/healthz', apiCors);

  app.get('/healthz', (c) => c.json({ status: 'ok', version: VERSION }));

  // Web UI (landing / account pages).
  app.route('/', webRoutes());

  // kosync-compatible API at the root - stock KOReader and current CrossPoint
  // firmware work by changing only the server URL.
  app.route('/', kosyncRoutes(db, config, refreshProgress));

  // Web account session auth (browser signup/login) + kosync link management.
  app.route('/auth', authRoutes(db, config));
  app.route('/account', accountRoutes(db, config));

  // Extended CrossPoint API; accepts either the web session cookie or the
  // device x-auth headers.
  const v1 = new Hono<AppEnv>();
  v1.use('*', sessionOrKeyAuth(db));
  v1.route('/', progressRoutes(db, refreshProgress));
  v1.route('/', bookmarkRoutes(db));
  v1.route('/', clippingRoutes(db));
  v1.route('/', statsRoutes(db));
  v1.route('/', documentRoutes(db));
  v1.route('/', connectorRoutes(db, opts.connectorTransport, config.trustProxy));
  // Self-host-only Amazon device registration (off unless explicitly enabled).
  if (config.kindleServerRegistration) {
    v1.route('/', kindleRegisterRoutes(db, opts.connectorTransport, config.trustProxy));
  }
  app.route('/api/v1', v1);

  return app;
}
