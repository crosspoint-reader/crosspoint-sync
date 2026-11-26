import type { HttpTransport } from '../connectors/types.js';
import { escapeXml } from '../connectors/kindle-fiona.js';
import { withTransaction, type DB } from '../db/db.js';
import type { IssueArticle } from './newspaper.js';

const BASE = 'https://news.kagi.com/api/batches';
const KAGI = 'https://news.kagi.com/';
const FRESH_MS = 36 * 60 * 60_000;
const MAX_RESPONSE = 2 * 1024 * 1024;
const MAX_CATEGORIES = 5;
const DAY_MS = 86_400_000;
const UUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const SLUG = /^[a-z\d][a-z\d_-]{0,79}$/i;

interface Batch { id: string; createdAt: string }
interface Category { id: string; name: string; uuid: string }
interface Source { url: string; label: string }
interface Story { key: string; title: string; summary: string; language?: string; sources: Source[] }
interface Snapshot { issue: string; categories: string; articles: string; missing: string }

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '').trim() : '';
}

function source(value: unknown): Source | undefined {
  const item = record(value);
  const link = str(item.link);
  if (!link || link.length > 2048) return;
  try {
    const url = new URL(link);
    if (url.protocol !== 'https:' || url.username || url.password) return;
    url.hash = '';
    return { url: url.href, label: str(item.domain).slice(0, 160) || url.hostname };
  } catch { return; }
}

function stories(value: unknown, batch: Batch, category: Category): Story[] {
  const payload = record(value);
  if (payload.batchId !== batch.id || payload.categoryId !== category.uuid || !Array.isArray(payload.stories)) {
    throw new Error('Invalid Kagi stories');
  }
  return payload.stories.slice(0, 20).flatMap((item): Story[] => {
    const row = record(item);
    const title = str(row.title);
    const summary = str(row.short_summary);
    const id = str(row.id);
    if (!title || title.length > 500 || !summary || summary.length > 5000 ||
        (!id && !Number.isSafeInteger(row.cluster_number))) return [];
    const lang = str(row.translationAvailable === false ? row.sourceLanguage : row.selectedLanguage);
    const sources = Array.isArray(row.articles)
      ? [...new Map(row.articles.slice(0, 100).map(source).filter((s): s is Source => !!s)
        .map((s) => [s.url, s])).values()]
      : [];
    const key = id ? 'story:' + id : category.id + ':' + row.cluster_number;
    return [{ key, title, summary, language: /^[a-z]{2,3}(-[a-z\d]{2,8})*$/i.test(lang) ? lang : undefined, sources }];
  });
}

