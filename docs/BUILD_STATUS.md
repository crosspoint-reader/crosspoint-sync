# Build status — connector hub (overnight session)

Snapshot of the master-sync-hub build. **Nothing committed or pushed.** Everything below is in the
working tree of `crosspoint-sync` for your review.

## What's done and tested

The full connector framework from `docs/design/sync-hub.md`, plus both Tier-1 connectors.
`npm test` = **74 passing** (was 40); `npx tsc --noEmit` clean; `npm run build` clean.

### Framework
- **Encrypted secret vault** (`src/crypto/secrets.ts`) — AES-256-GCM, key from `TOKEN_ENC_KEY`
  (hex / base64 / passphrase). Connectors disabled when unset; never stores plaintext. Tested
  (roundtrip, tamper-detection, key formats, disabled mode).
- **Schema** (`migrations/0003_connectors.sql`) — `connector_accounts`, `connector_matches`,
  `connector_queue`, keyed by `connector_id`.
- **Connector interface + registry** (`src/connectors/types.ts`, `registry.ts`) — one module per
  service; `HttpTransport` is injectable so everything is testable without network.
- **Matcher** (`src/connectors/matching.ts`) — server-side title/author matching: normalize,
  strip subtitles/series, `Last, First` handling, Jaccard scoring, auto-accept only on a clear
  winner (same-book editions OK, title collisions rejected). Filename is a last resort only.
  Heavily unit-tested.
- **Coalescing retry queue** (`src/connectors/queue.ts`) — one pending row per
  (user, connector, document, coalesceKey); progress collapses to latest, highlights keyed per
  clipping; exponential backoff, dead-letter after 8 tries. Tested.
- **Runner/worker** (`src/connectors/runner.ts`) — resolves match (cached/manual-sticky/auto),
  pushes, handles reauth/backoff; `startQueueWorker` drains every 15s (started in `index.ts` only
  when `TOKEN_ENC_KEY` is set).
- **Fan-out** (`src/connectors/fanout.ts`) — progress PUT → progress/finished events; clippings
  PUT → highlight events. Wired into both kosync and v1 progress routes and the clippings route.
  Best-effort, never blocks the request.
- **Management API** (`src/routes/v1/connectors.ts`) — list / link / unlink / list-matches /
  manual-match / rematch. Documented in `docs/API.md`. Endpoint + fan-out tests in
  `test/connectors.test.ts` (fake transport).

### Connectors
- **Hardcover** (`src/connectors/hardcover.ts`, Tier 1) — token validate, search-based match,
  status mutation (reading/read). Write-only, carries progress+finished.
- **Readwise** (`src/connectors/readwise.ts`, Tier 1) — token validate, highlight push (fan-out),
  and `exportHighlights()` for the fan-in "aggregator hop" (highlights via Readwise).
  Carries highlights.

## ⚠️ Live-verify gates before enabling in production

Both connectors are built against **documented** API shapes but not verified against live accounts
(I have no tokens, and shouldn't hit third-party APIs from here). Search the code for `GATE`.

- **Hardcover** (beta API — highest risk): confirm against the live GraphQL explorer
  (hardcover.app/account/api): the `me` query shape, `search` result shape (see `extractSearchHits`,
  which defensively handles a few shapes), the `insert_user_book` mutation name/args, and the
  **status ids** (`STATUS_READING`/`STATUS_READ` are guesses). Wire a recorded-fixture test once
  confirmed so schema drift breaks CI.
- **Readwise** (stable public API — lower risk): confirm `POST /api/v2/highlights/` field names and
  the `GET /api/v2/export/` cursor field (`nextPageCursor`). Mind the ~20 req/min limit on
  create/export.

## Not built (deliberately deferred)

- **Fan-in wiring** — `exportHighlights()` exists but isn't hooked into a canonical-clippings
  importer or a poll loop yet. That's the next chunk if you want Readwise-imported highlights
  landing in the clippings store / on-device.
- **Tier 2/3 connectors** (Goodreads/StoryGraph cookie-replay) — framework supports them
  (`credentialKind: 'cookies'`, `experimental` flag) but none implemented; they need the CSRF
  handshake + live capture work described in sync-hub.md, behind an experimental opt-in.
- **Web UI** — token paste / OAuth / match-review screen. The API is UI-ready; the UI is the
  natural next project and the real prerequisite for non-technical pairing.
- **Bidirectional/fan-in merge rules** beyond the design notes.

## To run locally with connectors on

```sh
export TOKEN_ENC_KEY=$(openssl rand -hex 32)
DATABASE_PATH=./data/dev.db npm run dev
# GET /api/v1/connectors shows encryption: "enabled" and both connectors unlinked
```

Railway note: to enable connectors in prod, set `TOKEN_ENC_KEY` as a service variable (generate
once, keep it stable — rotating it invalidates all stored connector credentials).

## Suggested review order

1. `docs/design/sync-hub.md` (the plan) → `src/connectors/types.ts` (the shape).
2. `matching.ts` + `test/matching.test.ts` (the only tricky pure logic).
3. `runner.ts` + `queue.ts` + `test/queue.test.ts` (delivery semantics).
4. `hardcover.ts` / `readwise.ts` (check the GATEs against live docs).
5. `test/connectors.test.ts` (end-to-end link → sync → fan-out with a fake API).
