# crosspoint-sync API

The contract for firmware (CrossPoint / CrossInk) and any other client. Two API surfaces share one
account system and the same auth headers:

1. **KOSync-compatible API** at the root — byte-compatible with `sync.koreader.rocks`. Stock
   KOReader and current CrossPoint firmware work by changing only the server URL.
2. **Extended API** under `/api/v1` — lossless CrossPoint positions, bookmarks, clippings,
   reading stats, and document metadata.

All requests and responses are JSON (`Content-Type: application/json`). The
`Accept: application/vnd.koreader.v1+json` header is accepted but never required.

## Authentication

Every endpoint except `POST /users/create` and `GET /healthz` requires:

```
x-auth-user: <username>
x-auth-key:  <MD5 hex of the account password>
```

The key is the lowercase 32-hex MD5 of the plain password — exactly what KOReader and CrossPoint
already send. The server never sees the plain password and stores only a salted PBKDF2 of the key.

### Error responses

Errors reuse the stock kosync codes so existing client error handling keeps working:

| HTTP | code | Meaning |
|------|------|---------|
| 401  | 2001 | Missing/invalid auth headers |
| 402  | 2002 | Username already registered |
| 403  | 2003 | Invalid request body / registration disabled |
| 403  | 2004 | Missing or malformed `document` |
| 429  | 2001 | Rate limited (registration / repeated auth failures) |

Body shape is always `{"code": 2001, "message": "Unauthorized"}`.

## Document identity

`document` is an opaque key chosen by the client, up to 64 chars of `[A-Za-z0-9._-]`. CrossPoint
sends the KOReader 32-hex MD5 (partial-binary or filename method, per device setting). The server
never tries to unify the two hash methods; a book synced under both appears as two documents.

---

## KOSync-compatible API

### POST /users/create

Open registration (disable with `REGISTRATION_DISABLED=true`).

```json
// request
{"username": "justin", "password": "0f359740bd1cda994f8b55330c86d845"}
// 201 response
{"username": "justin"}
```

Usernames: 1–64 chars of `[A-Za-z0-9._@+-]`. The `password` field is the MD5 auth key.

### GET /users/auth

Validates credentials. `200 {"authorized": "OK"}` or `401`.

### PUT /syncs/progress

```json
// request
{
  "document": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "progress": "/body/DocFragment[8]/body/div[2]/p[4]/text()[1].96",
  "percentage": 0.4867,
  "device": "CrossPoint",
  "device_id": "crossink-device"
}
// 200 response
{"document": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "timestamp": 1752345678}
```

- One row is stored per `(user, document, device_id)` — unlike stock kosync, devices never
  overwrite each other. If `device_id` is absent, `device` is used as the device key.
- `percentage` is a float in `[0, 1]`. `timestamp` is unix **seconds** (integer).
- **Superset capture:** the body may include the extended `position` object (see
  `PUT /api/v1/progress`) and/or a `metadata` object (below). If present and valid they are
  stored; unknown fields are ignored. This lets firmware ship rich sync against this endpoint
  with a one-line change.
