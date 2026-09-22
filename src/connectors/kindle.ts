import { decideMatch, extractTitleAuthor, normalizeText, type Candidate } from './matching.js';
import {
  fetchContent,
  fetchEbokLibrary,
  fetchLastRead,
  fetchSyncMetadata,
  FionaError,
  type EbokEntry,
  type FionaContentType,
  type FionaDevice,
} from './kindle-fiona.js';
import { MobiError, palmDocTextLength } from './kindle-mobi.js';
import { ConnectorOperationError } from './types.js';
import type {
  Connector,
  Credential,
  DocumentMeta,
  ExternalBook,
  HttpTransport,
  InboundChange,
  Match,
  PushResult,
  ValidateResult,
} from './types.js';

/**
 * Amazon Kindle connector (Tier 3, experimental, READ-ONLY). Bridges Whispersync
 * positions into canonical progress so reading on a non-jailbroken Kindle resumes
 * on CrossPoint/KOReader devices. Speaks the Fiona/CDE device protocol with a
 * scoped, registered-device credential — never the user's Amazon password or web
 * cookies. See docs/design/kindle-sync.md for the security model and the
 * live-verify checklist that gates removing the experimental badge.
 *
 * !!! LIVE-VERIFY GATE !!!
 * Everything here follows the protocol re-verified against a live account in
 * Sept 2026, but it is still a private API. Search this file for GATE.
 */

export interface KindleLibraryBook {
  asin: string;
  title: string;
  author?: string | null;
  type?: FionaContentType;
}

interface KindleCred extends Credential {
  adp_token: string;
  private_key: string;
  device_serial: string;
  device_name?: string;
  library?: KindleLibraryBook[];
}

function parseCred(cred: Credential): KindleCred | null {
  const c = cred as Partial<KindleCred>;
  if (
    typeof c.adp_token !== 'string' || !c.adp_token ||
    typeof c.private_key !== 'string' || !c.private_key ||
    typeof c.device_serial !== 'string' || !c.device_serial
  ) {
    return null;
  }
  const library = Array.isArray(c.library)
    ? c.library.filter(
        (b): b is KindleLibraryBook =>
          !!b && typeof b === 'object' &&
          typeof (b as KindleLibraryBook).asin === 'string' &&
          typeof (b as KindleLibraryBook).title === 'string'
      )
    : undefined;
  return {
    adp_token: c.adp_token,
    private_key: c.private_key,
    device_serial: c.device_serial,
    device_name: typeof c.device_name === 'string' ? c.device_name : undefined,
    library,
  };
}

function deviceOf(c: KindleCred): FionaDevice {
  return {
    adpToken: c.adp_token,
    privateKey: c.private_key,
    deviceSerial: c.device_serial,
    deviceName: c.device_name ?? 'CrossPoint Sync',
  };
}

/** external_id is "TYPE:ASIN"; a bare ASIN means PDOC (the connector's use case). */
export function parseExternalId(externalId: string): { type: FionaContentType; asin: string } {
  const m = /^(PDOC|EBOK):(.+)$/.exec(externalId);
  if (m) return { type: m[1] as FionaContentType, asin: m[2] };
  return { type: 'PDOC', asin: externalId };
}

// --- Position-space ruler cache ------------------------------------------------
// The decompressed-text length of one Amazon conversion is account-independent,
// so a small process-wide cache avoids re-downloading whole books. Persisted
// per-match via external_edition; this only saves the fetch across restarts.
// PERMANENT failures (403 delivery-not-supported, 404, unparseable formats) are
// negative-cached for the process lifetime too — otherwise every sync of that
// book re-downloads it from Amazon just to fail again. Cleared on restart
// (e.g. after a KINDLE_SOFTWARE_REV change or re-registration).
const rulerCache = new Map<string, number>();
const RULER_CACHE_MAX = 500;
const rulerFailures = new Map<string, string>();

class RulerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RulerUnavailableError';
  }
}

