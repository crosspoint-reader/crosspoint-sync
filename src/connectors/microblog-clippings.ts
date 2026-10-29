import { createHash, randomUUID } from 'node:crypto';
import { withTransaction, type DB } from '../db/db.js';
import { clippingDocuments, mergedClippingsCte, resolveDocument } from '../models/merge.js';
import { decryptCredential, documentMeta, getAccount, getMatch } from './store.js';
import { enqueue } from './queue.js';
import { nowSeconds } from '../models/sync.js';
import { destinationForPost, listMicroblogDestinations, selectedMicroblogDestination } from './microblog-destinations.js';
import { ConnectorOperationError, type Credential, type Match, type OutboundEvent, type HttpTransport, type ConnectorContext, type PushResult } from './types.js';

export interface ClippingsPost {
  identity: string;
  url: string | null;
  fingerprint: string | null;
  book_url: string | null;
  matched_book: string | null;
  attempted: number;
  error: string | null;
  destination: string | null;
  missing: number;
}
interface Passage {
  id: string; text: string; note: string | null; chapter_title: string;
  spine_index: number; start_offset: number | null; created_at: number;
  // Older published snapshots predate these fallback coordinates.
  paragraph_index?: number | null; start_page?: number; start_word?: number;
}

function automatic(db: DB, userId: number): boolean {
  const row = db.prepare("SELECT options FROM connector_accounts WHERE user_id=? AND connector_id='microblog'")
    .get(userId) as { options: string | null } | undefined;
  try { return JSON.parse(row?.options || '{}').sync_highlights === true; } catch { return false; }
}

function liveClippings(db: DB, userId: number, document: string): Passage[] {
  const docs = clippingDocuments(db, userId, document);
  return db.prepare(`${mergedClippingsCte(docs.length)} SELECT id,text,note,chapter_title,spine_index,start_offset,paragraph_index,start_page,start_word,created_at
    FROM merged WHERE document=? AND deleted=0`).all(userId, ...docs, document) as unknown as Passage[];
}