async function json(http: HttpTransport, url: string): Promise<unknown> {
  const response = await http(url, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(2000),
    headers: { Accept: 'application/json', 'User-Agent': 'CrossPoint-Sync (CrossPaper)' },
  });
  if (response.status !== 200 || Number(response.headers?.get('content-length')) > MAX_RESPONSE) {
    await response.body?.cancel();
    throw new Error('Kagi News is unavailable');
  }
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_RESPONSE) throw new Error('Kagi response too large');
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_RESPONSE) {
        await reader.cancel();
        throw new Error('Kagi response too large');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export function kagiProvider(http: HttpTransport) {
  const cache = new Map<string, { until: number; result: Promise<unknown> }>();
  let pausedUntil = 0;

  function cached<T>(key: string, ttl: number, load: () => Promise<T>, stale = false): Promise<T> {
    const previous = cache.get(key);
    if (previous && previous.until > Date.now()) return previous.result as Promise<T>;
    if (Date.now() < pausedUntil) {
      if (stale && previous) return previous.result as Promise<T>;
      return Promise.reject(new Error('Kagi News is temporarily unavailable'));
    }
    const entry = { until: Infinity, result: load().then((value) => {
      entry.until = Date.now() + ttl;
      return value;
    }).catch((error) => {
      pausedUntil = Date.now() + 30_000;
      if (stale && previous) {
        entry.until = pausedUntil;
        return previous.result;
      }
      cache.delete(key);
      throw error;
    }) };
    if (cache.size >= 256) {
      for (const [id, value] of cache) {
        if (value.until < Date.now()) cache.delete(id);
        if (cache.size < 256) break;
      }
      if (cache.size >= 256) cache.delete(cache.keys().next().value!);
    }
    cache.set(key, entry);
    return entry.result as Promise<T>;
  }

  const latest = () => cached<Batch>('latest', 5 * 60_000, async () => {
    const row = record(await json(http, BASE + '/latest'));
    const id = str(row.id);
    const date = Date.parse(str(row.createdAt));
    if (!UUID.test(id) || !Number.isFinite(date) || date > Date.now() + 5 * 60_000) throw new Error('Invalid Kagi batch');
    return { id, createdAt: new Date(date).toISOString() };
  }, true);

  const categories = (batch: Batch) => cached<Category[]>(batch.id, 30 * 60_000, async () => {
    const row = record(await json(http, BASE + '/' + batch.id + '/categories'));
    if (row.batchId !== batch.id || !Array.isArray(row.categories)) throw new Error('Invalid Kagi categories');
    const categories = new Map<string, Category>();
    for (const item of row.categories.slice(0, 1000)) {
      const category = record(item);
      const id = str(category.categoryId);
      const uuid = str(category.id);
      const name = str(category.categoryName);
      if (SLUG.test(id) && UUID.test(uuid) && name && name.length <= 160 && !categories.has(id)) {
        categories.set(id, { id, uuid, name });
      }
    }
    return [...categories.values()];
  }, true);

  return {
    latest, categories,
    stories: (batch: Batch, category: Category) => cached(
      batch.id + ':' + category.uuid, 30 * 60_000,
      async () => stories(await json(http, BASE + '/' + batch.id + '/categories/' + category.uuid + '/stories?lang=en&limit=20'), batch, category),
      true,
    ),
  };
}

export function kagiSettings(db: DB, userId: number): string[] {
  const row = db.prepare('SELECT categories FROM news_kagi_settings WHERE user_id = ?').get(userId);
  return row ? JSON.parse(String(row.categories)) : [];
}

export function saveKagiSettings(db: DB, userId: number, value: unknown): boolean {
  if (!Array.isArray(value) || value.length > MAX_CATEGORIES ||
      value.some((id) => typeof id !== 'string' || !SLUG.test(id)) || new Set(value).size !== value.length) return false;
  if (!value.length) db.prepare('DELETE FROM news_kagi_settings WHERE user_id = ?').run(userId);
  else db.prepare(`INSERT INTO news_kagi_settings (user_id, categories) VALUES (?, ?)
    ON CONFLICT(user_id) DO UPDATE SET categories = excluded.categories`).run(userId, JSON.stringify(value));
  return true;
}

export function kagiIssues(db: DB, userId: number, today: string): Snapshot[] {
  const cutoff = new Date(Date.parse(today) - 14 * DAY_MS).toISOString().slice(0, 10);
  db.prepare('DELETE FROM news_kagi_issues WHERE user_id = ? AND issue < ?').run(userId, cutoff);
  return db.prepare('SELECT issue, categories, articles, missing FROM news_kagi_issues WHERE user_id = ? ORDER BY issue DESC')
    .all(userId) as unknown as Snapshot[];
}

export function kagiArticles(snapshot?: Snapshot): IssueArticle[] {
  return snapshot ? JSON.parse(snapshot.articles) : [];
}

function toArticle(story: Story, category: Category, batch: Batch): IssueArticle {
  const links = story.sources.slice(0, 3).map(({ url, label }) =>
    `<a href="${escapeXml(url)}">${escapeXml(label)}</a>`).join(' · ');
  return {
    title: story.title,
    byline: 'Kagi News · ' + batch.createdAt.slice(0, 10) + ' edition',
    section: 'Kagi News',
    category: category.name,
    provider: 'kagi',
    language: story.language,
    url: KAGI,
    content: `<p>${escapeXml(story.summary)}</p>` +
      (links ? `<p>Sources · ${links}</p>` : '') +
      `<p>Summary by <a href="${KAGI}">Kagi News</a> · <a href="${KAGI}api-docs">Data terms</a></p>`,
  };
}

export async function assignKagiIssue(db: DB, userId: number, today: string, provider: ReturnType<typeof kagiProvider>): Promise<void> {
  const selected = kagiSettings(db, userId);
  const existing = () => db.prepare('SELECT 1 FROM news_kagi_issues WHERE user_id = ? AND issue = ?').get(userId, today);
  if (!selected.length || existing()) return;
  const batch = await provider.latest();
  if (Date.now() - Date.parse(batch.createdAt) > FRESH_MS) return;
  const catalog = await provider.categories(batch);
  const used = () => new Set(db.prepare('SELECT categories FROM news_kagi_issues WHERE user_id = ? AND batch_id = ?')
    .all(userId, batch.id).flatMap((row) => JSON.parse(String(row.categories)) as string[]));
  const already = used();
  const eligible = selected.filter((id) => !already.has(id));
  const results = await Promise.allSettled(eligible.map(async (id) => {
    const category = catalog.find((entry) => entry.id === id);
    if (!category) throw new Error('Kagi category unavailable');
    return { category, stories: await provider.stories(batch, category) };
  }));
  withTransaction(db, () => {
    if (existing() || JSON.stringify(kagiSettings(db, userId)) !== JSON.stringify(selected)) return;
    const usedNow = used();
    const categories: string[] = [];
    const articles: IssueArticle[] = [];
    const missing: string[] = [];
    const seen = new Set<string>();
    for (const [index, result] of results.entries()) {
      const id = eligible[index];
      if (usedNow.has(id) || articles.length >= 15) continue;
      if (result.status === 'rejected' || !result.value.stories.length) {
        missing.push(id);
        continue;
      }
      const { category, stories } = result.value;
      let count = 0;
      for (const story of stories) {
        if (seen.has(story.key) || story.sources.some(({ url }) => seen.has(url))) continue;
        seen.add(story.key);
        for (const { url } of story.sources) seen.add(url);
        articles.push(toArticle(story, category, batch));
        if (++count === 5 || articles.length === 15) break;
      }
      if (count) categories.push(id);
    }
    if (articles.length) db.prepare(`INSERT INTO news_kagi_issues (user_id, issue, batch_id, categories, articles, missing)
      VALUES (?, ?, ?, ?, ?, ?)`).run(userId, today, batch.id, JSON.stringify(categories), JSON.stringify(articles), JSON.stringify(missing));
  });
}
