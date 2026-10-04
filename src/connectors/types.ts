import type { DB } from '../db/db.js';

/**
 * Connector framework types. A connector adapts crosspoint-sync's canonical
 * reading state to one external service. See docs/design/sync-hub.md.
 */

export type Capability = { read: boolean; write: boolean };

/** Per-user storage a connector may use for derived book data (e.g. EPUB position maps). */
export interface ConnectorContext { db: DB; userId: number; }

/** What data types a connector carries (progress/shelves vs highlights). */
export type DataKind = 'progress' | 'finished' | 'highlight';

export type CredentialKind = 'token' | 'oauth' | 'cookies' | 'kosync' | 'device_code' | 'abs';

/** Interactive OAuth device-code link handshake (BookFusion). */
export interface DeviceLinkStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  /** verificationUri with the code pre-filled, when the provider offers one. */
  verificationUriComplete?: string;
  interval: number;
  expiresIn: number;
}
export interface DeviceLinkPoll {
  status: 'pending' | 'ok' | 'denied' | 'expired' | 'error';
  credential?: Record<string, unknown>;
  accountLabel?: string;
  error?: string;
}

/** Browser OAuth (Authorization Code + PKCE), run by the server; validate() gets { code, code_verifier, redirect_uri, client_id }. */
export interface OAuthConfig {
  authorizeUrl: string;
  /** The server's shared client id; null = each user brings their own. */
  clientId: string | null;
  scopes: string[];
}

/** Feasibility/trust tier from the design doc. */
export type Tier = 1 | 2 | 3;

/** Metadata we know about a document, used for server-side book matching. */
export interface DocumentMeta {
  document: string;
  title: string | null;
  author: string | null;
  filename: string | null;
}

export interface Match {
  externalId: string;
  /** Exact provider id supplied by the downloaded book's sidecar. */
  fromSidecar?: boolean;
  externalEdition?: string | null;
  confidence: number; // 0..1
  queryUsed?: string;
  /** Title/author of the matched record, when known — used to backfill document metadata. */
  title?: string | null;
  author?: string | null;
}

/** A book on the user's "currently reading" / "in progress" list at a connector. */
export interface ExternalBook {
  externalId: string;
  title: string;
  author?: string | null;
  /** Optional extra id (e.g. Audiobookshelf duration) cached onto the match. */
  edition?: string | null;
}

/** A position change pulled FROM a connector (fan-in / bidirectional sync). */
export interface InboundChange {
  /** The connector's book id (maps back to our document via the match table). */
  externalId: string;
  /** 0..1 reading fraction. */
  percentage: number;
  finished: boolean;
  /** Exact KOSync XPath, when the provider position can be resolved in the same EPUB. */
  progress?: string;
  /** Source last-update timestamp, ms epoch — used as the poll cursor. */
  updatedAtMs: number;
  /**
   * The source only reports a FURTHEST-read location (Kindle FRL), possibly
   * without a trustworthy timestamp. The fan-in applier must apply it only when
   * it ADVANCES the canonical position — furthest-read can't be ahead of a
   * higher value from anywhere else, so a lower-or-equal value is always stale.
   */
  furthestReadOnly?: boolean;
}

/** A highlight pulled FROM a connector, positioned in chapter codepoints like a clipping. */
export interface InboundHighlight {
  text: string;
  note: string | null;
  chapter: string | null;
  spine: number;
  startOffset: number;
  endOffset: number;
  /** unix seconds the highlight was made. */
  createdAt: number;
}

/** A canonical reading event to fan out to a connector. */
export interface OutboundEvent {
  kind: DataKind;
  document: string;
  /** 0..1 reading fraction (progress/finished events). */
  percentage?: number;
  /** kosync progress string (xpath/CFI). Present on progress events; used by the kosync mirror. */
  progress?: string;
  /** Rich CrossPoint position, forwarded losslessly by the kosync mirror. */
  position?: Record<string, unknown> | null;
  /** unix seconds when this happened on the device/server. */
  timestamp: number;
  /** For highlight events. */
  highlight?: {
    text: string;
    note?: string | null;
    title?: string | null;
    author?: string | null;
    location?: number | null;
    highlightedAt?: number | null;
    /** CrossPoint position: spine index plus chapter codepoint offsets (when the firmware sent them). */
    spine?: number | null;
    startOffset?: number | null;
    endOffset?: number | null;
    chapter?: string | null;
  };
}

/** Result of a push attempt; retryable=false means don't re-queue (permanent).
 *  note: a per-book condition worth surfacing in the review UI (e.g. "no page
 *  count on Hardcover"); persisted on the match, cleared when absent. */
export type PushResult =
  | { ok: true; note?: string }
  | { ok: false; retryable: boolean; error: string; needsReauth?: boolean };

/** Operational failure for connector lifecycle work. */
export class ConnectorOperationError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly needsReauth = false
  ) {
    super(message);
    this.name = 'ConnectorOperationError';
  }
}

export interface ValidateResult {
  ok: boolean;
  accountLabel?: string;
  error?: string;
}

/**
 * Minimal HTTP transport injected into connectors so tests can supply a fake
 * without real network access. Mirrors the subset of fetch we use.
 */
export interface HttpTransport {
  (url: string, init: {
    method: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    redirect?: 'error' | 'follow' | 'manual';
  }): Promise<{
    status: number;
    text(): Promise<string>;
    json(): Promise<unknown>;
    body?: ReadableStream<Uint8Array> | null;
    headers?: { get(name: string): string | null };
  }>;
}

