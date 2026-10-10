# Design: Hardcover Sync Connector

Status: **draft / not implemented**

Forward reading activity from crosspoint-sync to [Hardcover](https://hardcover.app) so a user's
shelf reflects what they read on their e-reader — automatically. The connector lives entirely
server-side: devices keep speaking plain kosync and never talk to Hardcover.

## Goals

- When a user reads on any synced device, their Hardcover profile updates: book moves to
  "Currently Reading" on first progress, progress percentage stays current, and the book flips to
  "Read" (with a finish date) on completion.
- Zero firmware changes. Works for CrossPoint, CrossInk, and stock KOReader (once it ships the
  metadata PR) alike.
- Hardcover being slow, down, or rate-limiting must never affect device sync.

Non-goals (v1): importing Hardcover state back to devices,
StoryGraph (no public API), ratings/reviews. (Clippings now post as journal quotes when the
user turns on the `highlights` connector option; private by default.)

## Architecture

```
device --kosync PUT--> crosspoint-sync --enqueue--> forwarder --GraphQL--> Hardcover
                            |                          ^
                            +-- matcher (title/author search, once per document)
```

Three pieces, all in this codebase:

1. **Token link** — user attaches their Hardcover API token to their account.
2. **Matcher** — resolves our opaque document hash to a Hardcover book, using the
   title/author/filename metadata we already capture. Runs once per `(user, document)`, result
   cached; re-runs when metadata improves or the user overrides.
3. **Forwarder** — turns progress events into Hardcover GraphQL mutations, with a retry queue.

### Why matching is server-side (decision)

Title/author already arrive via the progress-PUT `metadata` object, so every existing client feeds
the matcher with no firmware release. Hardcover's search API (Typesense-backed) handles the fuzzy
matching; we only rank/accept results. Server-side logic can be improved and re-run against
historical documents at any time. Firmware-extracted ISBN was considered and rejected for the
critical path: it needs a firmware release to exist, and `dc:identifier` is missing or wrong in
enough real-world EPUBs (DRM-stripped, self-published, Calibre-converted) that we'd need the
fuzzy path anyway. ISBN remains a possible future confidence booster.

## Hardcover API notes

- Endpoint: `https://api.hardcover.app/v1/graphql`, header `Authorization: Bearer <token>`.
- Tokens are user-generated (hardcover.app/account/api) and currently expire ~yearly; the API is
  officially beta. Treat every request as fallible and every schema detail as subject to change.
- **Implementation gate:** before building the forwarder, verify against the live schema (the API
  has a GraphQL explorer): search query shape, `user_books` status ids
  (want-to-read / currently-reading / read), and the exact mutations for inserting/updating a
  user book and its progress (book-level vs edition-level, pages vs percentage). Encode those in
  one `src/connectors/hardcover.ts` module with a recorded-fixture test so schema drift breaks CI,
  not production.
- Rate limits are modest (beta). The forwarder must coalesce: at most one progress mutation per
  (user, book) per N minutes (default 15), always keeping only the latest value. Reading sessions
  on e-ink produce sparse syncs anyway (sync is user-initiated over WiFi), so this is cheap.

## Schema additions

```sql
CREATE TABLE hardcover_accounts (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id),
  token_enc   TEXT NOT NULL,          -- encrypted at rest (see Security)
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE TABLE hardcover_matches (
  user_id       INTEGER NOT NULL REFERENCES users(id),
  document      TEXT NOT NULL,
  book_id       INTEGER,              -- Hardcover book id (NULL = unmatched)
  edition_id    INTEGER,              -- optional, when confidently known
  confidence    REAL NOT NULL DEFAULT 0,
  source        TEXT NOT NULL,        -- 'auto' | 'manual' | 'none'
  query_used    TEXT,                 -- what we searched, for debugging/review UI
  updated_at    INTEGER NOT NULL,
  PRIMARY KEY (user_id, document)
);

CREATE TABLE hardcover_queue (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  document    TEXT NOT NULL,
  kind        TEXT NOT NULL,          -- 'progress' | 'finished'
  payload     TEXT NOT NULL,          -- JSON: percentage, timestamp, finished_date...
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try_at INTEGER NOT NULL,
  UNIQUE (user_id, document, kind)    -- coalesce: newest payload replaces
);
```

## API additions (same x-auth headers)

- `PUT /api/v1/connectors/hardcover` — `{token: "..."}`; server validates it with a cheap `me`
  query before storing. `DELETE` unlinks and wipes the queue.
- `GET /api/v1/connectors/hardcover` — `{enabled, linked_at, matched: n, unmatched: n}`.
- `GET /api/v1/connectors/hardcover/matches` + `PUT .../matches/:document` — list and manually
  set/override matches. Powers the future web-UI "review matches" screen; usable via curl until
  then. Manual matches are sticky (`source = 'manual'`, never auto re-matched).

Token entry realistically requires a browser, not an e-ink keyboard — this lands with (or just
before) the first web UI. The endpoints don't depend on the UI, though.

## Matching algorithm

Input: the EPUB's **`documents.title` + `documents.author`** — the real signal, which the firmware
already extracts and sends in the progress `metadata` object. This is the primary/expected path.
Filename is only a last resort for a title-less EPUB, and we don't guess `Title - Author` vs
`Author - Title` order (drop separators, use the whole string as a fuzzy query). Filename can't
rescue the no-metadata case — title/author and filename ship in the *same* metadata object — so
**matching effectively requires "Send Metadata" on**, which is the reason to default that toggle on
for connector users.

1. Normalize: strip subtitle after `:`, series suffixes like `(Book 2)`, diacritics folded,
   `Last, First` → `First Last`.
2. Query Hardcover search with `title author`.
3. Score the top results: normalized-title similarity + author-name overlap. Accept the top hit
   when it clears a threshold **and** clearly beats the runner-up (title collisions like
   "Circe" resolve on author; same-title-same-author editions are all correct at book level, so
   ambiguity between them is acceptable — take the most popular edition).
4. Store the result either way (`source: 'auto'` or `'none'` with the query kept for review).

Re-match triggers: metadata for the document changes (e.g. the user flips Send Metadata on after
the fact), or a manual re-match request. Never re-match over `source = 'manual'`.

Documents with no metadata at all simply stay unmatched — which is also the user-facing nudge to
enable the Send Metadata toggle.

## Forwarding rules

On progress PUT for a linked user with a matched document, upsert into the queue:

- percentage > 0 → `progress` event: ensure user_book exists with status currently-reading,
  update progress percentage. First event for a book is what shelves it.
- completion → `finished` event: status read + finish date. Completion = percentage ≥ 0.98, or —
  once CrossInk stats sync ships — `isCompleted` / non-zero `finished_date` from
  `stats_device_book` (the stronger signal wins; stats-based finish dates are real dates, the
  percentage heuristic uses the sync timestamp).

A small worker drains the queue (setInterval in the Node process — no external infra), with
exponential backoff on failure and a dead-letter state after ~a week of retries. `401` from
Hardcover (expired token) disables the link and surfaces in the status endpoint rather than
retrying forever.

Kosync GET/downstream sync is never blocked or delayed by any of this.

## Security

- Hardcover tokens are bearer credentials to a third-party account: encrypt at rest
  (AES-256-GCM with a key from a `TOKEN_ENC_KEY` env var), never log them, redact in errors.
  Self-hosters without `TOKEN_ENC_KEY` set get the connector disabled, not plaintext storage.
- Outbound requests go only to the Hardcover endpoint; no user-controlled URLs (no SSRF surface).

## Rollout

1. Schema + token link + matcher, with `GET .../matches` for inspection. Verify match quality on
   real libraries via curl before any forwarding exists.
2. Forwarder for progress + finished, behind per-user `enabled`.
3. Web UI: token entry + review-matches screen.
4. Later: ISBN confidence boost, richer status mapping (owned/DNF), maybe Bookwyrm/Calibre-Web
   via the same connector pattern.

## Open questions

- Exact Hardcover mutation set and status ids (resolve at the implementation gate above).
- Should percentage-completion threshold be user-configurable? (Default 0.98; back-matter skews
  short books.)
- Multi-device: progress forwarding uses the newest-across-devices row (same rule as kosync GET),
  so no per-device fan-out — confirm that's the desired UX for people who read the same book on
  two devices at different points.
