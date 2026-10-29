import { describe, expect, it } from 'vitest';
import { _microblog, microblogConnector } from '../src/connectors/microblog.js';
import type { HttpTransport } from '../src/connectors/types.js';
import { makeMicroblogTransport } from './microblog-helpers.js';

const CRED = { token: 'mb-token' };
const DOC = {
  document: 'd', title: 'The Left Hand of Darkness',
  author: 'Ursula K. Le Guin', filename: null,
};
const EV = { kind: 'progress' as const, document: 'd', percentage: 0.4, timestamp: 1 };

describe('Micro.blog shelf lookup', () => {
  it('records a server-verified default blog so rotating a token preserves publication identity', async () => {
    const cred: Record<string, unknown> = { token: 'mb-token', microblogDestination: 'https://untrusted.example/' };
    const fake = makeMicroblogTransport();
    const http: HttpTransport = async (url, init) => {
      if (url === 'https://micro.blog/micropub?q=config') return {
        status: 200, text: async () => '', json: async () => ({ destination: [
          { uid: 'https://other.micro.blog/', 'microblog-default': false },
          { uid: 'https://example.micro.blog/', 'microblog-default': true },
        ] }),
      };
      return fake.transport(url, init);
    };
    expect((await _microblog.validateCredential(cred, http)).ok).toBe(true);
    expect(cred.microblogDestination).toBe('https://example.micro.blog/');
  });
  it('validates an app token against the bookshelves endpoint', async () => {
    const fake = makeMicroblogTransport();
    expect(await _microblog.validateCredential(CRED, fake.transport)).toEqual({ ok: true });
    expect(fake.calls[0]).toMatchObject({
      url: 'https://micro.blog/books/bookshelves', method: 'GET',
      headers: { authorization: 'Bearer mb-token' },
    });
  });

  it('rejects a missing token and an unauthorized token', async () => {
    const fake = makeMicroblogTransport();
    expect((await _microblog.validateCredential({}, fake.transport)).ok).toBe(false);
    fake.fail('GET', '/books/bookshelves', 401);
    expect(await _microblog.validateCredential(CRED, fake.transport)).toEqual({
      ok: false, error: 'invalid token',
    });
  });

  it('prefers destination, opposite, want, loans, then holds', async () => {
    const wanted = { id: '30', title: DOC.title!, author: DOC.author! };
    const loan = { ...wanted, id: '31' };
    const fake = makeMicroblogTransport({ shelves: { 'to-read': [wanted], loans: [loan] } });
    expect((await _microblog.matchBook(CRED, DOC, fake.transport, EV))?.externalId).toBe('30');
  });

  it('treats absent optional Libby shelves as empty', async () => {
    const wanted = { id: '32', title: DOC.title!, author: DOC.author! };
    const fake = makeMicroblogTransport({
      shelves: { 'to-read': [wanted] }, omitShelves: ['loans', 'holds'],
    });
    expect((await _microblog.matchBook(CRED, DOC, fake.transport, EV))?.externalId).toBe('32');
  });

  it('matches normalized title and author and collapses repeated ids', async () => {
    const book = { id: '40', title: 'The Left Hand of Darkness: A Novel', author: 'Le Guin, Ursula K.' };
    const fake = makeMicroblogTransport({ shelves: { loans: [book], holds: [book] } });
    const match = await _microblog.matchBook(CRED, DOC, fake.transport, EV);
    expect(match?.externalId).toBe('40');
  });

  it('joins multiple API author names for matching', () => {
    expect(_microblog.extractBooks({
      items: [{ id: 5, title: 'Good Omens', authors: [{ name: 'Neil Gaiman' }, { name: 'Terry Pratchett' }] }],
    }, 'reading')).toEqual([{
      externalId: '5', title: 'Good Omens', author: 'Neil Gaiman, Terry Pratchett',
      isbn: null,
      memberships: new Set(['reading']),
    }]);
  });

  it.each([
    [{ ...DOC, title: null }],
    [{ ...DOC, author: null }],
    [{ ...DOC, author: '   ' }],
  ])('does not auto-match incomplete metadata', async (doc) => {
    const fake = makeMicroblogTransport({ shelves: { reading: [{ id: '1', title: DOC.title!, author: DOC.author! }] } });
    expect(await _microblog.matchBook(CRED, doc, fake.transport, EV)).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });
});

