import { decideMatch, type Candidate } from './matching.js';
import {
  ConnectorOperationError,
  type Credential,
  type DocumentMeta,
  type ExternalBook,
  type HttpTransport,
  type Match,
  type OutboundEvent,
  type PushResult,
  type ValidateResult,
  type Connector,
} from './types.js';

const BASE_URL = 'https://micro.blog';
const COMPLETION_THRESHOLD = 0.98;
const RELEVANT = ['reading', 'finished', 'to-read', 'loans', 'holds'] as const;
type ShelfType = (typeof RELEVANT)[number];

interface ShelfDefinition {
  id: string;
  type: ShelfType;
}

interface ShelfBook extends Candidate {
  externalId: string;
  title: string;
  author: string;
  isbn: string | null;
  memberships: Set<ShelfType>;
}

function tokenOf(cred: Credential): string {
  const token = cred.token;
  if (typeof token !== 'string' || !token.trim()) {
    throw new ConnectorOperationError('missing Micro.blog token', false);
  }
  return token.trim();
}

function destination(ev?: OutboundEvent): 'reading' | 'finished' {
  return ev?.kind === 'finished' || (ev?.percentage ?? 0) >= COMPLETION_THRESHOLD
    ? 'finished'
    : 'reading';
}

function operationError(status: number, method: string, path: string): ConnectorOperationError | null {
  const context = `Micro.blog ${method} ${path} failed (${status})`;
  if (status === 401 || status === 403) {
    return new ConnectorOperationError(`${context}: invalid token`, false, true);
  }
  if ((status === 404 && method === 'GET') || status === 429 || status >= 500) {
    return new ConnectorOperationError(context, true);
  }
  if (status >= 400) {
    return new ConnectorOperationError(context, false);
  }
  return null;
}

async function request(
  http: HttpTransport,
  token: string,
  path: string,
  init: { method: string; body?: string; headers?: Record<string, string> }
): Promise<unknown> {
  let response;
  try {
    response = await http(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        ...init.headers,
        ...(init.body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
    });
  } catch (error) {
    if (error instanceof ConnectorOperationError) throw error;
    throw new ConnectorOperationError(`Micro.blog ${init.method} ${path} failed`, true);
  }
  if (response.status === 404 && init.method === 'DELETE') return {};
  const failure = operationError(response.status, init.method, path);
  if (failure) throw failure;
  if (init.method === 'POST') {
    let body: string;
    try {
      body = await response.text();
    } catch {
      throw new ConnectorOperationError('Micro.blog returned malformed JSON', true);
    }
    if (!body.trim()) return {};
    try {
      return JSON.parse(body);
    } catch {
      return {};
    }
  }
  try {
    return await response.json();
  } catch {
    throw new ConnectorOperationError('Micro.blog returned malformed JSON', true);
  }
}

function isShelfType(value: unknown): value is ShelfType {
  return typeof value === 'string' && (RELEVANT as readonly string[]).includes(value);
}

function itemsOf(payload: unknown): unknown[] {
  if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { items?: unknown }).items)) {
    throw new ConnectorOperationError('Micro.blog returned an invalid shelf feed', true);
  }
  return (payload as { items: unknown[] }).items;
}

function authorsOf(value: unknown): string {
  const authors = Array.isArray(value) ? value : [];
  return authors
    .flatMap((author) => author && typeof author === 'object'
      && typeof (author as { name?: unknown }).name === 'string'
      ? [(author as { name: string }).name.trim()]
      : [])
    .filter(Boolean)
    .join(', ');
}

function isbnOf(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const isbn = String(value).trim();
  return isbn || null;
}

async function loadShelves(cred: Credential, http: HttpTransport): Promise<ShelfDefinition[]> {
  const payload = await request(http, tokenOf(cred), '/books/bookshelves', { method: 'GET' });
  return itemsOf(payload).flatMap((item): ShelfDefinition[] => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as { id?: unknown; _microblog?: { type?: unknown } };
    if (raw.id == null || !isShelfType(raw._microblog?.type)) return [];
    const id = String(raw.id).trim();
    return id ? [{ id, type: raw._microblog.type }] : [];
  });
}

