import { afterEach, beforeEach, expect, it } from 'vitest';
import { makeTestApp, registerUser, DOC } from './helpers.js';
import { resetEncryptionKeyCache } from '../src/crypto/secrets.js';
import { upsertAccount, saveMatch } from '../src/connectors/store.js';
import { selectMicroblogClipping, scheduleMicroblogClippings, microblogClippingsContent } from '../src/connectors/microblog-clippings.js';
import { mergeDocuments } from '../src/models/merge.js';

beforeEach(() => { process.env.TOKEN_ENC_KEY = 'a'.repeat(64); resetEncryptionKeyCache(); });
afterEach(() => { delete process.env.TOKEN_ENC_KEY; resetEncryptionKeyCache(); });

async function setup() {
  const { app, db } = makeTestApp();
  const { username } = await registerUser(app);
  const uid = (db.prepare('SELECT id FROM users WHERE username=?').get(username) as { id: number }).id;
  upsertAccount(db, uid, 'microblog', { token: 'token' }, null);
  db.prepare('INSERT INTO documents(user_id,document,title,author,updated_at) VALUES(?,?,?,?,0)').run(uid, DOC, 'Test book', 'Author');
  for (const [id, text, spine] of [['one', 'First passage', 1], ['two', 'Second passage', 2]] as const) {
    db.prepare('INSERT INTO clippings(user_id,document,id,text,spine_index,created_at,updated_at) VALUES(?,?,?,?,?,1,1)').run(uid, DOC, id, text, spine);
  }
  return { db, uid };
}

it('persists manual intent without a match and queues one book after matching', async () => {
  const { db, uid } = await setup();
  selectMicroblogClipping(db, uid, DOC, 'two');
  expect(scheduleMicroblogClippings(db, uid, DOC)).toBe(0);
  saveMatch(db, uid, 'microblog', DOC, { externalId: '123', externalEdition: '9781786487849', confidence: 1 }, 'manual');
  expect(scheduleMicroblogClippings(db, uid, DOC)).toBe(1);
  scheduleMicroblogClippings(db, uid, DOC);
  expect(db.prepare("SELECT COUNT(*) n FROM connector_queue WHERE connector_id='microblog'").get()).toEqual({ n: 1 });
  const content = microblogClippingsContent(db, uid, DOC, 'https://micro.blog/books/9781786487849');
  expect(content?.title).toBe('📚 Clippings from Test book');
  expect(content?.content).toContain('Second passage');
  expect(content?.content).not.toContain('First passage');
  expect(microblogClippingsContent(db, uid, DOC, 'https://micro.blog/books/9781786487849')?.fingerprint).toBe(content?.fingerprint);
  db.close();
});

it('automatic mode includes existing clippings in reading order and isolates users', async () => {
  const { db, uid } = await setup();
  db.prepare("UPDATE connector_accounts SET options=? WHERE user_id=? AND connector_id='microblog'").run('{"sync_highlights":true}', uid);
  scheduleMicroblogClippings(db, uid, DOC);
  const content = microblogClippingsContent(db, uid, DOC, 'https://micro.blog/books/9781786487849');
  expect(content?.content.indexOf('First passage')).toBeLessThan(content!.content.indexOf('Second passage'));
  expect(microblogClippingsContent(db, uid + 1, DOC, 'https://micro.blog/books/9781786487849')).toBeNull();
  db.close();
});

it.each([
  ['text offsets', { start_offset: 10 }, { start_offset: 30 }],
  ['paragraphs', { paragraph_index: 1 }, { paragraph_index: 2 }],
  ['zero-based paragraphs', { paragraph_index: 0 }, { paragraph_index: 1 }],
  ['pages', { start_page: 2 }, { start_page: 4 }],
  ['words within a page', { start_page: 2, start_word: 3 }, { start_page: 2, start_word: 10 }],
  ['mixed offset availability', { start_offset: 100, paragraph_index: 1 }, { paragraph_index: 2 }],
] as const)('uses %s before creation time when ordering clippings in the same spine', async (_label, first, second) => {
  const { db, uid } = await setup();
  const update = db.prepare('UPDATE clippings SET spine_index=0,start_offset=?,paragraph_index=?,start_page=?,start_word=?,created_at=? WHERE user_id=? AND id=?');
  for (const [id, position, createdAt] of [['one', first, 2], ['two', second, 1]] as const) {
    const p = { start_offset: null, paragraph_index: null, start_page: 0, start_word: 0, ...position };
    update.run(p.start_offset, p.paragraph_index, p.start_page, p.start_word, createdAt, uid, id);
    selectMicroblogClipping(db, uid, DOC, id);
  }
  const content = microblogClippingsContent(db, uid, DOC, 'https://micro.blog/books/9781786487849')!.content;
  expect(content.indexOf('First passage')).toBeLessThan(content.indexOf('Second passage'));
  db.close();
});

it('keeps legacy published snapshots without fallback positions readable', async () => {
  const { db, uid } = await setup();
  for (const [id, text, created_at] of [['one', 'First passage', 1], ['two', 'Second passage', 2]] as const) {
    selectMicroblogClipping(db, uid, DOC, id);
    const snapshot = { id, text, note: null, chapter_title: '', spine_index: 0, start_offset: null, created_at };
    db.prepare('UPDATE microblog_clipping_selections SET manual=0,published_snapshot=? WHERE user_id=? AND clipping_id=?')
      .run(JSON.stringify(snapshot), uid, id);
  }
  const content = microblogClippingsContent(db, uid, DOC, 'https://micro.blog/books/9781786487849')!.content;
  expect(content.indexOf('First passage')).toBeLessThan(content.indexOf('Second passage'));
  db.close();
});

it('automatic-off excludes unpublished automatic selections but preserves manual intent', async () => {
  const { db, uid } = await setup();
  db.prepare("UPDATE connector_accounts SET options=? WHERE user_id=?").run('{"sync_highlights":true}', uid);
  scheduleMicroblogClippings(db, uid, DOC);
  selectMicroblogClipping(db, uid, DOC, 'two');
  db.prepare("UPDATE connector_accounts SET options='{}' WHERE user_id=?").run(uid);
  expect(microblogClippingsContent(db, uid, DOC, 'https://micro.blog/books/9781786487849')?.content).not.toContain('First passage');
  expect(microblogClippingsContent(db, uid, DOC, 'https://micro.blog/books/9781786487849')?.content).toContain('Second passage');
  db.close();
});

it('keeps selected clippings and the remote post when merging books', async () => {
  const { db, uid } = await setup();
  const target = 'b'.repeat(32);
  selectMicroblogClipping(db, uid, DOC, 'one');
  microblogClippingsContent(db, uid, DOC, 'https://micro.blog/books/9781786487849');
  db.prepare('UPDATE microblog_clipping_posts SET url=?,attempted=1 WHERE user_id=?').run('https://example.micro.blog/highlights', uid);
  mergeDocuments(db, uid, DOC, target, 10);
  expect(microblogClippingsContent(db, uid, DOC, 'https://micro.blog/books/9781786487849')?.content).toContain('First passage');
  selectMicroblogClipping(db, uid, DOC, 'two');
  expect(microblogClippingsContent(db, uid, target, 'https://micro.blog/books/9781786487849')?.content).toContain('Second passage');
  expect(db.prepare('SELECT url,document FROM microblog_clipping_posts WHERE user_id=?').get(uid))
    .toEqual({ url: 'https://example.micro.blog/highlights', document: target });
  db.close();
});