export function clippingsPost(db: DB, userId: number, document: string): ClippingsPost {
  db.prepare('INSERT OR IGNORE INTO microblog_clipping_posts(user_id,document,identity) VALUES(?,?,?)')
    .run(userId, document, randomUUID());
  return db.prepare('SELECT identity,url,fingerprint,book_url,matched_book,attempted,error,destination,missing FROM microblog_clipping_posts WHERE user_id=? AND document=?')
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
  const selected = selections.flatMap((s) => {
    const current = live.find((c) => c.id === s.clipping_id);
    if ((enabled || s.manual) && current) return [current];
    return s.published_snapshot ? [JSON.parse(s.published_snapshot) as Passage] : [];
  });
  const coordinates = ['start_offset', 'paragraph_index', 'start_page', 'start_word'] as const;
  const common = new Map<number, readonly (typeof coordinates[number])[]>();
  // Use the same coordinate system throughout a spine. Mixed client versions
  // must not compare a character offset to a paragraph or page number.
  for (const c of selected) {
    common.set(c.spine_index, (common.get(c.spine_index) ?? coordinates).filter((key) => c[key] != null));
  }
  return selected.sort((a, b) => {
    if (a.spine_index !== b.spine_index) return a.spine_index - b.spine_index;
    for (const key of common.get(a.spine_index)!) {
      const difference = a[key]! - b[key]!;
      if (difference) return difference;
    }
    return a.created_at - b.created_at || a.id.localeCompare(b.id);
  });
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
  const title = `📚 Clippings from ${meta.title || meta.filename || 'Untitled book'}`;
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
    const blocked = db.prepare('SELECT error FROM microblog_clipping_posts WHERE user_id=? AND document=?')
      .get(userId, doc) as { error: string | null } | undefined;
    if (blocked?.error) {
      // A merge can pause publication without making a delivery attempt.
      // Surface durable errors in Settings even if this book is now unmatched.
      withTransaction(db, () => {
        enqueue(db, userId, 'microblog', { kind: 'highlight', document: doc, timestamp: nowSeconds() }, 'microblog:clippings');
        db.prepare("UPDATE connector_queue SET status='dead',last_error=? WHERE user_id=? AND connector_id='microblog' AND document=? AND kind='microblog:clippings'")
          .run(blocked.error, userId, doc);
      });
      continue;
    }
    const match = getMatch(db, userId, 'microblog', doc);
    if (!match?.external_id || !passages(db, userId, doc).length) continue;
    const state = clippingsPost(db, userId, doc);
    if (state.error) continue;
    const isbn = match.external_edition ?? (/^(?:\d{13}|\d{9}[\dXx])$/.test(match.external_id) ? match.external_id : null);
    const bookUrl = isbn ? `https://micro.blog/books/${encodeURIComponent(isbn)}` : state.book_url;
    if (state.url && bookUrl && state.matched_book === match.external_id
        && state.fingerprint === microblogClippingsContent(db, userId, doc, bookUrl)?.fingerprint) {
      // Removing rejected unpublished content can restore the last successful
      // post without another network update. Its old validation error is stale.
      db.prepare(`UPDATE connector_queue SET status='done',last_error=NULL,updated_at=?
        WHERE user_id=? AND connector_id='microblog' AND document=? AND kind='microblog:clippings' AND status='dead'`)
        .run(nowSeconds(), userId, doc);
      continue;
    }
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

class MissingMicroblogPost extends ConnectorOperationError {
  constructor() { super('The Micro.blog clippings post was deleted. Use Recreate clippings post to resume publishing.', false); }
}

class MicropubResponseError extends ConnectorOperationError {
  constructor(readonly status: number, operation: string) {
    super(`Micro.blog Micropub ${operation} failed (${status})`, status === 408 || status === 429 || status >= 500,
      status === 401 || status === 403);
  }
}

async function micropub(http: HttpTransport, token: string, destination: string, path: string, body?: unknown, sourceLookup = false) {
  const operation = body ? (body as { action?: string }).action === 'update' ? 'update' : 'create'
    : sourceLookup ? 'source lookup' : 'post recovery';
  let res;
  try {
    const url = new URL(path, 'https://micro.blog');
    url.searchParams.set('mp-destination', destination);
    res = await http(url.href, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new ConnectorOperationError(`Micro.blog Micropub ${operation} connection failed; the next attempt will check for an existing post.`, true); }
  const existingPost = sourceLookup || operation === 'update';
  if (existingPost && res.status === 404) throw new MissingMicroblogPost();
  if (existingPost && res.status === 400) {
    const failure = await res.json().catch(() => null) as { error?: string; error_description?: string } | null;
    if (failure?.error === 'invalid_request' && /no post|not found|does not exist|could not find|unknown.*url/i.test(failure.error_description || '')) throw new MissingMicroblogPost();
  }
  if (res.status >= 300) {
    throw new MicropubResponseError(res.status, operation);
  }
  return res;
}

function postUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch { return null; }
}

async function recoverPost(http: HttpTransport, token: string, destination: string, identity: string): Promise<string | null> {
  const matches = new Set<string>();
  // Bound the scan; an incomplete scan never permits creating a replacement.
  for (let offset = 0; offset < 10000; offset += 100) {
    const res = await micropub(http, token, destination, `/micropub?q=source&limit=100&offset=${offset}`);
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
  const account = getAccount(db, userId, 'microblog');
  const initialMatch = getMatch(db, userId, 'microblog', document);
  let identity: string | undefined;
  const assertCurrent = () => {
    const current = getAccount(db, userId, 'microblog');
    const saved = db.prepare('SELECT identity,error FROM microblog_clipping_posts WHERE user_id=? AND document=?').get(userId, document) as { identity: string; error: string | null } | undefined;
    if (!account?.enabled || !current?.enabled || current.cred_enc !== account.cred_enc || (identity && saved?.identity !== identity)) {
      throw new ConnectorOperationError('Micro.blog account or book changed during publication', false);
    }
    // A merge can pause this collection without changing its identity. An older
    // in-flight attempt must not acknowledge the write or clear that new error.
    if (identity && saved?.error) throw new ConnectorOperationError(saved.error, false);
    const currentMatch = getMatch(db, userId, 'microblog', document);
    // The ISBN may have been enriched from the shelf without changing the saved
    // match. Compare saved editions as well as the match passed by the caller.
    if (!initialMatch?.external_id || initialMatch.external_id !== match.externalId ||
        (initialMatch.external_edition && initialMatch.external_edition !== match.externalEdition) ||
        currentMatch?.external_id !== initialMatch.external_id || currentMatch?.external_edition !== initialMatch.external_edition) {
      throw new ConnectorOperationError('Micro.blog book match changed during publication; sync again with the current match.', false);
    }
  };
  const permanent = (error: string): PushResult => {
    assertCurrent();
    db.prepare('UPDATE microblog_clipping_posts SET error=? WHERE user_id=? AND document=?').run(error, userId, document);
    return { ok: false, retryable: false, error };
  };
  locks.add(key);
  try {
    const token = typeof cred.token === 'string' ? cred.token.trim() : '';
    if (!token) throw new ConnectorOperationError('Missing Micro.blog token', false, true);
    assertCurrent();
    if (decryptCredential(account!).token !== cred.token) throw new ConnectorOperationError('Micro.blog credential changed before publication', false);
    // Caller resolves a verified ISBN; internal bookshelf IDs are never used as ISBNs.
    const isbn = match.externalEdition;
    if (!isbn || !/^(?:\d{13}|\d{9}[\dXx])$/.test(isbn)) return { ok: false, retryable: false, error: 'Micro.blog book ISBN is unavailable; choose a book match with an ISBN.' };
    const state = clippingsPost(db, userId, document);
    identity = state.identity;
    if (state.error) return { ok: false, retryable: false, error: state.error };
    const selectedBlog = selectedMicroblogDestination(db, userId);
    const blogs = await listMicroblogDestinations(cred, http);
    assertCurrent();
    const destination = state.destination ?? (state.url ? destinationForPost(state.url, blogs)
      : state.attempted ? null : selectedBlog ?? (blogs.length === 1 ? blogs[0].uid : null));
    if (!destination || !blogs.some((b) => b.uid === destination)) return {
      ok: false, retryable: false, error: state.url || state.attempted || state.destination
        ? 'The original Micro.blog blog is unavailable or cannot be identified. Restore access to that blog before syncing.'
        : 'Choose Post clippings to in Micro.blog settings before publishing.',
    };
    const selected = passages(db, userId, document);
    const rendered = microblogClippingsContent(db, userId, document, `https://micro.blog/books/${encodeURIComponent(isbn)}`);
    if (!rendered) return { ok: true };
    db.prepare('UPDATE microblog_clipping_posts SET destination=? WHERE user_id=? AND document=?').run(destination, userId, document);
    if (rendered.fingerprint === state.fingerprint && state.url) {
      db.prepare('UPDATE microblog_clipping_posts SET book_url=?,matched_book=? WHERE user_id=? AND document=?')
        .run(`https://micro.blog/books/${encodeURIComponent(isbn)}`, match.externalId, userId, document);
      return { ok: true };
    }
    let url = state.url;
    if (!url && state.attempted) {
      url = await recoverPost(http, token, destination, state.identity);
      assertCurrent();
      if (!url) return permanent('Micro.blog post creation could not be resolved uniquely. Review your blog posts before retrying; no duplicate was created. If switching blogs, unlink Micro.blog and connect the new blog.');
      db.prepare('UPDATE microblog_clipping_posts SET url=? WHERE user_id=? AND document=?').run(url, userId, document);
    }
    if (url) {
      try {
        // Detect deleted posts before replacing generated content.
        await micropub(http, token, destination, `/micropub?q=source&url=${encodeURIComponent(url)}`, undefined, true);
        assertCurrent();
        // Options and selections can change while the source request is in
        // flight. Retry with fresh content before publishing or snapshotting it.
        if (microblogClippingsContent(db, userId, document, `https://micro.blog/books/${encodeURIComponent(isbn)}`)?.fingerprint !== rendered.fingerprint) {
          throw new ConnectorOperationError('Micro.blog clipping selections changed during publication; the next attempt will use the current selections.', true);
        }
        await micropub(http, token, destination, '/micropub', { action: 'update', url,
          replace: { name: [rendered.title], content: [rendered.content] } });
        assertCurrent();
      } catch (err) {
        assertCurrent();
        if (err instanceof MissingMicroblogPost) {
          db.prepare('UPDATE microblog_clipping_posts SET missing=1 WHERE user_id=? AND document=?').run(userId, document);
          return permanent(err.message);
        }
        if (err instanceof ConnectorOperationError && !err.retryable && !err.needsReauth) return {
          ok: false, retryable: false, error: `${err.message}. Correct the clippings and sync this book again.`,
        };
        throw err;
      }
    } else {
      db.prepare('UPDATE microblog_clipping_posts SET attempted=1 WHERE user_id=? AND document=?').run(userId, document);
      let res;
      try {
        res = await micropub(http, token, destination, '/micropub', { type: ['h-entry'], properties: {
          name: [rendered.title], content: [{ html: rendered.content }], 'post-status': ['published'],
          'mp-slug': [`crosspoint-clippings-${state.identity}`],
        } });
      } catch (err) {
        assertCurrent();
        // Only known request rejections prove that no post was created.
        if (err instanceof MicropubResponseError && [400, 401, 403, 413, 415, 422, 429].includes(err.status)) {
          db.prepare('UPDATE microblog_clipping_posts SET attempted=0 WHERE user_id=? AND document=?').run(userId, document);
          if (!err.retryable && !err.needsReauth) return {
            ok: false, retryable: false, error: `${err.message}. Correct the clippings and sync this book again.`,
          };
        } else if (err instanceof ConnectorOperationError && !err.retryable) return permanent(err.message);
        throw err;
      }
      assertCurrent();
      url = postUrl(res.headers?.get('location'));
      if (!url) {
        throw new ConnectorOperationError('Micro.blog accepted the post without its URL; the next attempt will recover it.', true);
      }
      // Persist Location immediately, before any other work can fail.
      db.prepare('UPDATE microblog_clipping_posts SET url=? WHERE user_id=? AND document=?').run(url, userId, document);
    }
    withTransaction(db, () => {
      savePublishedClippings(db, userId, document, selected);
      db.prepare('UPDATE microblog_clipping_posts SET fingerprint=?,book_url=?,matched_book=?,error=NULL WHERE user_id=? AND document=?')
        .run(rendered.fingerprint, `https://micro.blog/books/${encodeURIComponent(isbn)}`, match.externalId, userId, document);
    });
    return { ok: true };
  } finally { locks.delete(key); }
}

export async function recreateMicroblogClippings(db: DB, userId: number, doc: string, http: HttpTransport, target: 'original' | 'current' = 'original'): Promise<{ queued: boolean }> {
  const document = resolveDocument(db, userId, doc);
  const account = getAccount(db, userId, 'microblog');
  if (!account?.enabled) throw new ConnectorOperationError('Micro.blog is not linked or enabled', false);
  const state = db.prepare('SELECT * FROM microblog_clipping_posts WHERE user_id=? AND document=?').get(userId, document) as unknown as ClippingsPost | undefined;
  if (!state?.missing || !state.url) throw new ConnectorOperationError('This book does not have a confirmed missing clippings post.', false);
  const requireMatch = () => {
    if (!getMatch(db, userId, 'microblog', document)?.external_id) {
      throw new ConnectorOperationError('Match this book in Micro.blog before recreating this post.', false);
    }
  };
  requireMatch();
  let locks = publishing.get(db); if (!locks) { locks = new Set(); publishing.set(db, locks); }
  const key = `${userId}:${document}`;
  if (locks.has(key)) throw new ConnectorOperationError('Micro.blog publication is already in progress', true);
  locks.add(key);
  const current = () => {
    const row = db.prepare('SELECT identity FROM microblog_clipping_posts WHERE user_id=? AND document=?').get(userId, document) as { identity: string } | undefined;
    if (getAccount(db, userId, 'microblog')?.cred_enc !== account.cred_enc || row?.identity !== state.identity) throw new ConnectorOperationError('Micro.blog account or book changed; reload before retrying.', false);
    requireMatch();
  };
  try {
    const cred = decryptCredential(account, db);
    const blogs = await listMicroblogDestinations(cred, http); current();
    const original = state.destination ?? destinationForPost(state.url, blogs);
    const destination = target === 'current'
      ? selectedMicroblogDestination(db, userId) ?? (blogs.length === 1 ? blogs[0].uid : null)
      : original;
    if (!destination || !blogs.some((b) => b.uid === destination)) throw new ConnectorOperationError(target === 'current'
      ? 'Choose an available clippings blog in Micro.blog settings before recreating this post.'
      : 'Restore access to the original Micro.blog blog or choose the current clippings blog.', false);
    // The durable missing flag permits an explicit move after original-blog access is lost.
    // When accessible, recheck the original to avoid duplicating a restored post.
    let missing = true;
    if (original && blogs.some((b) => b.uid === original)) {
      try {
        await micropub(http, String(cred.token), original, `/micropub?q=source&url=${encodeURIComponent(state.url)}`, undefined, true);
        missing = false;
      } catch (error) { if (!(error instanceof MissingMicroblogPost)) throw error; }
    }
    current();
    if (!missing && destination !== original) throw new ConnectorOperationError('The previous post exists again. Choose the previous blog to resume updating it.', false);
    withTransaction(db, () => {
      if (missing) db.prepare(`UPDATE microblog_clipping_posts SET identity=?,url=NULL,fingerprint=NULL,attempted=0,error=NULL,missing=0,destination=? WHERE user_id=? AND document=?`)
        .run(randomUUID(), destination, userId, document);
      else db.prepare('UPDATE microblog_clipping_posts SET fingerprint=NULL,error=NULL,missing=0,destination=? WHERE user_id=? AND document=?').run(destination, userId, document);
      // A previous missing-post job may still be pending in a concurrent drain.
      db.prepare("DELETE FROM connector_queue WHERE user_id=? AND document=? AND connector_id='microblog' AND kind='microblog:clippings'").run(userId, document);
    });
  } finally { locks.delete(key); }
  return { queued: scheduleMicroblogClippings(db, userId, document) > 0 };
}