function extractBooks(payload: unknown, membership: ShelfType): ShelfBook[] {
  return itemsOf(payload).flatMap((item): ShelfBook[] => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as {
      id?: unknown;
      title?: unknown;
      authors?: unknown;
      _microblog?: { isbn?: unknown };
    };
    if (raw.id == null || typeof raw.title !== 'string' || !raw.title.trim()) return [];
    const externalId = String(raw.id).trim();
    if (!externalId) return [];
    const author = authorsOf(raw.authors);
    return [{
      externalId,
      title: raw.title,
      author,
      isbn: isbnOf(raw._microblog?.isbn),
      memberships: new Set([membership]),
    }];
  });
}

async function loadBooks(
  cred: Credential,
  shelf: ShelfDefinition,
  http: HttpTransport
): Promise<ShelfBook[]> {
  const payload = await request(http, tokenOf(cred), `/books/bookshelves/${encodeURIComponent(shelf.id)}`, {
    method: 'GET',
  });
  return extractBooks(payload, shelf.type);
}

async function loadInventoryForShelves(
  cred: Credential,
  shelves: ShelfDefinition[],
  http: HttpTransport
): Promise<ShelfBook[]> {
  const byId = new Map<string, ShelfBook>();
  for (const shelf of shelves) {
    for (const book of await loadBooks(cred, shelf, http)) {
      const existing = byId.get(book.externalId);
      if (existing) existing.memberships.add(shelf.type);
      else byId.set(book.externalId, book);
    }
  }
  return [...byId.values()];
}

async function loadInventory(cred: Credential, http: HttpTransport): Promise<ShelfBook[]> {
  return loadInventoryForShelves(cred, await loadShelves(cred, http), http);
}

async function validateCredential(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  try {
    await loadShelves(cred, http);
    return { ok: true };
  } catch (error) {
    if (error instanceof ConnectorOperationError && error.needsReauth) {
      return { ok: false, error: 'invalid token' };
    }
    return { ok: false, error: error instanceof Error ? error.message : 'Micro.blog request failed' };
  }
}

async function searchBooks(
  cred: Credential,
  query: string,
  http: HttpTransport
): Promise<ExternalBook[]> {
  const payload = await request(
    http,
    tokenOf(cred),
    `/books/search?q=${encodeURIComponent(query)}&format=jsonfeed`,
    { method: 'GET', headers: { accept: 'application/json' } }
  );
  return itemsOf(payload).flatMap((item) => {
    if (!item || typeof item !== 'object') return [];
    const raw = item as {
      id?: unknown;
      title?: unknown;
      authors?: unknown;
      _microblog?: { isbn?: unknown };
    };
    if ((typeof raw.id !== 'string' && typeof raw.id !== 'number')
      || typeof raw.title !== 'string' || !raw.title.trim()) return [];
    const externalId = String(raw.id).trim();
    if (!externalId) return [];
    const author = authorsOf(raw.authors);
    return [{
      externalId,
      title: raw.title,
      author: author || null,
      edition: isbnOf(raw._microblog?.isbn),
    }];
  });
}

async function matchBook(
  cred: Credential,
  doc: DocumentMeta,
  http: HttpTransport,
  ev?: OutboundEvent
): Promise<Match | null> {
  const title = doc.title?.trim();
  const author = doc.author?.trim();
  if (!title || !author) return null;
  const inventory = await loadInventory(cred, http);
  const target = destination(ev);
  const opposite = target === 'reading' ? 'finished' : 'reading';
  const order: ShelfType[] = [target, opposite, 'to-read', 'loans', 'holds'];
  const candidates: ShelfBook[] = [];
  const seenIds = new Set<string>();
  for (const shelfType of order) {
    for (const book of inventory) {
      if (book.memberships.has(shelfType) && !seenIds.has(book.externalId)) {
        seenIds.add(book.externalId);
        candidates.push(book);
      }
    }
  }
  const decision = decideMatch(title, author, candidates);
  if (!decision.accepted || !decision.best) return null;
  return {
    externalId: decision.best.externalId,
    externalEdition: candidates.find((book) => book.externalId === decision.best!.externalId)?.isbn,
    confidence: decision.best.score,
    title: decision.best.title,
    author: decision.best.author ?? null,
  };
}

function responseId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as { id?: unknown; book_id?: unknown; item?: { id?: unknown }; book?: { id?: unknown } };
  const id = raw.id ?? raw.book_id ?? raw.item?.id ?? raw.book?.id;
  if (typeof id !== 'string' && typeof id !== 'number') return null;
  const value = String(id).trim();
  return value || null;
}

