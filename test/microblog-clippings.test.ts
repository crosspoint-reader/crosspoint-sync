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
  expect(content?.title).toBe('Highlights from Test book');
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
