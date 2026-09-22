import { decideMatch, extractTitleAuthor, type Candidate } from './matching.js';
import type {
  Connector,
  Credential,
  DocumentMeta,
  ExternalBook,
  HttpTransport,
  Match,
  OutboundEvent,
  PushResult,
  ValidateResult,
} from './types.js';

/**
 * Hardcover connector (Tier 1). Public GraphQL API, per-user bearer token.
 * Carries reading progress + shelf status.
 *
 * !!! LIVE-VERIFY GATE !!!
 * Hardcover's API is beta. The GraphQL operations below (field names, the
 * `me`/search shapes, and the user_book mutation names/status ids) are modeled
 * from the documented schema but MUST be checked against the live GraphQL
 * explorer at https://hardcover.app/account/api before enabling in production.
 * Every network call is funneled through gql() so the exact queries live in one
 * place and are covered by fixture tests. Search the file for GATE to find each
 * spot that needs confirmation.
 */

const ENDPOINT = 'https://api.hardcover.app/v1/graphql';

// GATE: confirm Hardcover's user_book status ids (want-to-read/reading/read).
const STATUS_READING = 2;
const STATUS_READ = 3;

interface HardcoverCred extends Credential {
  token: string;
}

function tokenOf(cred: Credential): string {
  const t = (cred as HardcoverCred).token;
  if (typeof t !== 'string' || t.length === 0) throw new Error('missing hardcover token');
  return t;
}

async function gql(
  http: HttpTransport,
  token: string,
  query: string,
  variables: Record<string, unknown>
): Promise<{ data?: any; errors?: { message: string }[]; status: number }> {
  const res = await http(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  if (res.status === 401 || res.status === 403) {
    return { status: res.status, errors: [{ message: 'unauthorized' }] };
  }
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, data: body.data, errors: body.errors };
}

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  try {
    const token = tokenOf(cred);
    // GATE: confirm the `me` query shape.
    const r = await gql(http, token, `query { me { username } }`, {});
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'invalid token' };
    if (r.errors?.length) return { ok: false, error: r.errors[0].message };
    const username = r.data?.me?.[0]?.username ?? r.data?.me?.username;
    // No username means the API did not recognize the token even though the
    // request itself succeeded (Hardcover returns 200 with empty data for some
    // bad-token shapes). Treat it as a failed link so the user finds out now,
    // not silently at sync time.
    if (!username) return { ok: false, error: 'token not recognized by Hardcover' };
    return { ok: true, accountLabel: username };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function match(
  cred: Credential,
  doc: DocumentMeta,
  http: HttpTransport
): Promise<Match | null> {
  const ta = extractTitleAuthor(doc);
  if (!ta) return null;
  const token = tokenOf(cred);
  const q = `${ta.title} ${ta.author}`.trim();
  // GATE: confirm Hardcover's search query name and result shape.
  const r = await gql(
    http,
    token,
    `query Search($q: String!) {
       search(query: $q, query_type: "Book", per_page: 10) {
         results
       }
     }`,
    { q }
  );
  if (r.errors?.length || !r.data) return null;
  const hits = extractSearchHits(r.data);
  if (hits.length === 0) return null;
  const decision = decideMatch(ta.title, ta.author, hits);
  if (!decision.accepted || !decision.best) return null;
  const chosen = hits.find((h) => h.externalId === decision.best!.externalId);
  return {
    externalId: decision.best.externalId,
    confidence: decision.best.score,
    queryUsed: q,
    title: chosen?.title ?? null,
    author: chosen?.author ?? null,
  };
}

/** The user's "Currently Reading" shelf (status_id 2). */
async function listCurrentlyReading(cred: Credential, http: HttpTransport): Promise<ExternalBook[]> {
  const token = tokenOf(cred);
  // GATE: confirm user_books/status_id shape.
  const r = await gql(
    http,
    token,
    `query CurrentlyReading {
       me {
         user_books(where: { status_id: { _eq: 2 } }, limit: 100) {
           book { id title contributions { author { name } } }
         }
       }
     }`,
    {}
  );
  const ubs = r.data?.me?.[0]?.user_books ?? r.data?.me?.user_books ?? [];
  const out: ExternalBook[] = [];
  for (const ub of Array.isArray(ubs) ? ubs : []) {
    const b = ub?.book;
    if (b?.id == null || typeof b?.title !== 'string') continue;
    out.push({
      externalId: String(b.id),
      title: b.title,
      author: b?.contributions?.[0]?.author?.name ?? null,
    });
  }
  return out;
}

/** Free-text catalog search (for the manual-match picker). */
async function search(cred: Credential, query: string, http: HttpTransport): Promise<ExternalBook[]> {
  const token = tokenOf(cred);
  const r = await gql(
    http,
    token,
    `query Search($q: String!) { search(query: $q, query_type: "Book", per_page: 10) { results } }`,
    { q: query }
  );
  if (r.errors?.length || !r.data) return [];
  return extractSearchHits(r.data).map((h) => ({
    externalId: h.externalId,
    title: h.title,
    author: h.author ?? null,
  }));
}