describe('Micro.blog book search', () => {
  it('searches the JSON Feed with authentication and maps result IDs and authors', async () => {
    let request: { url: string; headers?: Record<string, string> } | undefined;
    const transport: HttpTransport = async (url, init) => {
      request = { url, headers: init.headers };
      const body = {
        version: 'https://jsonfeed.org/version/1.1',
        items: [
          {
            id: 37779109,
            title: 'The Hobbit: Or There and Back Again',
            authors: [{ name: 'J.R.R. Tolkien' }],
            _microblog: { isbn: '9780547951973' },
          },
          {
            id: '9780547928227',
            title: 'The Hobbit, Or, There and Back Again',
            authors: [{ name: 'J. R. R. Tolkien' }, { name: 'Christopher Tolkien' }],
            _microblog: { isbn: '9780547928227' },
          },
          { id: null, title: 'Missing ID', authors: [] },
        ],
      };
      return {
        status: 200,
        text: async () => JSON.stringify(body),
        json: async () => body,
      };
    };

    expect(microblogConnector.search).toBeTypeOf('function');
    if (!microblogConnector.search) return;
    expect(await microblogConnector.search(CRED, 'The Hobbit & friends', transport)).toEqual([
      {
        externalId: '37779109',
        title: 'The Hobbit: Or There and Back Again',
        author: 'J.R.R. Tolkien',
        edition: '9780547951973',
      },
      {
        externalId: '9780547928227',
        title: 'The Hobbit, Or, There and Back Again',
        author: 'J. R. R. Tolkien, Christopher Tolkien',
        edition: '9780547928227',
      },
    ]);
    const url = new URL(request!.url);
    expect(url.origin + url.pathname).toBe('https://micro.blog/books/search');
    expect(url.searchParams.get('q')).toBe('The Hobbit & friends');
    expect(url.searchParams.get('format')).toBe('jsonfeed');
    expect(request!.headers).toMatchObject({
      authorization: 'Bearer mb-token',
      accept: 'application/json',
    });
  });
});

