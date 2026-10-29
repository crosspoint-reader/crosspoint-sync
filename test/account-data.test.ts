import { describe, expect, it } from 'vitest';
import { ACCOUNT_TABLES } from '../src/models/account-data.js';
import { DOC, makeTestApp, registerUser } from './helpers.js';

async function fixture() {
  const server = makeTestApp();
  const user = await registerUser(server.app);
  const id = server.db.prepare('SELECT id FROM users WHERE username = ?').get(user.username)!.id as number;
  return { ...server, ...user, id };
}
async function seed(s: Awaited<ReturnType<typeof fixture>>) {
  await s.app.request('/syncs/progress', { method: 'PUT', headers: s.headers, body: JSON.stringify({ document: DOC, device_id: 'reader', progress: '/body/p[2]', percentage: 0.4, metadata: { title: '日本語', authors: 'Author', filename: 'book.epub' } }) });
  s.db.prepare('INSERT INTO bookmarks (user_id, document, id, updated_at) VALUES (?, ?, ?, 12)').run(s.id, DOC, 'bookmark');
  s.db.prepare('INSERT INTO clippings (user_id, document, id, text, updated_at) VALUES (?, ?, ?, ?, 12)').run(s.id, DOC, 'clip', 'A highlight');
  s.db.prepare('INSERT INTO stats_device_day VALUES (?, ?, ?, ?, ?)').run(s.id, 'reader', '2026-10-01', 123, 12);
  s.db.prepare('INSERT INTO stats_device_book_day VALUES (?, ?, ?, ?, ?, ?)').run(s.id, 'reader', DOC, '2026-10-01', 123, 12);
  s.db.prepare('INSERT INTO stats_device_global VALUES (?, ?, ?, ?, ?)').run(s.id, 'reader', 'Reader', '{"total_reading_time":123}', 12);
  s.db.prepare('INSERT INTO stats_device_book VALUES (?, ?, ?, ?, ?)').run(s.id, 'reader', DOC, '{"reading_time":123}', 12);
  s.db.prepare('INSERT INTO reading_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(s.id, 'reader', 'session', DOC, 10, 20, 10, 0, 20);
  s.db.prepare('INSERT INTO document_aliases VALUES (?, ?, ?, ?, ?)').run(s.id, 'opaque-id', DOC, 12, 1);
  s.db.prepare('UPDATE users SET auto_pause_days = 7, profile_slug = ? WHERE id = ?').run('source-profile', s.id);
}
const archiveOf = async (s: Awaited<ReturnType<typeof fixture>>) => (await s.app.request('/api/v1/account/export', { headers: s.headers })).json();
const restore = (s: Awaited<ReturnType<typeof fixture>>, archive: unknown, mode = 'empty') => s.app.request('/api/v1/account/import', { method: 'POST', headers: s.headers, body: JSON.stringify({ archive, mode }) });

describe('account migration', () => {
  it('round trips all portable tables between instances and assigns destination identity/cursors', async () => {
    const source = await fixture();
    await seed(source);
    const archive = await archiveOf(source);
    const target = await fixture();
    // Advance destination clocks beyond anything in the source.
    target.db.exec('UPDATE change_seq SET value = 900; UPDATE clipping_sync_clock SET revision = 900');
    expect((await restore(target, archive)).status).toBe(200);
    const exported = await archiveOf(target);
    expect(exported.data).toEqual(archive.data);
    expect(exported.profile.auto_pause_days).toBe(7);
    expect(exported.profile.username).toBe(target.username);
    expect(target.db.prepare('SELECT profile_slug FROM users').get()!.profile_slug).not.toBe('source-profile');
    expect(target.db.prepare('SELECT change_seq, server_change_seq FROM progress').get()).toEqual({ change_seq: 901, server_change_seq: 901 });
    expect(target.db.prepare('SELECT revision FROM clippings').get()!.revision).toBe(901);
    expect((await target.app.request('/users/auth', { headers: target.headers })).status).toBe(200);
    for (const table of ACCOUNT_TABLES) expect(archive.data[table].length).toBeGreaterThan(0);
  });

  it('requires explicit replacement, is repeatable, and never touches another account', async () => {
    const s = await fixture();
    await seed(s);
    const archive = await archiveOf(s);
    const other = await registerUser(s.app);
    expect((await restore(s, archive)).status).toBe(409);
    expect((await restore(s, archive, 'replace')).status).toBe(200);
    expect((await restore(s, archive, 'replace')).status).toBe(200);
    expect((await archiveOf(s)).data).toEqual(archive.data);
    const empty = await (await s.app.request('/api/v1/account/export', { headers: other.headers })).json();
    expect(empty.data.documents).toEqual([]);
    expect(JSON.stringify(archive)).not.toMatch(/key_hash|account_id|user_id|profile_slug|credential/);
    expect((await s.app.request('/api/v1/account/export')).status).toBe(401);
    expect((await s.app.request('/api/v1/account/import', { method: 'POST' })).status).toBe(401);
  });

  it.each(['version', 'owner', 'duplicate', 'cycle', 'type', 'missing', 'json'])('rejects %s errors without losing existing data', async (bad) => {
    const s = await fixture();
    await seed(s);
    const original = await archiveOf(s);
    const clock = s.db.prepare('SELECT value FROM change_seq').get();
    const archive = structuredClone(original);
    if (bad === 'version') archive.version = 99;
    if (bad === 'owner') archive.data.documents[0].user_id = 999;
    if (bad === 'duplicate') archive.data.clippings.push(archive.data.clippings[0]);
    if (bad === 'cycle') archive.data.document_aliases[0].document = 'opaque-id';
    if (bad === 'type') archive.data.progress[0].percentage = '0.4';
    if (bad === 'missing') delete archive.data.clippings;
    if (bad === 'json') archive.data.stats_device_global[0].payload = 'bad json';
    expect((await restore(s, archive, 'replace')).status).toBe(400);
    expect((await archiveOf(s)).data).toEqual(original.data);
    expect(s.db.prepare('SELECT value FROM change_seq').get()).toEqual(clock);
  });
});
