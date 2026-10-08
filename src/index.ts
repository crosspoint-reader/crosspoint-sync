import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { fromEnv } from './config.js';
import { migrate, openDatabase } from './db/db.js';
import { secretsEnabled } from './crypto/secrets.js';
import { loadSessionSecret } from './auth/session.js';
import { startQueueWorker } from './connectors/runner.js';
import { pollSpotify, startFanInWorker } from './connectors/fanin.js';
import { autoPause } from './models/pause.js';

const DATABASE_PATH = process.env.DATABASE_PATH ?? '/data/crosspoint.db';
const PORT = Number(process.env.PORT ?? 8080);
const ADDRESS = process.env.LISTEN_ADDRESS ?? 'localhost';

const db = openDatabase(DATABASE_PATH);
migrate(db);
loadSessionSecret(db);

const app = createApp(db, fromEnv());

// Connector fan-out queue worker (only meaningful when encryption - hence
// connectors - is configured).
const connectorsEnabled = secretsEnabled();
if (connectorsEnabled) {
  startQueueWorker(db);
  // Fan-in: pull position changes back from bidirectional connectors (e.g.
  // Audiobookshelf audiobook -> ebook).
  startFanInWorker(db, Number(process.env.FANIN_INTERVAL_MS ?? 5 * 60_000));
  startFanInWorker(db, 60 * 60_000, pollSpotify);
}
// Daily: pause books with no progress for 30 days (reads also check lazily).
startFanInWorker(db, 24 * 60 * 60_000, async (d) => autoPause(d));

serve({ fetch: app.fetch, port: PORT, hostname: ADDRESS }, (info) => {
  console.log(
    JSON.stringify({
      msg: 'crosspoint-sync listening',
      port: info.port,
      address: info.address,
      db: DATABASE_PATH,
      connectors: connectorsEnabled ? 'enabled' : 'disabled (no TOKEN_ENC_KEY)',
    })
  );
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    db.close();
    process.exit(0);
  });
}