/** A parsed credential (shape is connector-specific; stored encrypted as JSON). */
export type Credential = Record<string, unknown>;

/**
 * Present on credentials loaded for a linked account: persists the credential's
 * current fields (e.g. after an OAuth refresh rotated its tokens). A symbol, so
 * it never reaches JSON.
 */
export const SAVE_CREDENTIAL = Symbol('saveCredential');
export type SavableCredential = Credential & { [SAVE_CREDENTIAL]?: () => void };

export interface Connector {
  id: string;
  displayName: string;
  tier: Tier;
  capabilities: Capability;
  /** Which data kinds this connector accepts on fan-out. */
  carries: DataKind[];
  credentialKind: CredentialKind;
  /** Beta (shown with a badge) rather than ready. There is no third state. */
  beta: boolean;
  /** Hidden from the connector list/UI (still registered; not user-linkable via the UI). */
  hidden?: boolean;
  /**
   * Stealth: hidden from the connector list until the user reveals it (POST
   * /connectors/:id/reveal, e.g. via the /kindle landing page). A linked account
   * is always visible. For gated, beta connectors that shouldn't be
   * discoverable from the main UI alone.
   */
  revealable?: boolean;
  /**
   * How a document is matched to this service.
   *  - 'metadata' (default): needs the book's title/author, so documents with no
   *    metadata can never match and are skipped on fan-out (no wasted attempts).
   *  - 'document': keyed by our document id directly (e.g. a kosync mirror), so it
   *    always applies regardless of metadata.
   */
  matchBy?: 'document' | 'metadata';

  /** PKCE sign-in details. */
  oauth?(): OAuthConfig;
  /** Whether the provider knows a user-supplied client id. Optional. */
  checkClientId?(clientId: string, redirectUri: string, http: HttpTransport): Promise<'ok' | 'rejected' | 'unknown'>;

  /** Validate a credential and return the account label if possible. */
  validate(cred: Credential, http: HttpTransport): Promise<ValidateResult>;

  /** Return false to acknowledge an event without matching or pushing it. */
  shouldPush?(ev: OutboundEvent, canonicalPercentage?: number | null): boolean;

  /** Resolve a document to an external book id. Null = no confident match. */
  match(
    cred: Credential,
    doc: DocumentMeta,
    http: HttpTransport,
    ev?: OutboundEvent
  ): Promise<Match | null>;

  /** Create an external book only after matching found no existing record. */
  createBook?(
    cred: Credential,
    doc: DocumentMeta,
    ev: OutboundEvent,
    http: HttpTransport
  ): Promise<Match | null>;

  /** Push one outbound event. Only called for write-capable connectors. */
  push(cred: Credential, match: Match, ev: OutboundEvent, http: HttpTransport, ctx?: ConnectorContext): Promise<PushResult>;

  /**
   * The user's "currently reading" / "in progress" books at this service.
   * A small, high-signal candidate pool tried before catalog search, and shown
   * in the manual-match picker. Optional.
   */
  listCurrentlyReading?(cred: Credential, http: HttpTransport): Promise<ExternalBook[]>;

  /** Free-text catalog search for the manual-match picker. Optional. */
  search?(cred: Credential, query: string, http: HttpTransport): Promise<ExternalBook[]>;

  /**
   * Resolve the opaque `externalEdition` hint for an already-chosen book (e.g.
   * an audiobook's duration). Called when a match is saved without one so push
   * has what it needs. Optional; returns null if it can't be determined.
   */
  resolveEdition?(cred: Credential, externalId: string, http: HttpTransport): Promise<string | null>;

  /**
   * Force-refresh the connector's server-side library list (for a dashboard
   * "refresh library" button). Returns the new item count. Optional — most
   * connectors search a live catalog and have nothing to refresh.
   */
  refreshLibrary?(cred: Credential, http: HttpTransport): Promise<{ count: number } | null>;

  /**
   * Verify an externally-supplied book id against the user's account at this
   * service (e.g. an ASIN pasted in the match UI), returning the verified book
   * plus any resolved edition hint, or null when the id isn't owned/reachable.
   * Stronger than a list-membership check where the service offers one.
   * Optional.
   */
  lookup?(
    cred: Credential,
    externalId: string,
    http: HttpTransport
  ): Promise<(ExternalBook & { edition?: string | null }) | null>;

  /**
   * Pull position changes since a cursor (ms epoch), for bidirectional sync.
   * Only read-capable connectors implement it. The runner maps each change back
   * to a document and writes it into canonical progress. Optional.
   */
  pullChanges?(cred: Credential, http: HttpTransport, sinceMs: number): Promise<InboundChange[]>;

  /** Poll a known book instead of scanning the provider library; sinceMs is its canonical timestamp. */
  pullProgress?(
    cred: Credential, match: Match, http: HttpTransport, sinceMs: number, ctx?: ConnectorContext
  ): Promise<InboundChange | null>;

  /**
   * Highlights on a known book, for import as clippings. `skip` says whether a
   * quote is already a clipping on this book, so connectors avoid resolving
   * known ones (which can mean downloading the EPUB). Optional.
   */
  pullHighlights?(
    cred: Credential, match: Match, http: HttpTransport, skip: (text: string) => boolean
  ): Promise<InboundHighlight[]>;

  /** Begin an interactive device-code link (OAuth device grant). Optional. */
  beginLink?(http: HttpTransport): Promise<DeviceLinkStart>;
  /** Poll a device-code link until it completes. Optional. */
  pollLink?(deviceCode: string, http: HttpTransport): Promise<DeviceLinkPoll>;
}