- **Metadata capture** (KOReader PR #15306 shape, sent by CrossPoint when the "send metadata"
  setting is on):

  ```json
  "metadata": {
    "filename": "Foundryside - Robert Jackson Bennett.epub",
    "title": "Foundryside",
    "authors": "Robert Jackson Bennett",
    "bookfusion_id": "36835"
  }
  ```

  All fields optional strings (≤512 chars). `filename`/`title`/`authors` are stored per
  `(user, document)`; fields the client omits never overwrite previously stored values. Retrieve
  via `GET /api/v1/documents` or joined into `GET /api/v1/progress`.

  **Service ids.** Any extra `<service>_id` field (from a CrossPoint plugin's book sidecar,
  e.g. `bookfusion_id`) pre-seeds an exact match for the connector of that name: progress is
  pushed straight to that record, skipping title/author search. Unknown-connector ids are
  ignored; a user's manual match is never overridden.

  **BookFusion positions.** For a BookFusion download identified by its sidecar, the server
  retrieves the EPUB and resolves the existing KOSync XPath against its chapter XHTML.
  It sends the resulting CFI, chapter index, and text-based spine-normalized position to
  BookFusion. This requires no additional firmware fields. Precision follows the supplied
  XPath: a text-node offset identifies that text position; a paragraph/chapter-only XPath
  identifies its start. An unresolved XPath fails without posting an estimated position.

  When a device requests `GET /syncs/progress/:document` or
  `GET /api/v1/progress/:document`, the server first fetches the matched BookFusion
  book's latest position, resolves its point CFI in the EPUB, and then reads the stored
  progress for the response. This requires a linked, enabled account and a previously
  received sidecar match; a GET cannot discover metadata that the device has not sent.
  BookFusion is not polled in the background. Concurrent requests for the same user's
  book share a lookup; subsequent requests check the provider again.

  Refreshes have a 10-second total deadline. A timeout returns HTTP 504; provider or
  conversion failures return HTTP 502. Stored progress is preserved and the next GET
  retries the refresh. Books without an enabled sidecar match use the normal KOSync
  response. No firmware update is needed. Conversion uses the provider's update
  timestamp, skips older positions, and preserves text offsets (converting UTF-16 CFI
  offsets to CrossPoint codepoints). Delayed outbound
  events also check the remote timestamp before posting, to avoid replacing newer
  BookFusion progress. The provider does not offer an atomic conditional update, so a
  simultaneous edit between that check and the POST is still possible.

  The server reuses downloaded archives for 15 minutes in an account-scoped memory cache
  capped at 32 MiB total and 32 entries. Downloads are limited to 32 MiB and 30 seconds;
  each extracted XML file is limited to 1 MiB. Only the package metadata and target chapter
  are decompressed. Books matched by title or manual selection retain percentage-only
  outbound updates and are excluded from inbound position conversion because those matches do not establish that the reader has the same EPUB edition.

### GET /syncs/progress/{document}

Returns the newest progress **across all of the user's devices** (most recent `timestamp` wins):

```json
{
  "document": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "progress": "/body/DocFragment[8]/body/div[2]/p[4]/text()[1].96",
  "percentage": 0.4867,
  "device": "CrossPoint",
  "device_id": "crossink-device",
  "timestamp": 1752345678
}
```

**Quirk (stock-compatible):** if no progress exists, the response is `200` with `{}` — not 404.
KOReader clients check for field presence, not status codes.

---

## Extended API (/api/v1)

Same auth headers. Designed for the ESP32: responses are small (< 8 KB at default limits), keys are
short, batches are capped.

### Delta-sync protocol (bookmarks & clippings)

- `GET ...?since=<unix>&limit=<n>` returns items with `updated_at > since`, oldest first, including
  **tombstones** (`"deleted": 1`). `limit` defaults to 50, max 100.
- The response carries `until` (persist it as the next `since` cursor) and `more` (repeat with
  `since = until` until `more` is false).
- `PUT` batches set `updated_at` on the **server clock** — the server is the last-write-wins
  authority because device RTCs drift. A delete is `{"id": "...", "deleted": 1}` (no other fields
  needed). Deleted items keep tombstones forever so late-syncing devices converge.
- Merge semantics: set-union of ids, last-write-wins per id.

### Rich progress

#### PUT /api/v1/progress

The kosync body plus a `position` object mapping 1:1 to the firmware's `CompactPosition`:

```json
{
  "document": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "progress": "/body/DocFragment[8]/body/div[2]/p[4]/text()[1].96",
  "percentage": 0.4867,
  "device": "CrossPoint",
  "device_id": "A1B2C3D4",
  "position": {
    "pctQ": 486700,
    "spine": 7,
    "page": 143,
    "pages": 412,
    "para": 96,
    "li": 0,
    "anchor": "ch08-sec2",
    "xpath": "/body/DocFragment[8]/body/div[2]/p[4]/text()[1].96"
  }
}
```