async function rulerFor(
  http: HttpTransport,
  device: FionaDevice,
  type: FionaContentType,
  asin: string,
  cachedEdition: string | null | undefined
): Promise<number> {
  const persisted = cachedEdition ? Number(cachedEdition) : NaN;
  if (Number.isFinite(persisted) && persisted > 0) return persisted;
  const hit = rulerCache.get(asin);
  if (hit) {
    // Refresh recency (Map is insertion-ordered).
    rulerCache.delete(asin);
    rulerCache.set(asin, hit);
    return hit;
  }
  const priorFailure = rulerFailures.get(asin);
  if (priorFailure) throw new RulerUnavailableError(priorFailure);

  let content: Buffer;
  try {
    content = await fetchContent(http, device, asin, type);
  } catch (err) {
    if (err instanceof FionaError && (err.status === 403 || err.status === 404)) {
      const msg = `kindle: cannot download the converted book (${asin}): ${err.message}`;
      rulerFailures.set(asin, msg);
      throw new RulerUnavailableError(msg);
    }
    throw err; // transient (network, 429, 5xx) — not cached, retried next time
  }
  let length: number;
  try {
    length = palmDocTextLength(content);
  } catch (err) {
    const msg = `kindle: cannot read the converted book's position space (${asin}: ${err instanceof MobiError ? err.message : 'unparseable content'})`;
    rulerFailures.set(asin, msg);
    throw new RulerUnavailableError(msg);
  }
  if (rulerCache.size >= RULER_CACHE_MAX) {
    const oldest = rulerCache.keys().next().value;
    if (oldest !== undefined) rulerCache.delete(oldest);
  }
  rulerCache.set(asin, length);
  return length;
}

// --- Connector verbs ------------------------------------------------------------

