import { createHash, randomUUID } from 'node:crypto';
import { withTransaction, type DB } from '../db/db.js';
import { clippingDocuments, mergedClippingsCte, resolveDocument } from '../models/merge.js';
import { documentMeta, getAccount, getMatch } from './store.js';
import { enqueue } from './queue.js';
import { nowSeconds } from '../models/sync.js';
import { ConnectorOperationError, type Credential, type Match, type OutboundEvent, type HttpTransport, type ConnectorContext, type PushResult } from './types.js';

export interface ClippingsPost {
  identity: string;
  url: string | null;
  fingerprint: string | null;
  attempted: number;
  error: string | null;
}
interface Passage {
  id: string; text: string; note: string | null; chapter_title: string;
  spine_index: number; start_offset: number | null; created_at: number;
}

function automatic(db: DB, userId: number): boolean {
  const row = db.prepare("SELECT options FROM connector_accounts WHERE user_id=? AND connector_id='microblog'")
    .get(userId) as { options: string | null } | undefined;
  try { return JSON.parse(row?.options || '{}').sync_highlights === true; } catch { return false; }
}

function liveClippings(db: DB, userId: number, document: string): Passage[] {
  const docs = clippingDocuments(db, userId, document);
  return db.prepare(`${mergedClippingsCte(docs.length)} SELECT id,text,note,chapter_title,spine_index,start_offset,created_at
    FROM merged WHERE document=? AND deleted=0`).all(userId, ...docs, document) as unknown as Passage[];
}

export function clippingsPost(db: DB, userId: number, document: string): ClippingsPost {
  db.prepare('INSERT OR IGNORE INTO microblog_clipping_posts(user_id,document,identity) VALUES(?,?,?)')
    .run(userId, document, randomUUID());
  return db.prepare('SELECT identity,url,fingerprint,attempted,error FROM microblog_clipping_posts WHERE user_id=? AND document=?')
    .get(userId, document) as unknown as ClippingsPost;
}

export function selectMicroblogClipping(db: DB, userId: number, document: string, clippingId: string): void {
  document = resolveDocument(db, userId, document);
  if (!liveClippings(db, userId, document).some((c) => c.id === clippingId)) throw new Error('Clipping not found');
  db.prepare(`INSERT INTO microblog_clipping_selections(user_id,document,clipping_id,manual) VALUES(?,?,?,1)
    ON CONFLICT(user_id,document,clipping_id) DO UPDATE SET manual=1`).run(userId, document, clippingId);
}