/** GATE: adapt to the real search payload. Handles a couple of plausible shapes. */
export function extractSearchHits(data: any): Candidate[] {
  const raw =
    data?.search?.results?.hits ??
    data?.search?.results ??
    data?.search ??
    [];
  const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.hits) ? raw.hits : [];
  const out: Candidate[] = [];
  for (const h of arr) {
    const doc = h?.document ?? h;
    const id = doc?.id ?? doc?.book_id;
    const title = doc?.title;
    if (id == null || typeof title !== 'string') continue;
    const author =
      doc?.author_names?.[0] ??
      doc?.contributions?.[0]?.author?.name ??
      doc?.author ??
      undefined;
    out.push({
      externalId: String(id),
      title,
      author,
      popularity: typeof doc?.users_count === 'number' ? doc.users_count : undefined,
    });
  }
  return out;
}

/** Turn a GraphQL/HTTP response into a retry decision, or null if it's fine. */
function classify(r: { status: number; errors?: { message: string }[] }): PushResult | null {
  if (r.status === 401 || r.status === 403) {
    return { ok: false, retryable: false, needsReauth: true, error: 'unauthorized' };
  }
  if (r.status === 429) return { ok: false, retryable: true, error: 'rate limited' };
  if (r.status >= 500) return { ok: false, retryable: true, error: `server ${r.status}` };
  if (r.errors?.length) return { ok: false, retryable: false, error: r.errors[0].message };
  return null;
}

interface Edition {
  id: number;
  pages: number;
}

/**
 * Pick an edition with a page count, in priority order: the reader's own
 * edition, the book's defaults, then ANY edition of the book that has pages.
 * Scanning all fetched editions (not just the most popular one) matters because
 * many books have some editions with page counts and some without - looking at
 * only the top edition silently loses progress for the rest.
 */
const noPagedEditionLogged = new Set<number>();

function pickEdition(meUb: any, data: any): Edition | null {
  const candidates = [
    meUb?.user_book_reads?.[0]?.edition,
    meUb?.edition,
    data?.books_by_pk?.default_ebook_edition,
    data?.books_by_pk?.default_physical_edition,
    ...(Array.isArray(data?.editions) ? data.editions : []),
  ];
  for (const e of candidates) {
    if (e && e.id != null && typeof e.pages === 'number' && e.pages > 0) {
      return { id: Number(e.id), pages: Number(e.pages) };
    }
  }
  return null;
}

/**
 * Progress on Hardcover is page-based and lives on a user_book_read (read
 * session), derived as progress_pages / edition.pages. So: set shelf status,
 * resolve an edition + page count, convert our percentage to pages, then
 * insert/update the read session. Modeled on Billiam/hardcoverapp.koplugin.
 */