| field  | type | notes |
|--------|------|-------|
| pctQ   | uint | percentage × 1,000,000 (0–1,000,000). Layout-independent; authoritative. |
| spine  | uint16 | spine (chapter) index |
| page / pages | uint16 | page within spine / spine page count — **layout hints**, depend on font settings |
| para   | uint16, optional | synthetic 1-based paragraph index; omit when unavailable (`hasParagraphIndex=false`) |
| li     | uint16, optional | running `<li>` count; omit when unavailable |
| anchor | string ≤ 48 bytes, optional | nearest `<a id>` anchor |
| xpath  | string ≤ 120 bytes, optional | KOReader-style xpath |

Response: `{"document": "...", "timestamp": 1752345678}`.

An invalid `position` is ignored (the kosync fields still sync); a missing `position` on a later
PUT keeps the previously stored one for that device.

#### GET /api/v1/progress

Lists every synced document — newest progress across devices, joined with any stored metadata.
This is how clients/UIs discover documents without knowing hashes. `?limit=` defaults to 100
(max 500), ordered newest-first.

```json
{
  "items": [
    {"document": "25f8abb4f4f5594f02f361726814fea1",
     "title": "Foundryside", "author": "Robert Jackson Bennett",
     "filename": "Foundryside - Robert Jackson Bennett.epub",
     "percentage": 0.2853, "progress": "/body/DocFragment[16]/body/div[1]/p[143]",
     "device_id": "crosspoint-reader", "device": "CrossPoint", "timestamp": 1783913361}
  ]
}
```

`title`/`author`/`filename` are `null` until some client sends metadata for that document.

#### GET /api/v1/progress/{document}

All device rows, newest first — the client decides what to apply:

```json
{
  "document": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "devices": [
    {"device_id": "A1B2C3D4", "device": "CrossPoint", "percentage": 0.4867,
     "progress": "...", "position": { "pctQ": 486700, "spine": 7, "page": 143, "pages": 412 },
     "timestamp": 1752345678},
    {"device_id": "koreader-boox", "device": "boox", "percentage": 0.41,
     "progress": "...", "position": null, "timestamp": 1752300000}
  ]
}
```

`position` is `null` for rows written by plain kosync clients.

### Bookmarks

Item ids are **client-derived**: `id = first 16 hex chars of SHA-256(xpath)`. Deterministic, so
re-adding the same bookmark is idempotent and delete-by-id needs no new device-side state. All
CrossPoint devices must compute ids identically.

#### GET /api/v1/bookmarks/{document}?since=&limit=

```json
{
  "document": "a1b2c3d4e5f60718293a4b5c6d7e8f90",
  "until": 1752345678,
  "more": false,
  "items": [
    {"id": "9f86d081884c7d65",
     "xpath": "/body/DocFragment[3]/body/p[12]/text().0",
     "percentage": 0.35,
     "summary": "It was the best of times, it was the worst of",
     "si": 3, "pc": 120, "pp": 42,
     "deleted": 0, "updated_at": 1752340000}
  ]
}
```

`si`/`pc`/`pp` are CrossPoint's spine index / chapter page count / page-in-chapter hints
(nullable — layout dependent).

#### PUT /api/v1/bookmarks/{document}

Batch upsert, max 50 items:

```json
{"items": [
  {"id": "9f86d081884c7d65", "xpath": "...", "percentage": 0.35,
   "summary": "...", "si": 3, "pc": 120, "pp": 42},
  {"id": "deadbeef00112233", "deleted": 1}
]}
```

Response: `{"until": 1752345679, "accepted": 2}`.

### Clippings

