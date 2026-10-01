import { Hono } from 'hono';
import { withTransaction, type DB } from '../../db/db.js';
import { kosyncError, type AppEnv } from '../../auth/middleware.js';
import { isValidDocument } from '../kosync.js';
import { isItemId, nowSeconds, parseListParams } from '../../models/sync.js';
import { fanOutHighlight, highlightFromRow, type ClippingHighlightRow } from '../../connectors/fanout.js';
import { documentMeta } from '../../connectors/store.js';
import { clippingDocuments, mergedClippingsCte, resolveDocument } from '../../models/merge.js';

const MAX_BATCH = 50;
const MAX_TEXT = 4096; // full firmware clipping, not the text-export cap
const MAX_NOTE = 4096;
const MAX_CHAPTER = 64;

interface ClippingRow {
  id: string;
  spine_index: number;
  start_page: number;
  end_page: number;
  page_count: number;
  start_word: number;
  end_word: number;
  word_count: number;
  paragraph_index: number | null;
  chapter_title: string;
  text: string;
  note: string | null;
  color: string | null;
  created_at: number;
  deleted: number;
  updated_at: number;
  revision: number;
  layout_signature: number;
  start_offset: number | null;
  end_offset: number | null;
}

function uint(v: unknown, fallback?: number): number | undefined {
  if (v === undefined && fallback !== undefined) return fallback;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff) return v;
  return undefined;
}