describe('Micro.blog book creation', () => {
  it('creates directly on the event destination shelf', async () => {
    const fake = makeMicroblogTransport({ createResponse: { id: 90 } });
    const match = await _microblog.createBook(CRED, DOC, EV, fake.transport);
    expect(match?.externalId).toBe('90');
    const create = fake.calls.find((call) => call.url.endsWith('/books') && call.method === 'POST');
    expect(new URLSearchParams(create!.body!).get('bookshelf_id')).toBe('10');
    expect(new URLSearchParams(create!.body!).get('title')).toBe(DOC.title);
    expect(new URLSearchParams(create!.body!).get('author')).toBe(DOC.author);
  });

  it.each([
    ['book_id', { book_id: 91 }, '91'],
    ['item.id', { item: { id: '92' } }, '92'],
    ['book.id', { book: { id: 93 } }, '93'],
  ])('accepts a successful create response id from %s', async (_shape, createResponse, expectedId) => {
    const fake = makeMicroblogTransport({ createResponse });
    fake.disableCreateMutation();

    expect((await _microblog.createBook(CRED, DOC, EV, fake.transport))?.externalId).toBe(expectedId);
    expect(fake.calls.filter((call) => call.url.endsWith('/books/bookshelves/10'))).toHaveLength(0);
  });

  it('recovers the new id from the destination shelf when the response omits it', async () => {
    const fake = makeMicroblogTransport({ createResponse: {} });
    expect((await _microblog.createBook(CRED, DOC, EV, fake.transport))?.externalId).toBeTruthy();
    expect(fake.calls.filter((call) => call.url.endsWith('/books/bookshelves/10'))).toHaveLength(1);
  });

  it('recovers the new id after an empty 204 create response', async () => {
    const fake = makeMicroblogTransport({ createResponse: '', createStatus: 204 });
    expect((await _microblog.createBook(CRED, DOC, EV, fake.transport))?.externalId).toBe('1000');
    expect(fake.calls.filter((call) => call.url.endsWith('/books/bookshelves/10'))).toHaveLength(1);
  });

  it('recovers the new id after a successful non-JSON create response', async () => {
    const fake = makeMicroblogTransport({ createResponse: 'Created' });
    expect((await _microblog.createBook(CRED, DOC, EV, fake.transport))?.externalId).toBe('1000');
    expect(fake.calls.filter((call) => call.url.endsWith('/books/bookshelves/10'))).toHaveLength(1);
  });

  it('classifies successful create body read failures as retryable', async () => {
    const fake = makeMicroblogTransport();
    const transport: HttpTransport = async (url, init) => {
      const response = await fake.transport(url, init);
      if (init.method !== 'POST' || !url.endsWith('/books')) return response;
      return { ...response, text: async () => { throw new Error('body stream interrupted'); } };
    };
    await expect(_microblog.createBook(CRED, DOC, EV, transport)).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('does not create with incomplete metadata', async () => {
    const fake = makeMicroblogTransport();
    expect(await _microblog.createBook(CRED, { ...DOC, author: null }, EV, fake.transport)).toBeNull();
    expect(fake.calls).toHaveLength(0);
  });

  it('fails permanently when creation cannot recover a real id', async () => {
    const fake = makeMicroblogTransport({ createResponse: {} });
    fake.shelves.set('reading', []);
    fake.disableCreateMutation();
    await expect(_microblog.createBook(CRED, DOC, EV, fake.transport)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('fails permanently when the destination shelf is absent', async () => {
    const fake = makeMicroblogTransport({ omitShelves: ['reading'] });
    await expect(_microblog.createBook(CRED, DOC, EV, fake.transport)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('treats a malformed successful shelf feed as retryable', async () => {
    const fake = makeMicroblogTransport();
    fake.fail('GET', '/books/bookshelves', 200, { unexpected: true });
    await expect(_microblog.createBook(CRED, DOC, EV, fake.transport)).rejects.toMatchObject({
      retryable: true,
    });
  });
});

describe('Micro.blog shelf reconciliation', () => {
  const book = { id: '50', title: DOC.title!, author: DOC.author! };

  it('assigns currently reading before removing want to read', async () => {
    const fake = makeMicroblogTransport({ shelves: { 'to-read': [book] } });
    expect(await _microblog.reconcileBook(CRED, { externalId: '50', confidence: 1 }, EV, fake.transport)).toEqual({ ok: true });
    expect(fake.shelves.get('reading')).toContainEqual(book);
    expect(fake.shelves.get('to-read')).not.toContainEqual(book);
    const writes = fake.calls.filter((call) => call.method !== 'GET');
    expect(writes.map((call) => call.method)).toEqual(['POST', 'DELETE']);
    expect(writes[0].url).toContain('/books/bookshelves/10/assign');
    expect(writes[1].url).toContain('/books/bookshelves/12/remove/50');
  });

  it('assigns a catalog search result by ISBN instead of treating its feed ID as a book ID', async () => {
    const fake = makeMicroblogTransport({
      searchItems: [{
        id: '9780547928227',
        title: 'The Hobbit, Or, There and Back Again',
        authors: [{ name: 'J. R. R. Tolkien' }],
        _microblog: { isbn: '9780547928227' },
      }],
    });
    const match = {
      externalId: '9780547928227',
      confidence: 1,
    };

    await expect(_microblog.reconcileBook(CRED, match, EV, fake.transport)).resolves.toEqual({ ok: true });
    const assignment = fake.calls.find((call) => call.method === 'POST');
    expect(new URLSearchParams(assignment?.body).get('isbn')).toBe('9780547928227');
    expect(new URLSearchParams(assignment?.body).has('book_id')).toBe(false);
    expect(fake.shelves.get('reading')).toContainEqual({
      id: '1000',
      isbn: '9780547928227',
      title: 'The Hobbit, Or, There and Back Again',
      author: 'J. R. R. Tolkien',
    });

    fake.clearCalls();
    await _microblog.reconcileBook(CRED, match, {
      kind: 'finished', document: 'd', percentage: 1, timestamp: 2,
    }, fake.transport);
    expect(fake.shelves.get('reading')).toHaveLength(0);
    expect(fake.shelves.get('finished')).toHaveLength(1);
    const writes = fake.calls.filter((call) => call.method !== 'GET');
    expect(new URLSearchParams(writes[0].body).get('book_id')).toBe('1000');
    expect(writes[1].url).toContain('/books/bookshelves/10/remove/1000');
  });

  it('assigns by the ISBN hint when a catalog result has a separate numeric feed ID', async () => {
    const fake = makeMicroblogTransport({
      searchItems: [{
        id: 37779109,
        title: 'The Hobbit: Or There and Back Again',
        authors: [{ name: 'J.R.R. Tolkien' }],
        _microblog: { isbn: '9780547951973' },
      }],
    });

    await _microblog.reconcileBook(CRED, {
      externalId: '37779109',
      externalEdition: '9780547951973',
      confidence: 1,
    }, EV, fake.transport);

    const assignment = fake.calls.find((call) => call.method === 'POST');
    expect(new URLSearchParams(assignment?.body).get('isbn')).toBe('9780547951973');
    expect(new URLSearchParams(assignment?.body).has('book_id')).toBe(false);
  });

  it('moves a currently reading book to finished', async () => {
    const fake = makeMicroblogTransport({ shelves: { reading: [book] } });
    const finished = { kind: 'finished' as const, document: 'd', percentage: 1, timestamp: 2 };
    await _microblog.reconcileBook(CRED, { externalId: '50', confidence: 1 }, finished, fake.transport);
    expect(fake.shelves.get('finished')).toContainEqual(book);
    expect(fake.shelves.get('reading')).not.toContainEqual(book);
  });

  it('moves a finished book back to currently reading for a later partial event', async () => {
    const fake = makeMicroblogTransport({ shelves: { finished: [book] } });
    await _microblog.reconcileBook(CRED, { externalId: '50', confidence: 1 }, EV, fake.transport);
    expect(fake.shelves.get('reading')).toContainEqual(book);
    expect(fake.shelves.get('finished')).not.toContainEqual(book);
  });

  it('preserves loans and holds while assigning reading', async () => {
    const fake = makeMicroblogTransport({ shelves: { loans: [book], holds: [book] } });
    await _microblog.reconcileBook(CRED, { externalId: '50', confidence: 1 }, EV, fake.transport);
    expect(fake.shelves.get('loans')).toContainEqual(book);
    expect(fake.shelves.get('holds')).toContainEqual(book);
    expect(fake.calls.filter((call) => call.method === 'DELETE')).toHaveLength(0);
  });

  it('does no writes when already in the desired managed state', async () => {
    const fake = makeMicroblogTransport({ shelves: { reading: [book] } });
    await _microblog.reconcileBook(CRED, { externalId: '50', confidence: 1 }, EV, fake.transport);
    expect(fake.calls.filter((call) => call.method !== 'GET')).toHaveLength(0);
  });

  it('retries a transient 404 while loading a bookshelf and reports only safe request context', async () => {
    const fake = makeMicroblogTransport({ shelves: { reading: [book] } });
    fake.fail('GET', '/books/bookshelves/10', 404);

    const error = await _microblog
      .reconcileBook({ token: 'secret-token-that-must-not-leak' }, { externalId: '50', confidence: 1 }, EV, fake.transport)
      .catch((caught) => caught);

    expect(error).toMatchObject({
      message: 'Micro.blog GET /books/bookshelves/10 failed (404)',
      retryable: true,
      needsReauth: false,
    });
    expect(error.message).not.toContain('secret-token-that-must-not-leak');
  });

  it('treats a 404 removal as an idempotent success', async () => {
    const fake = makeMicroblogTransport({ shelves: { 'to-read': [book] } });
    fake.fail('DELETE', '/books/bookshelves/12/remove/50', 404);

    await expect(
      _microblog.reconcileBook(CRED, { externalId: '50', confidence: 1 }, EV, fake.transport)
    ).resolves.toEqual({ ok: true });
  });

  it('keeps an assignment 404 permanent and includes the safe request path', async () => {
    const fake = makeMicroblogTransport({ shelves: { 'to-read': [book] } });
    fake.fail('POST', '/books/bookshelves/10/assign', 404);

    await expect(
      _microblog.reconcileBook(CRED, { externalId: '50', confidence: 1 }, EV, fake.transport)
    ).rejects.toMatchObject({
      message: 'Micro.blog POST /books/bookshelves/10/assign failed (404)',
      retryable: false,
    });
  });

  it('classifies authentication, rate-limit, server, and request failures', async () => {
    for (const [status, retryable, needsReauth] of [
      [401, false, true], [403, false, true], [429, true, false],
      [500, true, false], [422, false, false],
    ] as const) {
      const fake = makeMicroblogTransport({ shelves: { reading: [book] } });
      fake.fail('GET', '/books/bookshelves', status);
      await expect(
        _microblog.reconcileBook(CRED, { externalId: '50', confidence: 1 }, EV, fake.transport)
      ).rejects.toMatchObject({ retryable, needsReauth });
    }
  });
});