async function validate(cred: Credential, http: HttpTransport): Promise<ValidateResult> {
  const c = parseCred(cred);
  if (!c) {
    return { ok: false, error: 'device credential (adp_token, private_key, device_serial) is required' };
  }
  try {
    await fetchSyncMetadata(http, deviceOf(c));
    return { ok: true, accountLabel: c.device_name ?? 'Kindle device' };
  } catch (err) {
    if (err instanceof FionaError && (err.status === 401 || err.status === 403)) {
      return { ok: false, error: 'device credential rejected (deregistered?) — re-run the setup tool' };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Purchased books are enumerated by the SERVER (syncMetaData is a signed device
 * call — the extension never needs it). The list is cached with NO expiry and
 * refreshed only when a match attempt misses — a miss is the only signal that a
 * new book might exist, so there are zero periodic calls. Stale is served on
 * fetch failure rather than breaking matching.
 */
const ebokCache = new Map<string, EbokEntry[]>();

async function ebokLibrary(http: HttpTransport, c: KindleCred, refresh = false): Promise<EbokEntry[]> {
  const hit = ebokCache.get(c.device_serial);
  if (hit && !refresh) return hit;
  try {
    const books = await fetchEbokLibrary(http, deviceOf(c));
    ebokCache.set(c.device_serial, books);
    return books;
  } catch {
    return hit ?? [];
  }
}

type LibraryCandidate = Candidate & { book: KindleLibraryBook };

function toCandidates(c: KindleCred, eboks: EbokEntry[]): LibraryCandidate[] {
  const out: LibraryCandidate[] = [];
  const seen = new Set<string>();
  for (const book of c.library ?? []) {
    const externalId = `${book.type === 'EBOK' ? 'EBOK' : 'PDOC'}:${book.asin}`;
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    out.push({ externalId, title: book.title, author: book.author ?? undefined, book });
  }
  for (const b of eboks) {
    const externalId = `EBOK:${b.asin}`;
    if (seen.has(externalId)) continue;
    seen.add(externalId);
    out.push({
      externalId,
      title: b.title,
      author: b.author ?? undefined,
      book: { asin: b.asin, title: b.title, author: b.author, type: 'EBOK' },
    });
  }
  return out;
}

/** PDOCs from the extension-uploaded snapshot + EBOKs from the server-side fetch. */
async function libraryCandidates(c: KindleCred, http: HttpTransport): Promise<LibraryCandidate[]> {
  return toCandidates(c, await ebokLibrary(http, c));
}

/**
 * Match against the combined library: the extension-uploaded PDOC snapshot plus
 * the server-enumerated EBOK list. A miss triggers ONE EBOK refresh (maybe it's
 * a brand-new purchase) and a single retry; still missing → null, and the book
 * quietly doesn't sync to Kindle (visible as 'none' in the review UI — a miss is
 * normal for books never sent to the Kindle, not an error).
 */
async function match(cred: Credential, doc: DocumentMeta, http: HttpTransport): Promise<Match | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const ta = extractTitleAuthor(doc);
  if (!ta) return null;

  let chosen: LibraryCandidate | undefined;
  let confidence = 0;
  // Try the EBOK list (fetched now if never fetched). On a miss, refresh it once
  // (new purchase?) and retry — but skip the refresh when the first try was
  // already fresh off the network.
  const cacheWasCold = !ebokCache.has(c.device_serial);
  for (const refresh of [false, true]) {
    if (refresh && cacheWasCold) break;
    const candidates = toCandidates(c, await ebokLibrary(http, c, refresh));
    const decision = decideMatch(ta.title, ta.author, candidates);
    if (decision.accepted && decision.best) {
      chosen = candidates.find((x) => x.externalId === decision.best!.externalId);
      confidence = decision.best.score;
      break;
    }
  }
  if (!chosen) return null;
  return {
    externalId: chosen.externalId,
    confidence,
    queryUsed: ta.title,
    title: chosen.book.title ?? null,
    author: chosen.book.author ?? null,
  };
}

/** The combined library doubles as the manual-match picker's candidate pool. */
async function listCurrentlyReading(cred: Credential, http: HttpTransport): Promise<ExternalBook[]> {
  const c = parseCred(cred);
  if (!c) return [];
  return (await libraryCandidates(c, http)).map((cand) => ({
    externalId: cand.externalId,
    title: cand.title,
    author: cand.author ?? null,
  }));
}

async function search(cred: Credential, query: string, http: HttpTransport): Promise<ExternalBook[]> {
  const q = normalizeText(query);
  if (!q) return [];
  return (await listCurrentlyReading(cred, http)).filter((b) =>
    normalizeText(`${b.title} ${b.author ?? ''}`).includes(q)
  );
}

/** Resolve+cache the position-space ruler length for a chosen book. */
async function resolveEdition(cred: Credential, externalId: string, http: HttpTransport): Promise<string | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const { type, asin } = parseExternalId(externalId);
  try {
    return String(await rulerFor(http, deviceOf(c), type, asin, null));
  } catch {
    return null; // best-effort; pullProgress will surface the real error later
  }
}

/** Force-refresh the server-side purchased-book list (PDOCs refresh via the extension only). */
async function refreshLibrary(cred: Credential, http: HttpTransport): Promise<{ count: number } | null> {
  const c = parseCred(cred);
  if (!c) return null;
  return { count: (await ebokLibrary(http, c, true)).length };
}

/**
 * Verify an ASIN against the user's Kindle account. First the combined library
 * (PDOC snapshot + EBOK list, refreshing EBOKs once on a miss — maybe the list
 * is stale). Failing that, an OWNERSHIP PROBE: Amazon only serves the converted
 * file for books the account owns, so a successful FSDownloadContent both proves
 * ownership and sizes the position-space ruler. Unowned/wrong-type ids 404.
 */
async function lookup(
  cred: Credential,
  externalId: string,
  http: HttpTransport
): Promise<(ExternalBook & { edition?: string | null }) | null> {
  const c = parseCred(cred);
  if (!c) return null;
  const { type, asin } = parseExternalId(externalId.trim());
  if (!/^[A-Za-z0-9-]{4,64}$/.test(asin)) return null;

  const inLibrary = (cands: LibraryCandidate[]) =>
    cands.find((b) => b.externalId === `PDOC:${asin}` || b.externalId === `EBOK:${asin}`);
  const cacheWasCold = !ebokCache.has(c.device_serial);
  let hit = inLibrary(toCandidates(c, await ebokLibrary(http, c)));
  if (!hit && !cacheWasCold) hit = inLibrary(toCandidates(c, await ebokLibrary(http, c, true)));
  if (hit) return { externalId: hit.externalId, title: hit.book.title, author: hit.book.author ?? null };

  for (const t of [type, type === 'PDOC' ? ('EBOK' as const) : ('PDOC' as const)]) {
    try {
      const len = await rulerFor(http, deviceOf(c), t, asin, null);
      if (len > 0) {
        return { externalId: `${t}:${asin}`, title: asin, author: null, edition: String(len) };
      }
    } catch {
      // not owned under this type — try the other
    }
  }
  return null;
}

/**
 * Fan-in: pull the Kindle furthest-read position for a matched book and emit it
 * as a canonical percentage change. Percentage-only by nature (a byte offset can
 * never become an EPUB xpath); the fan-in applier borrows a nearby real device
 * position from recorded samples when it can.
 */
async function pullProgress(
  cred: Credential,
  m: Match,
  http: HttpTransport,
  sinceMs: number
): Promise<InboundChange | null> {
  const c = parseCred(cred);
  if (!c) throw new ConnectorOperationError('kindle: bad credential', false, true);
  const device = deviceOf(c);
  const { type, asin } = parseExternalId(m.externalId);

  let lastRead;
  try {
    lastRead = await fetchLastRead(http, device, asin, type);
  } catch (err) {
    if (err instanceof FionaError) {
      if (err.status === 401 || err.status === 403) {
        throw new ConnectorOperationError('kindle: device credential rejected (deregistered?)', false, true);
      }
      if (err.status === 429 || (err.status != null && err.status >= 500)) {
        throw new ConnectorOperationError(`kindle: Amazon unavailable (${err.status})`, true);
      }
    }
    throw err;
  }
  if (!lastRead?.found || lastRead.pos == null) return null;

  const parsedMs = lastRead.annotationTimeUtc ? Date.parse(lastRead.annotationTimeUtc) : NaN;
  const dated = Number.isFinite(parsedMs);
  // iOS-identity annotations are frequently UNDATED. FRL semantics make that
  // safe to accept: furthest-read only moves forward, so the value can only be
  // stale-or-equal, never a regression from the future. The fan-in applier
  // (furthestReadOnly) applies it only when it advances the canonical position,
  // which covers undated values in every interleaving. Dated annotations still
  // short-circuit here when they're provably older than our progress.
  if (dated && sinceMs && parsedMs <= sinceMs) return null;

  // Known-undownloadable book (delivery refused/unparseable — logged on the
  // FIRST failure): skip quietly instead of re-downloading just to fail again.
  const hasUsableRuler =
    (m.externalEdition != null && Number(m.externalEdition) > 0) || rulerCache.has(asin);
  if (!hasUsableRuler && rulerFailures.has(asin)) return null;

  const total = await rulerFor(http, device, type, asin, m.externalEdition);
  // GATE (position spaces): pos indexes the reporter's converted format. Our ruler
  // is the MOBI7 conversion for our Android identity; a physical Kindle reading a
  // KF8 delivery reports larger offsets that must NOT be force-fit (they clamp to
  // a corrupt ~100%). Refuse loudly instead; the design doc lists the KF8 fix.
  if (lastRead.pos > total * 1.02) {
    throw new ConnectorOperationError(
      `kindle: position ${lastRead.pos} exceeds the MOBI7 text length ${total} ` +
      `(reported by ${lastRead.sourceDevice ?? 'unknown device'}); this position is in a ` +
      `KF8 position space that is not mappable yet — skipping rather than corrupting progress`,
      false
    );
  }
  const pct = Math.max(0, Math.min(1, lastRead.pos / total));
  return {
    externalId: m.externalId,
    percentage: pct,
    finished: pct >= 0.999,
    updatedAtMs: dated ? parsedMs : Date.now(),
    furthestReadOnly: true,
  };
}

/** Read-only connector: fan-out never queues here (capabilities.write is false). */
async function push(): Promise<PushResult> {
  return { ok: true };
}

export const kindleConnector: Connector = {
  id: 'kindle',
  displayName: 'Amazon Kindle (Whispersync)',
  tier: 3,
  capabilities: { read: true, write: false },
  carries: ['progress'],
  credentialKind: 'token',
  experimental: true,
  // Stealth: not listed until the user opts in via the /kindle landing page.
  revealable: true,
  validate,
  match,
  push,
  listCurrentlyReading,
  search,
  resolveEdition,
  refreshLibrary,
  lookup,
  pullProgress,
};
