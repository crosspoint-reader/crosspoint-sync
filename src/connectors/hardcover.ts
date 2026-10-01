import { decideMatch, extractTitleAuthor, type Candidate } from './matching.js';
import {
  ConnectorOperationError,
  SAVE_CREDENTIAL,
  type Connector,
  type Credential,
  type DeviceLinkPoll,
  type DeviceLinkStart,
  type DocumentMeta,
  type ExternalBook,
  type HttpTransport,
  type Match,
  type OutboundEvent,
  type PushResult,
  type SavableCredential,
  type ValidateResult,
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

// Since August 2026 Hardcover API keys (hc_pat_...) carry only the permissions
// ticked when they're created (older keys keep full access). This connector
// reads the profile and library, searches the catalog, and writes the library.
export const HARDCOVER_SCOPES = ['read:me', 'read:library', 'read:catalog', 'write:library'];
// Hardcover's new-key form with those scopes pre-ticked (their "PAT link" format).
export const HARDCOVER_NEW_KEY_URL = `https://hardcover.app/account/api/keys/new?scope=${HARDCOVER_SCOPES.join('+')}`;
const SCOPE_HINT = `Create a Hardcover API key with ${HARDCOVER_SCOPES.join(', ')}.`;

// GATE: confirm Hardcover's user_book status ids (want-to-read/reading/read).
const STATUS_READING = 2;
const STATUS_READ = 3;

interface HardcoverCred extends Credential {
  token: string;
}

// ---- Linking ---------------------------------------------------------------
// Users sign in with Hardcover's OAuth Device Authorization Grant: we show a
// code, they approve CrossPoint Sync at hardcover.app/link. "CrossPoint Sync" is
// registered as a public (no secret) Hardcover app, so this client id ships here
// and works for self-hosted servers too; HARDCOVER_CLIENT_ID overrides it.
// A pasted API key ({ token }) still works for older links and as a fallback.
const CLIENT_ID = process.env.HARDCOVER_CLIENT_ID || '80a1b03b-d090-4243-b049-515857b83d97';
const TOKEN_URL = 'https://api.hardcover.app/oauth2/token';
const DEVICE_URL = 'https://api.hardcover.app/oauth2/device';

interface TokenSet {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
}

async function oauthPost(http: HttpTransport, url: string, fields: Record<string, string>) {
  const res = await http(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(fields).toString(),
  });
  let body: any = {};
  try {
    body = await res.json();
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

const tokenSet = (body: any): TokenSet | null =>
  typeof body?.access_token === 'string' && typeof body?.refresh_token === 'string'
    ? {
        access_token: body.access_token,
        refresh_token: body.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + (Number(body.expires_in) || 7 * 86400),
      }
    : null;

async function beginLink(http: HttpTransport): Promise<DeviceLinkStart> {
  const { status, body } = await oauthPost(http, DEVICE_URL, { client_id: CLIENT_ID, scope: HARDCOVER_SCOPES.join(' ') });
  if (status !== 200 || typeof body?.device_code !== 'string') {
    throw new Error(body?.error_description ?? body?.error ?? `Hardcover answered ${status}`);
  }
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri: body.verification_uri ?? 'https://hardcover.app/link',
    verificationUriComplete: body.verification_uri_complete,
    interval: body.interval ?? 5,
    expiresIn: body.expires_in ?? 900,
  };
}

async function pollLink(deviceCode: string, http: HttpTransport): Promise<DeviceLinkPoll> {
  const { status, body } = await oauthPost(http, TOKEN_URL, {
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    client_id: CLIENT_ID,
  });
  const tokens = tokenSet(body);
  if (tokens) return { status: 'ok', credential: { ...tokens } };
  switch (body?.error) {
    case 'authorization_pending':
    case 'slow_down':
      return { status: 'pending' };
    case 'access_denied':
      return { status: 'denied', error: 'You declined the request on Hardcover.' };
    case 'expired_token':
      return { status: 'expired', error: 'The code expired. Start again.' };
    default:
      return status >= 500 ? { status: 'pending' } : { status: 'error', error: body?.error_description ?? body?.error ?? `status ${status}` };
  }
}

// Refresh tokens rotate on every use, and reusing a spent one makes Hardcover
// revoke the whole sign-in. So refreshes are serialized per token, and a caller
// holding an already-spent token (a credential loaded before another refresh)
// follows the chain to the newest set instead of replaying it.
// ponytail: in-process only; run a single server process (as deployed) or move this to the DB.
const inflight = new Map<string, Promise<TokenSet>>();
const successor = new Map<string, TokenSet>();

async function refreshed(http: HttpTransport, refreshToken: string): Promise<TokenSet> {
  let next = successor.get(refreshToken);
  while (next && successor.has(next.refresh_token)) next = successor.get(next.refresh_token)!;
  if (next && next.expires_at - 300 > Date.now() / 1000) return next;
  const from = next?.refresh_token ?? refreshToken;
  let pending = inflight.get(from);
  if (!pending) {
    pending = (async () => {
      const { status, body } = await oauthPost(http, TOKEN_URL, { grant_type: 'refresh_token', refresh_token: from, client_id: CLIENT_ID });
      const tokens = tokenSet(body);
      if (tokens) {
        successor.set(from, tokens);
        return tokens;
      }
      if (status === 400 || status === 401) {
        throw new ConnectorOperationError('Hardcover sign-in expired or was revoked. Link Hardcover again.', false, true);
      }
      throw new ConnectorOperationError(`Hardcover token refresh failed (${status})`, true);
    })().finally(() => inflight.delete(from));
    inflight.set(from, pending);
  }
  return pending;
}

/** A usable bearer token: the pasted API key, or a fresh OAuth access token. */
async function accessToken(cred: Credential, http: HttpTransport): Promise<string> {
  const pat = (cred as HardcoverCred).token;
  if (typeof pat === 'string' && pat.length > 0) return pat;
  const c = cred as SavableCredential & Partial<TokenSet>;
  if (typeof c.access_token !== 'string' || typeof c.refresh_token !== 'string') {
    throw new ConnectorOperationError('Hardcover is not linked', false, true);
  }
  if ((c.expires_at ?? 0) - 300 > Date.now() / 1000) return c.access_token;
  const tokens = await refreshed(http, c.refresh_token);
  Object.assign(c, tokens);
  c[SAVE_CREDENTIAL]?.();
  return tokens.access_token;
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
    // Body: { error: "invalid_token" | "insufficient_scope" | ..., error_description, scope }
    let body: { error?: string; error_description?: string; scope?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* no body */
    }
    const message =
      res.status === 401
        ? `Hardcover key is invalid or expired. ${SCOPE_HINT}`
        : body.error === 'insufficient_scope'
          ? `Hardcover key is missing the ${body.scope ?? 'required'} permission. ${SCOPE_HINT}`
          : `Hardcover refused the request (${body.error_description ?? body.error ?? res.status}).`;
    return { status: res.status, errors: [{ message }] };
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
    const token = await accessToken(cred, http);
    // GATE: confirm the `me` query shape.
    const r = await gql(http, token, `query { me { username } }`, {});
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
  const token = await accessToken(cred, http);
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
  const token = await accessToken(cred, http);
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
  const token = await accessToken(cred, http);
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
    return { ok: false, retryable: false, needsReauth: true, error: r.errors?.[0]?.message ?? 'unauthorized' };
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
  let token: string;
  try {
    token = await accessToken(cred, http);
  } catch (err) {
    if (err instanceof ConnectorOperationError) {
      return { ok: false, retryable: err.retryable, needsReauth: err.needsReauth, error: err.message };
    }
    throw err;
  }
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

  // Already Read: nothing to write. Hardcover closed the read when it was
  // finished, so any read write here would insert a second one (the device
  // keeps syncing at the end of a book), making it look read twice.
  if (currentStatus === STATUS_READ) return { ok: true };

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
    // Marking Read may close the open read on Hardcover's side. Then the ctx
    // read is stale and writing to it (or inserting) would reopen or duplicate
    // it, so leave it be.
    if (refetched) openRead = refetched;
    else if (finished) return { ok: true };
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
  // Close the read when finishing; the mutation replaces the record, so a
  // missing finished_at would leave it open.
  const finishedAt = finished ? today : null;
  let res;
  if (openReadId) {
    const startedAt = openRead?.started_at || today; // preserve, else backfill
    res = await gql(
      http,
      token,
      `mutation UpdRead($id: Int!, $pages: Int!, $editionId: Int!, $startedAt: date!, $finishedAt: date) {
         update_user_book_read(id: $id, object: { progress_pages: $pages, edition_id: $editionId, started_at: $startedAt, finished_at: $finishedAt }) {
           error
           user_book_read { id }
         }
       }`,
      { id: openReadId, pages: progressPages, editionId: edition.id, startedAt, finishedAt }
    );
  } else {
    if (!userBookId) return { ok: false, retryable: true, error: 'no user_book to attach a read to' };
    res = await gql(
      http,
      token,
      `mutation InsRead($id: Int!, $pages: Int!, $editionId: Int!, $startedAt: date!, $finishedAt: date) {
         insert_user_book_read(
           user_book_id: $id
           user_book_read: { progress_pages: $pages, edition_id: $editionId, started_at: $startedAt, finished_at: $finishedAt }
         ) {
           error
           user_book_read { id }
         }
       }`,
      { id: userBookId, pages: progressPages, editionId: edition.id, startedAt: today, finishedAt }
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
  credentialKind: 'device_code',
  experimental: false,
  validate,
  match,
  push,
  listCurrentlyReading,
  search,
  beginLink,
  pollLink,
};
