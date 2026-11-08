import { afterEach, beforeEach, expect, it } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { audiobookshelfConnector } from '../src/connectors/audiobookshelf.js';
import { pollConnector } from '../src/connectors/fanin.js';
import { latestPercentage, saveMatch, upsertAccount } from '../src/connectors/store.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { upsertProgress } from '../src/routes/kosync.js';
import type { HttpTransport } from '../src/connectors/types.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY = 'c'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });

// Chapters 1000s, 2000s, 1000s (4000s). The listener is 500s into the last one.
const ITEM = {
  media: { duration: 4000, chapters: [{ start: 0, end: 1000, title: 'One' }, { start: 1000, end: 3000, title: 'Two' }, { start: 3000, end: 4000, title: 'Three' }] },
};

it('calibrates an Audiobookshelf book: pulls and pushes map through the anchor', async () => {
  const progress = { duration: 4000, currentTime: 3500, progress: 0.875, isFinished: false, lastUpdate: Date.now() };
  const patches: any[] = [];
  const http: HttpTransport = async (url, init) => {
    const ok = (body: unknown) => ({ status: 200, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes('/api/items/li_1/ebook')) return { status: 404, json: async () => null, text: async () => '' };
    if (url.includes('/api/items/li_1')) return ok(ITEM);
    if (url.includes('/api/me/progress/li_1')) {
      if (init.method === 'PATCH') patches.push(JSON.parse(init.body!));
      return ok(init.method === 'GET' ? progress : {});
    }
    throw new Error(`Unexpected request: ${init.method} ${url}`);
  };
  const { app, db } = makeTestApp({}, { connectorTransport: http });
  const { username, headers } = await registerUser(app);
  const { id } = db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number };
  upsertAccount(db, id, 'audiobookshelf', { server: 'abs.test', token: 'k' }, null);
  saveMatch(db, id, 'audiobookshelf', DOC, { externalId: 'li_1', externalEdition: '4000', confidence: 1 }, 'manual');
  upsertProgress(db, { userId: id, document: DOC, deviceId: 'r', device: 'r', percentage: 0.75,
    progress: '/body/DocFragment[9]/body', position: null, metadata: null, updatedAt: Math.floor(Date.now() / 1000) - 60 });

  const tracks = await (await app.request(`/api/v1/connectors/audiobookshelf/tracks/${DOC}`, { headers })).json();
  expect(tracks).toMatchObject({ matched: true, total_ms: 4_000_000, position_ms: 3_500_000, reader_pct: 0.75, anchor: null });
  expect(tracks.tracks[2]).toEqual({ index: 2, name: 'Three', start_ms: 3_000_000, duration_ms: 1_000_000 });

  // "My reader's 75% is chapter Three, 500s in" = 87.5% of the audio.
  const saved = await app.request(`/api/v1/connectors/audiobookshelf/anchor/${DOC}`, {
    method: 'PUT', headers, body: JSON.stringify({ track: 2, position_ms: 500_000 }),
  });
  expect(await saved.json()).toEqual({ anchor: { text: 0.75, audio: 0.875 } });

  // Listening at 87.5% now reads back as the reader's 75%, not 87.5%.
  progress.currentTime = 3600;
  progress.progress = 0.9;
  progress.lastUpdate = Date.now();
  await pollConnector(db, id, 'audiobookshelf', http, { document: DOC });
  expect(latestPercentage(db, id, DOC)).toBeCloseTo(0.75 + (0.9 - 0.875) * (0.25 / 0.125), 6);

  // And reading 75% pushes the anchored listening spot; ebookProgress stays the reading %.
  await audiobookshelfConnector.push({ server: 'abs.test', token: 'k' }, { externalId: 'li_1', externalEdition: '4000', confidence: 1 },
    { kind: 'progress', percentage: 0.75, timestamp: 0 } as any, http, { db, userId: id, document: DOC });
  expect(patches.at(-1)).toMatchObject({ progress: 0.875, currentTime: 3500, ebookProgress: 0.75 });

  await app.request(`/api/v1/connectors/audiobookshelf/anchor/${DOC}`, { method: 'DELETE', headers });
  expect((await (await app.request(`/api/v1/connectors/audiobookshelf/tracks/${DOC}`, { headers })).json()).anchor).toBeNull();
});