async function createBook(
  cred: Credential,
  doc: DocumentMeta,
  ev: OutboundEvent,
  http: HttpTransport
): Promise<Match | null> {
  const title = doc.title?.trim();
  const author = doc.author?.trim();
  if (!title || !author) return null;
  const target = destination(ev);
  const shelf = (await loadShelves(cred, http)).find((item) => item.type === target);
  if (!shelf) {
    throw new ConnectorOperationError(`Micro.blog ${target} shelf is unavailable`, false);
  }
  const payload = await request(http, tokenOf(cred), '/books', {
    method: 'POST',
    body: new URLSearchParams({ title, author, bookshelf_id: shelf.id }).toString(),
  });
  const id = responseId(payload);
  if (id) return { externalId: id, confidence: 1, title, author };
  const recovered = decideMatch(title, author, await loadBooks(cred, shelf, http));
  if (recovered.accepted && recovered.best) {
    return {
      externalId: recovered.best.externalId,
      confidence: recovered.best.score,
      title: recovered.best.title,
      author: recovered.best.author ?? null,
    };
  }
  throw new ConnectorOperationError('Micro.blog created the book but did not return or expose its id', false);
}

async function reconcileBook(
  cred: Credential,
  match: Match,
  ev: OutboundEvent,
  http: HttpTransport
): Promise<PushResult> {
  const target = destination(ev);
  const opposite = target === 'reading' ? 'finished' : 'reading';
  const shelves = await loadShelves(cred, http);
  const shelfByType = new Map(shelves.map((shelf) => [shelf.type, shelf]));
  const targetShelf = shelfByType.get(target);
  if (!targetShelf) {
    throw new ConnectorOperationError(`Micro.blog ${target} shelf is unavailable`, false);
  }

  const inventory = await loadInventoryForShelves(cred, shelves, http);
  const isbnHint = match.externalEdition
    ?? (/^(?:\d{13}|\d{9}[\dXx])$/.test(match.externalId) ? match.externalId : null);
  const inventoryBook = inventory.find((book) => book.externalId === match.externalId)
    ?? (isbnHint
      ? inventory.find((book) => book.isbn === isbnHint)
      : undefined);
  const memberships = inventoryBook?.memberships ?? new Set<ShelfType>();
  const bookId = inventoryBook?.externalId ?? match.externalId;
  const token = tokenOf(cred);
  if (!memberships.has(target)) {
    const assignment = new URLSearchParams();
    if (inventoryBook || !isbnHint) assignment.set('book_id', bookId);
    else assignment.set('isbn', isbnHint);
    await request(http, token, `/books/bookshelves/${encodeURIComponent(targetShelf.id)}/assign`, {
      method: 'POST',
      body: assignment.toString(),
    });
  }
  for (const shelfType of ['to-read', opposite] as const) {
    if (!memberships.has(shelfType)) continue;
    const shelf = shelfByType.get(shelfType);
    if (!shelf) continue;
    await request(http, token, `/books/bookshelves/${encodeURIComponent(shelf.id)}/remove/${encodeURIComponent(bookId)}`, {
      method: 'DELETE',
    });
  }
  return { ok: true };
}

function shouldPush(ev: OutboundEvent, canonicalPercentage?: number | null): boolean {
  if (ev.kind === 'progress' && (ev.percentage ?? 0) <= 0) return false;
  if (canonicalPercentage == null) return true;
  if (canonicalPercentage <= 0) return false;
  const canonicalDestination = canonicalPercentage >= COMPLETION_THRESHOLD ? 'finished' : 'reading';
  return destination(ev) === canonicalDestination;
}

export const microblogConnector: Connector = {
  id: 'microblog',
  displayName: 'Micro.blog',
  tier: 1,
  capabilities: { read: false, write: true },
  carries: ['progress', 'finished'],
  credentialKind: 'token',
  beta: false,
  matchBy: 'metadata',
  shouldPush,
  validate: validateCredential,
  search: searchBooks,
  match: matchBook,
  createBook,
  push: reconcileBook,
};

export const _microblog = {
  validateCredential,
  extractBooks,
  matchBook,
  createBook,
  reconcileBook,
  destination,
};
