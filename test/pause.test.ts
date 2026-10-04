import { afterEach, describe, expect, it, vi } from 'vitest';
import { DOC, makeTestApp, registerUser } from './helpers.js';
import { upsertProgress } from '../src/routes/kosync.js';
import { autoPause } from '../src/models/pause.js';

const T0 = Date.parse('2026-09-01T12:00:00Z');
const DAY = 86_400_000;
const at = (ms: number) => vi.setSystemTime(T0 + ms);

async function reader() {
  vi.useFakeTimers({ toFake: ['Date'] });
  at(0);
  const { app, db } = makeTestApp();
  const { headers } = await registerUser(app);
  const push = (percentage: number, document = DOC) => app.request('/syncs/progress', {
    method: 'PUT', headers, body: JSON.stringify({ document, progress: `/body/DocFragment[${Math.round(percentage * 100)}]`, percentage, device: 'r', device_id: 'reader' }),
  });
  const book = async (document = DOC) => {
    const items = (await (await app.request('/api/v1/progress', { headers })).json()).items as any[];
    const b = items.find((i) => i.document === document);
    return { status: b.status, pause_reason: b.pause_reason };
  };
  const setStatus = (status: string | null) => app.request(`/api/v1/documents/${DOC}/status`, {
    method: 'PUT', headers, body: JSON.stringify({ status }),
  });
  return { app, db, headers, push, book, setStatus };
}

afterEach(() => vi.useRealTimers());

describe('auto-pause', () => {
  it('pauses after 30 full days without progress, not before', async () => {
    const { push, book } = await reader();
    await push(0.4);
    at(30 * DAY - 1000);
    expect(await book()).toEqual({ status: 'reading', pause_reason: null });
    at(30 * DAY);
    expect(await book()).toEqual({ status: 'reading', pause_reason: null });
    at(30 * DAY + 1000);
    expect(await book()).toEqual({ status: 'paused', pause_reason: 'auto' });
  });

  it('a re-push of the same spot is not progress', async () => {
    const { push, book } = await reader();
    await push(0.4);
    at(20 * DAY);
    await push(0.4);
    at(30 * DAY + 1000);
    expect((await book()).status).toBe('paused');
  });

  it('leaves finished, did-not-finish and manually paused books alone', async () => {
    const { push, book } = await reader();
    await push(0.99);
    at(31 * DAY);
    expect((await book()).status).toBe('finished');

    const r2 = await reader();
    await r2.push(0.4);
    await r2.setStatus('dnf');
    at(31 * DAY);
    expect((await r2.book()).status).toBe('dnf');

    const r3 = await reader();
    await r3.push(0.4);
    await r3.setStatus('paused');
    at(31 * DAY);
    expect(await r3.book()).toEqual({ status: 'paused', pause_reason: 'manual' });
  });

  it('also pauses a book manually marked reading', async () => {
    const { push, book, setStatus } = await reader();
    await push(0.4);
    await setStatus('reading');
    at(31 * DAY);
    expect(await book()).toEqual({ status: 'paused', pause_reason: 'auto' });
  });

  it('checks lazily on the device progress GET', async () => {
    const { app, db, headers, push } = await reader();
    await push(0.4);
    at(31 * DAY);
    await app.request(`/syncs/progress/${DOC}`, { headers });
    expect(db.prepare('SELECT status, pause_reason FROM documents WHERE document = ?').get(DOC)).toEqual({ status: 'paused', pause_reason: 'auto' });
  });

  it('the daily sweep covers every user', async () => {
    const a = await reader();
    await a.push(0.4);
    const { headers } = await registerUser(a.app);
    await a.app.request('/syncs/progress', {
      method: 'PUT', headers, body: JSON.stringify({ document: DOC, progress: '/x', percentage: 0.2, device: 'r', device_id: 'r2' }),
    });
    at(31 * DAY);
    expect(autoPause(a.db)).toBe(2);
    expect(autoPause(a.db)).toBe(0);
  });
});

describe('auto-unpause', () => {
  it('new progress unpauses an auto-paused book', async () => {
    const { push, book } = await reader();
    await push(0.4);
    at(31 * DAY);
    expect((await book()).status).toBe('paused');
    await push(0.45);
    expect(await book()).toEqual({ status: 'reading', pause_reason: null });
  });

  it('new progress unpauses a manually paused book too', async () => {
    const { push, book, setStatus } = await reader();
    await push(0.4);
    await setStatus('paused');
    expect((await book()).pause_reason).toBe('manual');
    at(DAY);
    await push(0.45);
    expect(await book()).toEqual({ status: 'reading', pause_reason: null });
  });

  it('counts connector progress, but not a stale position dated before the pause', async () => {
    const { db, push, book } = await reader();
    await push(0.4);
    at(31 * DAY);
    expect((await book()).status).toBe('paused');
    const now = Math.floor((T0 + 31 * DAY) / 1000);
    const spotify = (percentage: number, updatedAt: number) => upsertProgress(db, {
      userId: 1, document: DOC, deviceId: 'spotify', device: 'Spotify', percentage,
      progress: `spotify:${percentage}`, position: null, metadata: null, updatedAt,
    });
    spotify(0.42, now - 5 * DAY);
    expect((await book()).status).toBe('paused');
    spotify(0.5, now + 60);
    expect((await book()).status).toBe('reading');
  });

  it('a re-push of the same spot does not unpause', async () => {
    const { push, book } = await reader();
    await push(0.4);
    at(31 * DAY);
    expect((await book()).status).toBe('paused');
    await push(0.4);
    expect((await book()).status).toBe('paused');
  });
});

describe('auto-finish', () => {
  it('a book marked Reading finishes when a sync reaches the end', async () => {
    const { push, book, setStatus } = await reader();
    await push(0.5);
    at(1000);
    await setStatus('reading');
    at(2000);
    await push(0.9);
    expect((await book()).status).toBe('reading');
    at(3000);
    await push(1);
    expect((await book()).status).toBe('finished');
  });

  it('leaves paused and did-not-finish books alone, and a re-read is not flipped back by the old 100%', async () => {
    const r = await reader();
    await r.push(0.5);
    at(1000);
    await r.setStatus('dnf');
    at(2000);
    await r.push(1);
    expect((await r.book()).status).toBe('dnf');

    const re = await reader();
    await re.push(1);
    at(1000);
    await re.setStatus('reading'); // starting it again
    at(2000);
    await re.push(1); // the device re-sends its last position
    expect((await re.book()).status).toBe('reading');
  });
});