/** Include published snapshots even after deletion or disabling automatic additions. */
function passages(db: DB, userId: number, document: string): Passage[] {
  const live = liveClippings(db, userId, document);
  const enabled = automatic(db, userId);
  const selections = db.prepare('SELECT clipping_id,manual,published_snapshot FROM microblog_clipping_selections WHERE user_id=? AND document=?')
    .all(userId, document) as { clipping_id: string; manual: number; published_snapshot: string | null }[];
  return selections.flatMap((s) => {
    const current = live.find((c) => c.id === s.clipping_id);
    if ((enabled || s.manual) && current) return [current];
    return s.published_snapshot ? [JSON.parse(s.published_snapshot) as Passage] : [];
  }).sort((a, b) => a.spine_index - b.spine_index || (a.start_offset ?? 0) - (b.start_offset ?? 0)
    || a.created_at - b.created_at || a.id.localeCompare(b.id));
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function paragraph(s: string): string { return escapeHtml(s).replace(/\n/g, '<br>'); }

export function microblogClippingsContent(db: DB, userId: number, document: string, bookUrl: string): { title: string; content: string; fingerprint: string } | null {
  document = resolveDocument(db, userId, document);
  const selected = passages(db, userId, document);
  if (!selected.length) return null;
  const meta = documentMeta(db, userId, document);
  const title = `Highlights from ${meta.title || meta.filename || 'Untitled book'}`;
  const post = clippingsPost(db, userId, document);
  const content = [`<p><a href="${escapeHtml(bookUrl)}">${escapeHtml(meta.title || 'View book on Micro.blog')}</a>${meta.author ? ` by ${escapeHtml(meta.author)}` : ''}</p>`,
    ...selected.map((c) => `<blockquote><p>${paragraph(c.text)}</p></blockquote>${c.note ? `<p>${paragraph(c.note)}</p>` : ''}${c.chapter_title ? `<p><em>${paragraph(c.chapter_title)}</em></p>` : ''}`),
    `<!-- crosspoint-sync:${post.identity} -->`].join('\n\n');
  return { title, content, fingerprint: createHash('sha256').update(JSON.stringify([title, content])).digest('hex') };
}

export function savePublishedClippings(db: DB, userId: number, document: string, selected: Passage[]): void {
  for (const c of selected) db.prepare('UPDATE microblog_clipping_selections SET published_snapshot=? WHERE user_id=? AND document=? AND clipping_id=?')
    .run(JSON.stringify(c), userId, document, c.id);
}

export function scheduleMicroblogClippings(db: DB, userId: number, document?: string): number {
  const account = getAccount(db, userId, 'microblog');
  if (!account?.enabled) return 0;
  const docs = document ? [resolveDocument(db, userId, document)] : [...new Set((db.prepare(`
    SELECT document FROM clippings WHERE user_id=? UNION SELECT document FROM microblog_clipping_selections WHERE user_id=?`)
    .all(userId, userId) as { document: string }[]).map((r) => resolveDocument(db, userId, r.document)))];
  let queued = 0;
  for (const doc of docs) {
    if (automatic(db, userId)) {
      const insert = db.prepare('INSERT OR IGNORE INTO microblog_clipping_selections(user_id,document,clipping_id) VALUES(?,?,?)');
      for (const c of liveClippings(db, userId, doc)) insert.run(userId, doc, c.id);
    }
    if (!getMatch(db, userId, 'microblog', doc)?.external_id || !passages(db, userId, doc).length) continue;
    const state = clippingsPost(db, userId, doc);
    if (state.error) continue;
    const existing = db.prepare("SELECT status FROM connector_queue WHERE user_id=? AND connector_id='microblog' AND document=? AND kind='microblog:clippings'")
      .get(userId, doc) as { status: string } | undefined;
    if (existing?.status === 'pending') continue; // Preserve backoff after a transient failure.
    enqueue(db, userId, 'microblog', { kind: 'highlight', document: doc, timestamp: nowSeconds() }, 'microblog:clippings');
    queued++;
  }
  return queued;
}

/** Migrate publication state before the ordinary document side tables move. */
export function mergeMicroblogClippings(db: DB, userId: number, from: string, into: string): void {
  const source = db.prepare('SELECT * FROM microblog_clipping_posts WHERE user_id=? AND document=?').get(userId, from) as unknown as ClippingsPost | undefined;
  const target = db.prepare('SELECT * FROM microblog_clipping_posts WHERE user_id=? AND document=?').get(userId, into) as unknown as ClippingsPost | undefined;
  if (source && target && (source.url || source.attempted) && (target.url || target.attempted)) {
    db.prepare('UPDATE microblog_clipping_posts SET error=? WHERE user_id=? AND document=?')
      .run('Merged books both have Micro.blog publication history; review their posts before syncing.', userId, into);
  } else if (source && (!target || source.url || source.attempted)) {
    db.prepare('DELETE FROM microblog_clipping_posts WHERE user_id=? AND document=?').run(userId, into);
    db.prepare('UPDATE microblog_clipping_posts SET document=? WHERE user_id=? AND document=?').run(into, userId, from);
  }
  db.prepare('DELETE FROM microblog_clipping_posts WHERE user_id=? AND document=?').run(userId, from);
  db.prepare(`INSERT INTO microblog_clipping_selections(user_id,document,clipping_id,manual,published_snapshot)
    SELECT user_id,?,clipping_id,manual,published_snapshot FROM microblog_clipping_selections WHERE user_id=? AND document=?
    ON CONFLICT(user_id,document,clipping_id) DO UPDATE SET manual=MAX(manual,excluded.manual),
    published_snapshot=COALESCE(published_snapshot,excluded.published_snapshot)`).run(into, userId, from);
  db.prepare('DELETE FROM microblog_clipping_selections WHERE user_id=? AND document=?').run(userId, from);
}

/** Only publish/recover one book at a time, even when two drains overlap. */
const publishing = new WeakMap<DB, Set<string>>();

async function micropub(http: HttpTransport, token: string, path: string, body?: unknown) {
  let res;
  try {
    res = await http(`https://micro.blog${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new ConnectorOperationError('Micro.blog Micropub connection failed; the next attempt will check for an existing post.', true); }
  if (res.status >= 300) {
    throw new ConnectorOperationError(`Micro.blog Micropub failed (${res.status})`, res.status === 429 || res.status >= 500,
      res.status === 401 || res.status === 403);
  }
  return res;
}

function postUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
}

async function recoverPost(http: HttpTransport, token: string, identity: string): Promise<string | null> {
  const matches = new Set<string>();
  // Bound the scan; an incomplete scan never permits creating a replacement.
  for (let offset = 0; offset < 10000; offset += 100) {
    const res = await micropub(http, token, `/micropub?q=source&limit=100&offset=${offset}`);
    const payload = await res.json() as { items?: { properties?: { content?: unknown[]; url?: unknown[] } }[] };
    if (!Array.isArray(payload.items)) throw new ConnectorOperationError('Micro.blog post recovery returned an invalid source feed.', true);
    for (const item of payload.items) {
      const content = JSON.stringify(item.properties?.content ?? []);
      if (!content.includes(`crosspoint-sync:${identity}`)) continue;
      const url = postUrl(item.properties?.url?.[0]);
      if (url) matches.add(url);
    }
    if (payload.items.length < 100) return matches.size === 1 ? [...matches][0] : null;
  }
  return null;
}

export async function publishMicroblogClippings(
  cred: Credential, match: Match, event: OutboundEvent, http: HttpTransport, ctx: ConnectorContext
): Promise<PushResult> {
  const { db, userId } = ctx;
  const document = resolveDocument(db, userId, event.document);
  const key = `${userId}:${document}`;
  let locks = publishing.get(db);
  if (!locks) { locks = new Set(); publishing.set(db, locks); }
  if (locks.has(key)) return { ok: false, retryable: true, error: 'Micro.blog book publication is already in progress' };
  locks.add(key);
  const permanent = (error: string): PushResult => {
    db.prepare('UPDATE microblog_clipping_posts SET error=? WHERE user_id=? AND document=?').run(error, userId, document);
    return { ok: false, retryable: false, error };
  };
  try {
    const token = typeof cred.token === 'string' ? cred.token.trim() : '';
    if (!token) throw new ConnectorOperationError('Missing Micro.blog token', false, true);
    // Caller resolves a verified ISBN; internal bookshelf IDs are never used as ISBNs.
    const isbn = match.externalEdition;
    if (!isbn || !/^(?:\d{13}|\d{9}[\dXx])$/.test(isbn)) return permanent('Micro.blog book ISBN is unavailable; choose a book match with an ISBN.');
    const selected = passages(db, userId, document);
    const rendered = microblogClippingsContent(db, userId, document, `https://micro.blog/books/${encodeURIComponent(isbn)}`);
    if (!rendered) return { ok: true };
    const state = clippingsPost(db, userId, document);
    if (state.error) return { ok: false, retryable: false, error: state.error };
    if (rendered.fingerprint === state.fingerprint && state.url) return { ok: true };
    let url = state.url;
    if (!url && state.attempted) {
      url = await recoverPost(http, token, state.identity);
      if (!url) return permanent('Micro.blog post creation could not be resolved uniquely. Review your blog posts before retrying; no duplicate was created.');
      db.prepare('UPDATE microblog_clipping_posts SET url=? WHERE user_id=? AND document=?').run(url, userId, document);
    }
    if (url) {
      try {
        // Detect deleted posts before replacing generated content.
        await micropub(http, token, `/micropub?q=source&url=${encodeURIComponent(url)}`);
        await micropub(http, token, '/micropub', { action: 'update', url,
          replace: { name: [rendered.title], content: [{ html: rendered.content }] } });
      } catch (err) {
        if (err instanceof ConnectorOperationError && !err.retryable && !err.needsReauth) return permanent(`${err.message}. Review the saved Micro.blog post before syncing again.`);
        throw err;
      }
    } else {
      db.prepare('UPDATE microblog_clipping_posts SET attempted=1 WHERE user_id=? AND document=?').run(userId, document);
      let res;
      try {
        res = await micropub(http, token, '/micropub', { type: ['h-entry'], properties: {
          name: [rendered.title], content: [{ html: rendered.content }], 'post-status': ['published'],
          'mp-slug': [`crosspoint-highlights-${state.identity}`],
        } });
      } catch (err) {
        if (err instanceof ConnectorOperationError && (err.needsReauth || err.message.includes('(429)'))) {
          db.prepare('UPDATE microblog_clipping_posts SET attempted=0 WHERE user_id=? AND document=?').run(userId, document);
        } else if (err instanceof ConnectorOperationError && !err.retryable) return permanent(err.message);
        throw err;
      }
      url = postUrl(res.headers?.get('location'));
      if (!url) {
        throw new ConnectorOperationError('Micro.blog accepted the post without its URL; the next attempt will recover it.', true);
      }
      // Persist Location immediately, before any other work can fail.
      db.prepare('UPDATE microblog_clipping_posts SET url=? WHERE user_id=? AND document=?').run(url, userId, document);
    }
    withTransaction(db, () => {
      savePublishedClippings(db, userId, document, selected);
      db.prepare('UPDATE microblog_clipping_posts SET fingerprint=?,error=NULL WHERE user_id=? AND document=?')
        .run(rendered.fingerprint, userId, document);
    });
    return { ok: true };
  } finally { locks.delete(key); }
}