export function clippingRoutes(db: DB): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Every live clipping across all books, newest first: the app's clippings hub.
  app.get('/clippings', (c) => {
    const user = c.get('user');
    const rows = db
      .prepare(
        `${mergedClippingsCte()}
         SELECT document, id, spine_index, paragraph_index, start_offset, chapter_title, text, note, created_at
         FROM merged WHERE deleted = 0 ORDER BY created_at DESC, id LIMIT 5000`
      )
      .all(user.id) as unknown as (Pick<ClippingRow, 'id' | 'spine_index' | 'paragraph_index' | 'start_offset' | 'chapter_title' | 'text' | 'note' | 'created_at'> & { document: string })[];
    return c.json({
      items: rows.map((r) => ({
        document: r.document,
        id: r.id,
        spine: r.spine_index,
        para: r.paragraph_index,
        start_offset: r.start_offset,
        chapter: r.chapter_title,
        text: r.text,
        note: r.note,
        created_at: r.created_at,
      })),
    });
  });

  app.get('/clippings/:document', (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    const user = c.get('user');
    const { since, limit } = parseListParams(c);
    const cursorRaw = c.req.query('cursor');
    const cursor = Number(cursorRaw ?? 0);
    if (!Number.isSafeInteger(cursor) || cursor < 0) return kosyncError(c, 403, 2003, 'Invalid cursor');
    const revisionMode = cursorRaw !== undefined;
    const canonical = resolveDocument(db, user.id, document);
    const documents = clippingDocuments(db, user.id, canonical);
    const rows = db
      .prepare(
        `${mergedClippingsCte(documents.length)}
         SELECT id, spine_index, start_page, end_page, page_count, start_word, end_word, word_count,
                paragraph_index, chapter_title, text, note, color, created_at, deleted, updated_at,
                revision, layout_signature, start_offset, end_offset
         FROM merged WHERE document = ? AND ${revisionMode ? 'revision' : 'updated_at'} > ?
         ORDER BY ${revisionMode ? 'revision' : 'updated_at, id'} LIMIT ?`
      )
      .all(user.id, ...documents, canonical, revisionMode ? cursor : since, limit + 1) as unknown as ClippingRow[];
    const more = rows.length > limit;
    const items = more ? rows.slice(0, limit) : rows;
    const until = more ? items[items.length - 1].updated_at : nowSeconds();
    return c.json({
      document,
      sync_version: 2,
      cursor: items.length ? items[items.length - 1].revision : cursor,
      until,
      more,
      items: items.map((r) => ({
        id: r.id,
        revision: r.revision,
        spine: r.spine_index,
        start_page: r.start_page,
        end_page: r.end_page,
        pages: r.page_count,
        start_word: r.start_word,
        end_word: r.end_word,
        words: r.word_count,
        para: r.paragraph_index,
        chapter: r.chapter_title,
        text: r.text,
        ...(c.req.query('format') === 'reader' ? {} : { note: r.note, color: r.color }),
        created_at: r.created_at,
        deleted: r.deleted,
        updated_at: r.updated_at,
        layout_signature: r.layout_signature,
        start_offset: r.start_offset,
        end_offset: r.end_offset,
      })),
    });
  });

  app.put('/clippings/:document', async (c) => {
    const document = c.req.param('document');
    if (!isValidDocument(document)) {
      return kosyncError(c, 403, 2004, "Field 'document' not provided.");
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const items = (body as Record<string, unknown> | null)?.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BATCH) {
      return kosyncError(c, 403, 2003, 'Invalid request');
    }
    const user = c.get('user');
    const canonical = resolveDocument(db, user.id, document);
    const now = nowSeconds();
    const documents = clippingDocuments(db, user.id, canonical);
    const readPrevious = db.prepare(`${mergedClippingsCte(documents.length, true)} SELECT * FROM merged`);

    const bumpRevision = db.prepare('UPDATE clipping_sync_clock SET revision = revision + 1 WHERE id = 1');
    const upsert = db.prepare(
      `INSERT INTO clippings (user_id, document, id, spine_index, start_page, end_page, page_count,
                              start_word, end_word, word_count, paragraph_index, chapter_title, text,
                              note, color, created_at, deleted, updated_at, layout_signature, start_offset, end_offset, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?,
               (SELECT revision FROM clipping_sync_clock WHERE id = 1))
       ON CONFLICT(user_id, document, id) DO UPDATE SET
         spine_index = excluded.spine_index,
         start_page = excluded.start_page,
         end_page = excluded.end_page,
         page_count = excluded.page_count,
         start_word = excluded.start_word,
         end_word = excluded.end_word,
         word_count = excluded.word_count,
         paragraph_index = excluded.paragraph_index,
         chapter_title = excluded.chapter_title,
         text = excluded.text,
         note = CASE WHEN ? THEN excluded.note ELSE clippings.note END,
         color = CASE WHEN ? THEN excluded.color ELSE clippings.color END,
         created_at = excluded.created_at,
         deleted = 0,
         updated_at = excluded.updated_at,
         layout_signature = excluded.layout_signature,
         start_offset = excluded.start_offset,
         end_offset = excluded.end_offset,
         revision = excluded.revision
       WHERE clippings.deleted = 0`
    );
    const tombstone = db.prepare(
      `INSERT INTO clippings (user_id, document, id, deleted, updated_at, revision)
       VALUES (?, ?, ?, 1, ?, (SELECT revision FROM clipping_sync_clock WHERE id = 1))
       ON CONFLICT(user_id, document, id) DO UPDATE SET
         deleted = 1,
         updated_at = excluded.updated_at,
         revision = excluded.revision`
    );

    type Op = () => void;
    const ops: Op[] = [];
    const highlightIds = new Set<string>();
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      const o = raw as Record<string, unknown>;
      if (!isItemId(o.id)) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      const id = o.id;
      if (o.deleted === 1 || o.deleted === true) {
        ops.push(() => tombstone.run(user.id, canonical, id, now));
        continue;
      }
      const spine = uint(o.spine);
      const startPage = uint(o.start_page, 0);
      const endPage = uint(o.end_page, 0);
      const pages = uint(o.pages, 1);
      const startWord = uint(o.start_word, 0);
      const endWord = uint(o.end_word, 0);
      const words = uint(o.words, 0);
      const createdAt = uint(o.created_at, 0);
      const layoutSignature = uint(o.layout_signature, 0);
      const startOffset = o.start_offset == null ? null : uint(o.start_offset);
      const endOffset = o.end_offset == null ? null : uint(o.end_offset);
      const para = o.para === undefined || o.para === null ? null : uint(o.para);
      if (
        layoutSignature === undefined || startOffset === undefined || endOffset === undefined ||
        ((startOffset === null) !== (endOffset === null)) ||
        (startOffset !== null && endOffset !== null && endOffset <= startOffset) ||
        spine === undefined ||
        startPage === undefined ||
        endPage === undefined ||
        pages === undefined ||
        startWord === undefined ||
        endWord === undefined ||
        words === undefined ||
        createdAt === undefined ||
        para === undefined ||
        typeof o.text !== 'string' ||
        o.text.length === 0 ||
        Buffer.byteLength(o.text) > MAX_TEXT
      ) {
        return kosyncError(c, 403, 2003, 'Invalid request');
      }
      const chapter = typeof o.chapter === 'string' ? o.chapter.slice(0, MAX_CHAPTER) : '';
      const note =
        typeof o.note === 'string' && Buffer.byteLength(o.note) <= MAX_NOTE ? o.note : null;
      const color = typeof o.color === 'string' ? o.color.slice(0, 32) : null;
      const text = o.text;
      ops.push(() => {
        // An old alias copy may carry annotations or a tombstone that the
        // canonical row has never seen. Preserve it before any new live write.
        const previous = readPrevious.get(user.id, ...documents, id) as ClippingRow | undefined;
        if (previous?.deleted) return;
        const result = upsert.run(
          user.id, canonical, id, spine, startPage, endPage, pages,
          startWord, endWord, words, para, chapter, text,
          Object.hasOwn(o, 'note') ? note : (previous?.note ?? null),
          Object.hasOwn(o, 'color') ? color : (previous?.color ?? null),
          createdAt, now, layoutSignature, startOffset, endOffset, 1, 1
        );
        if (result.changes) highlightIds.add(id);
      });
    }
    withTransaction(db, () => {
      for (const op of ops) {
        bumpRevision.run();
        op();
      }
    });
    // Fan out highlights to connectors that carry them (e.g. Readwise). Best
    // effort; the document's title/author (if synced) become the Readwise book.
    if (highlightIds.size > 0) {
      const meta = documentMeta(db, user.id, canonical);
      const readHighlight = db.prepare(
        `SELECT text, note, created_at, spine_index, start_offset, end_offset, chapter_title
         FROM clippings WHERE user_id = ? AND document = ? AND id = ? AND deleted = 0`
      );
      for (const id of highlightIds) {
        const h = readHighlight.get(user.id, canonical, id) as ClippingHighlightRow | undefined;
        if (!h) continue;
        fanOutHighlight(
          db,
          user.id,
          canonical,
          id,
          highlightFromRow(h, meta),
          now
        );
      }
    }
    return c.json({ until: now, accepted: ops.length });
  });

  return app;
}