Mirrors CrossInk's `Clipping` struct (`src/ClippingStore.h`) 1:1. Item ids are client-derived:
`id = first 16 hex chars of SHA-256(created_at_decimal + text)` — both fields are immutable after
creation.

Item shape:

```json
{
  "id": "c0ffee0011223344",
  "spine": 7,
  "start_page": 12, "end_page": 13, "pages": 40,
  "start_word": 5, "end_word": 22, "words": 30,
  "para": 96,
  "chapter": "Chapter 8",
  "text": "So we beat on, boats against the current...",
  "note": null, "color": null,
  "created_at": 1752300000,
  "deleted": 0, "updated_at": 1752340000
}
```

- `para` optional — omit when the firmware has `paragraphIndex == UINT16_MAX`.
- Page/word fields are layout hints, kept verbatim for CrossInk↔CrossInk restore; `para` + `text`
  are the portable anchors.
- `text` ≤ 2048 bytes (the firmware's export cap), `chapter` ≤ 64 chars, `note` ≤ 4096 bytes.
- `note` and `color` are server-side extensions for future firmware / web UI; send them back
  unchanged if unused.
- No 64-per-book cap server-side (that's a device storage limit).

Endpoints: `GET /api/v1/clippings/{document}?since=&limit=` and
`PUT /api/v1/clippings/{document}` (batch max 50) — identical semantics to bookmarks.

### Reading stats

Model (matches the firmware's nearby P2P stats sync): **each device uploads its own snapshot;
snapshots replace, never accumulate; the server aggregates across devices on read.** Never merge
another device's stats into local ones.

#### PUT /api/v1/stats/global

The device's `GlobalReadingStats` as JSON:

```json
{
  "device_id": "A1B2C3D4", "device": "CrossInk",
  "v": 5,
  "sessions": 312, "seconds": 184300, "pages": 9120, "completed": 14,
  "tod": [1200, 84000, 60100, 39000],
  "dow": [8000, 9000, 7000, 11000, 12000, 60000, 77300],
  "anchor_day": 9650,
  "history_b64": "<base64 of the 92-byte reading-history bitmap>",
  "streak": 21
}
```

- `tod` = seconds in [morning, afternoon, evening, night]; `dow` = Mon..Sun seconds.
- `anchor_day` = days since 2000-01-01 of the bitmap's most recent day; bit N of the bitmap =
  `anchor_day - N` (LSB-first within each byte, 730 days / 92 bytes).
- `streak` = device-reported all-time longest streak (may predate the bitmap window).

Response: `{"until": 1752345678}`.

#### PUT /api/v1/stats/books

Batch (max 20) of per-book `stats_v5` snapshots for one device:

```json
{"device_id": "A1B2C3D4", "items": [
  {"document": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "v": 5,
   "sessions": 9, "seconds": 8400, "pages": 310, "completed": false,
   "avg_fwd": 12, "pace_n": 250, "eta": 5400,
   "start_manual": false, "finish_manual": false,
   "start_date": 1751000000, "finished_date": 0,
   "tod": [0, 3000, 4000, 1400], "dow": [0, 0, 1200, 0, 2000, 3000, 2200]}
]}
```

#### GET /api/v1/stats/summary

Server-side aggregate across all of the user's devices:

- scalars and `tod`/`dow` are summed;
- history bitmaps are **OR-ed after re-anchoring** to the newest `anchor_day` (each device's bits
  shift by its anchor delta; days older than the 730-day window drop);
- `streak` = max(longest run in the combined bitmap, any device-reported streak);
- `current_streak` = run ending at the anchor day (the anchor day itself may be unset — today
  isn't over).

```json
{
  "sessions": 402, "seconds": 190300, "pages": 9500, "completed": 15,
  "tod": [...], "dow": [...],
  "anchor_day": 9650, "history_b64": "...", "streak": 21, "current_streak": 6,
  "devices": [{"device_id": "A1B2C3D4", "device": "CrossInk", "updated_at": 1752345678}]
}
```

#### GET /api/v1/stats/global

Raw per-device snapshots (`{"devices": [{"device_id", "device", "updated_at", "stats": {...}}]}`)
for clients that render per-device numbers like the P2P screen does.

#### GET /api/v1/stats/books/{document}

Per-device rows plus a `combined` object (scalars/buckets summed, `completed` OR-ed, `avg_fwd`
weighted by `pace_n`, `start_date` = earliest non-zero, `finished_date` = latest).

### Documents metadata (optional)

`PUT /api/v1/documents` — `{"items": [{"document": "...", "title": "...", "author": "...",
"filename": "...", "filesize": 812345}]}` (max 50); omitted fields never overwrite stored values.
`GET /api/v1/documents` lists them. Most clients don't need this endpoint — progress-PUT
`metadata` capture populates the same table.

### Connectors (master sync hub)

Pair external services (Hardcover, Readwise, …) to the account; reading activity fans out to them
server-side. See docs/design/sync-hub.md. All under `/api/v1`, same auth headers. Requires the
server to have `TOKEN_ENC_KEY` set (credentials are encrypted at rest) — otherwise these endpoints
report `encryption: "disabled"` and linking returns 403.

#### GET /api/v1/connectors

Lists available connectors and this account's link status.

```json
{
  "encryption": "enabled",
  "connectors": [
    {"id": "hardcover", "name": "Hardcover", "tier": 1, "experimental": false,
     "carries": ["progress", "finished"], "capabilities": {"read": false, "write": true},
     "credential_kind": "token", "linked": true, "status": "ok", "account": "julia",
     "queue": {"pending": 0, "dead": 0}},
    {"id": "readwise", "name": "Readwise", "tier": 1, "experimental": false,
     "carries": ["highlight"], "capabilities": {"read": true, "write": true},
     "credential_kind": "token", "linked": false, "status": null, "account": null}
  ]
}
```

#### PUT /api/v1/connectors/{id}

Link/re-link by validating and storing a credential. Body: `{"credential": { ... }}` — shape is
connector-specific (`{"token": "..."}` for Hardcover and Readwise). The server validates against the
service before storing; returns `400` if rejected. `{"id": "hardcover", "linked": true,
"account": "julia"}` on success.

#### DELETE /api/v1/connectors/{id}

Unlink; wipes the stored credential, all matches, and queued work.

#### GET /api/v1/connectors/{id}/matches

Lists resolved book matches (for a review UI): `{"connector": "hardcover", "matches": [{"document",
"external_id", "confidence", "source": "auto|manual|none", "query_used", "updated_at"}]}`.

#### PUT /api/v1/connectors/{id}/matches/{document}

Manually set a match (sticky — never auto-recomputed). Body `{"external_id": "42"}`, or
`{"external_id": null}` to mark "never sync this document".

#### POST /api/v1/connectors/{id}/rematch/{document}

Force (re)matching now; returns the resolved match or null. Preserves manual overrides.

**Matching** is server-side from the document's title/author (the EPUB metadata the firmware sends —
so connectors need "Send Metadata" on). **Fan-out** is automatic: a progress PUT enqueues a
progress/finished event to write-connectors that carry it; a clippings PUT enqueues highlight events
to highlight-connectors (Readwise). A background worker delivers them with retry/backoff.

### GET /healthz

Unauthenticated. `{"status": "ok", "version": "0.1.0"}`.

---

## Limits

| What | Limit |
|------|-------|
| Batch items per PUT (bookmarks, clippings, documents) | 50 |
| Batch items per PUT (per-book stats) | 20 |
| List page size | default 50, max 100 |
| `progress` string | 4096 bytes |
| position `anchor` / `xpath` | 48 / 120 bytes |
| clipping `text` / `note` / `chapter` | 2048 / 4096 bytes / 64 chars |
| bookmark `xpath` / `summary` | 512 / 256 chars |
| username / password key | 64 / 128 chars |