async function push(
  cred: Credential,
  m: Match,
  ev: OutboundEvent,
  http: HttpTransport
): Promise<PushResult> {
  const token = tokenOf(cred);
  const bookId = Number(m.externalId);
  if (!Number.isFinite(bookId)) return { ok: false, retryable: false, error: 'bad book id' };
  const pct = Math.max(0, Math.min(1, ev.percentage ?? 0));
  const finished = ev.kind === 'finished' || pct >= 0.999;
  const desiredStatus = finished ? STATUS_READ : STATUS_READING;

  // 1) Look up the CURRENT shelf state first: the user_book (if any), its
  //    status, the latest read session (with its dates), and an edition with a
  //    page count. We decide what to change from here, so we never blindly
  //    re-assert a status that is already set (which reset the read's start
  //    date and clobbered the day's starting progress).
  const ctx = await gql(
    http,
    token,
    `query Ctx($bookId: Int!) {
       me {
         user_books(where: { book_id: { _eq: $bookId } }, limit: 1) {
           id
           status_id
           edition { id pages }
           user_book_reads(where: { finished_at: { _is_null: true } }, order_by: { id: asc }, limit: 1) {
             id started_at finished_at edition { id pages }
           }
         }
       }
       books_by_pk(id: $bookId) {
         default_ebook_edition { id pages }
         default_physical_edition { id pages }
       }
       editions(
         where: { book_id: { _eq: $bookId }, pages: { _is_null: false } }
         order_by: { users_count: desc_nulls_last }
         limit: 20
       ) {
         id pages
       }
     }`,
    { bookId }
  );
  const ctxAuth = classify(ctx);
  if (ctxAuth) return ctxAuth;

  const meUb = ctx.data?.me?.[0]?.user_books?.[0];
  let userBookId: number | undefined = meUb?.id;
  const currentStatus: number | undefined =
    typeof meUb?.status_id === 'number' ? meUb.status_id : undefined;
  // The OLDEST still-open read is the one Hardcover treats as current and shows
  // on the book (it creates this read itself when a book becomes "reading").
  let openRead = meUb?.user_book_reads?.[0];
  const edition = pickEdition(meUb, ctx.data);

  // 2) Set the shelf status ONLY when it needs to change. Never re-mark a book
  //    that is already in the desired status, and never downgrade a finished
  //    book back to "reading". A status change makes Hardcover auto-create an
  //    empty read, so we re-fetch afterward and update THAT one - otherwise we
  //    end up with a duplicate (our read + Hardcover's, which is the one shown).
  let statusTouched = false;
  if (!userBookId) {
    // Not on a shelf yet: add it with the desired status.
    const ubRes = await gql(
      http,
      token,
      `mutation SetStatus($bookId: Int!, $statusId: Int!) {
         insert_user_book(object: { book_id: $bookId, status_id: $statusId }) {
           user_book { id }
         }
       }`,
      { bookId, statusId: desiredStatus }
    );
    const a = classify(ubRes);
    if (a) return a;
    userBookId = ubRes.data?.insert_user_book?.user_book?.id;
    statusTouched = true;
  } else if (
    currentStatus !== desiredStatus &&
    !(desiredStatus === STATUS_READING && currentStatus === STATUS_READ)
  ) {
    // On a shelf with a different status: advance it (want-to-read -> reading,
    // or reading -> read on finish). Skipped when already reading.
    const upd = await gql(
      http,
      token,
      `mutation UpdStatus($id: Int!, $statusId: Int!) {
         update_user_book(id: $id, object: { status_id: $statusId }) {
           user_book { id }
         }
       }`,
      { id: userBookId, statusId: desiredStatus }
    );
    const a = classify(upd);
    if (a) return a;
    statusTouched = true;
  }

  // If we just changed the status, Hardcover may have created a fresh open read.
  // Re-fetch the oldest open read so we UPDATE it instead of inserting our own.
  if (statusTouched) {
    const re = await gql(
      http,
      token,
      `query OpenRead($bookId: Int!) {
         me {
           user_books(where: { book_id: { _eq: $bookId } }, limit: 1) {
             user_book_reads(where: { finished_at: { _is_null: true } }, order_by: { id: asc }, limit: 1) {
               id started_at finished_at edition { id pages }
             }
           }
         }
       }`,
      { bookId }
    );
    const refetched = re.data?.me?.[0]?.user_books?.[0]?.user_book_reads?.[0];
    if (refetched) openRead = refetched;
  }
  const openReadId: number | undefined = openRead?.id;

  if (!edition) {
    // Shelf status is synced, but no edition with a known page count exists, so
    // Hardcover has no denominator for a percentage. Keep trying on every push
    // (the lookup is the same query status sync needs, and it self-heals the
    // moment someone adds a page count on Hardcover) but log only once per
    // process per book — this fires for every progress event otherwise.
    if (!noPagedEditionLogged.has(bookId)) {
      noPagedEditionLogged.add(bookId);
      console.warn(
        JSON.stringify({
          msg: 'hardcover: no paged edition, progress skipped (add a page count on hardcover.app to fix; logged once per book)',
          bookId,
          title: m.title ?? null,
        })
      );
    }
    return {
      ok: true,
      note: 'Hardcover has no page count for this book, so progress cannot sync (shelf status still does). Add a page count to any edition on hardcover.app and it will start syncing.',
    };
  }
  const progressPages = Math.max(0, Math.min(edition.pages, Math.floor(pct * edition.pages)));

  const today = new Date(Math.max(0, ev.timestamp) * 1000).toISOString().slice(0, 10);
  // 3) Move the reading position. Hardcover's read mutations REPLACE the record
  //    (they are custom upserts, not partial updates), so every write must carry
  //    started_at or the start date is wiped - which also drops the journal
  //    entry. So we always pass it: the existing start date when there is one,
  //    else today. Update the current open read, or start a new one.
  let res;
  if (openReadId) {
    const startedAt = openRead?.started_at || today; // preserve, else backfill
    res = await gql(
      http,
      token,
      `mutation UpdRead($id: Int!, $pages: Int!, $editionId: Int!, $startedAt: date!) {
         update_user_book_read(id: $id, object: { progress_pages: $pages, edition_id: $editionId, started_at: $startedAt }) {
           error
           user_book_read { id }
         }
       }`,
      { id: openReadId, pages: progressPages, editionId: edition.id, startedAt }
    );
  } else {
    if (!userBookId) return { ok: false, retryable: true, error: 'no user_book to attach a read to' };
    res = await gql(
      http,
      token,
      `mutation InsRead($id: Int!, $pages: Int!, $editionId: Int!, $startedAt: date!) {
         insert_user_book_read(
           user_book_id: $id
           user_book_read: { progress_pages: $pages, edition_id: $editionId, started_at: $startedAt }
         ) {
           error
           user_book_read { id }
         }
       }`,
      { id: userBookId, pages: progressPages, editionId: edition.id, startedAt: today }
    );
  }
  const readAuth = classify(res);
  if (readAuth) return readAuth;
  const opError =
    res.data?.update_user_book_read?.error ?? res.data?.insert_user_book_read?.error;
  if (opError) return { ok: false, retryable: false, error: String(opError) };
  return { ok: true };
}

export const hardcoverConnector: Connector = {
  id: 'hardcover',
  displayName: 'Hardcover',
  tier: 1,
  capabilities: { read: false, write: true },
  carries: ['progress', 'finished'],
  credentialKind: 'token',
  experimental: false,
  validate,
  match,
  push,
  listCurrentlyReading,
  search,
};
