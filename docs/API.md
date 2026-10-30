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
    "language": "en",
    "bookfusion_id": "36835"
  }
  ```

  All fields optional strings (≤512 chars). `filename`/`title`/`authors` are stored per
  `(user, document)`; fields the client omits never overwrite previously stored values. Retrieve
  via `GET /api/v1/documents` or joined into `GET /api/v1/progress`.

  **Language.** `language` is the EPUB's `dc:language` as a BCP 47 tag (`"ja"`, `"de-DE"`). It
  only fills a blank, so a language set by hand through `PUT /api/v1/documents/{document}/info`
  stays. A value that isn't a language tag is ignored; the sync itself still succeeds.

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

  BookFusion's storage ignores Range requests, so an EPUB is downloaded whole (limited
  to 200 MiB and 30 seconds), and only its text entries (container, package, and XHTML)
  are decompressed; each is limited to 1 MiB. The server then stores a redacted position
  map per linked book in `epub_maps`: chapter text is replaced with same-length filler and
  only `id` attributes are kept, so no readable book text is stored, yet positions resolve
  identically. Later syncs use the map without downloading; a position that fails against
  it triggers one fresh download and rebuild (the book may have changed). Maps are removed
  when the connector is unlinked or the account deleted, and pruned when their book is no
  longer matched or unused for 30 days. Books matched by title or manual selection retain percentage-only
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

An optional `timestamp` (unix seconds) says when the position was read, for clients that sync
later than they read. The stored time, the reading timeline and "newest wins" then use it instead
of the time of the request. A time in the future is capped at now; a missing one, or one before
2000, means now. `PUT /syncs/progress` and the batch route always use the time of the request, so
a reader with an unset clock can't backdate itself.

An invalid `position` is ignored (the kosync fields still sync); a missing `position` on a later
PUT keeps the previously stored one for that device.

#### PUT /api/v1/progress/batch

Several books' progress in one request, for a reader's bulk sync push: `{"items": [...]}` with 1 to
20 items, each a `PUT /syncs/progress` body (including the optional `position` and `metadata`).
Every item is stored exactly as that route stores it: under the document's canonical hash after a
merge, with a feed sequence number, reading history, and connector fan-out.

All or nothing: if any item is invalid the request is rejected (403, kosync error body) and nothing
is written. Response:

```json
{"accepted": 2, "items": [{"document": "a1b2...", "timestamp": 1752345678},
                          {"document": "25f8...", "timestamp": 1752345678}]}
```

`items[].document` echoes the hash each item was sent with, in request order. Servers without this
route (stock kosync, older crosspoint-sync) return 404; readers then send one `PUT /syncs/progress`
per book.

#### GET /api/v1/progress

Lists every synced document — newest progress across devices, joined with any stored metadata.
This is how clients/UIs discover documents without knowing hashes. `?limit=` defaults to 100
(max 500), ordered newest-first. `next` is `null` on the last page; otherwise pass it back as
`?cursor=` for the following page. A malformed cursor is rejected with `403`.

```json
{
  "items": [
    {"document": "25f8abb4f4f5594f02f361726814fea1",
     "title": "Foundryside", "author": "Robert Jackson Bennett",
     "filename": "Foundryside - Robert Jackson Bennett.epub",
     "percentage": 0.2853, "progress": "/body/DocFragment[16]/body/div[1]/p[143]",
     "device_id": "crosspoint-reader", "device": "CrossPoint", "timestamp": 1783913361}
  ],
  "next": "1783913361:25f8abb4f4f5594f02f361726814fea1"
}
```

`title`/`author`/`filename` are `null` until some client sends metadata for that document.
Items also carry `status`, `status_at` (when a manual status was set, else `null`), `cover_url`, `page_count`, and book details from Hardcover's catalog
when the server sets `HARDCOVER_API_KEY`: `hardcover_slug`, `moods`, `genres`, `content_warnings`
(lists), `rating`, `series`, `series_position`, `release_year` (empty lists / `null` until looked
up; lookups run in the background, a few books per list request, one per distinct book across users).

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

#### GET /api/v1/progress/changes

Progress change feed for incremental device sync: documents whose current position changed since a
cursor, oldest change first.

Query: `since` (cursor from the previous page, default `0` for a full snapshot), `limit` (default
20, max 50; `0` returns only the current `cursor`), `device` (the caller's `device_id`).

```json
{
  "cursor": 4812,
  "more": false,
  "changes": [
    {"document": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "aliases": ["ffeeddccbbaa99887766554433221100"],
     "percentage": 0.4213, "progress": "/body/DocFragment[12]/body/p[3]/text().0",
     "position": null, "device": "Phone", "device_id": "phone", "timestamp": 1791234567}
  ]
}
```

- One entry per document: its newest row (same tie-break as the kosync GET), included only when that
  row changed after `since`. `document` is canonical; `aliases` lists merged hashes.
- Every progress write (kosync and v1 PUTs, connector fan-in, document merges) stamps a server-wide
  sequence number on the row, so the cursor does not depend on `updated_at` (fan-in keeps the
  external service's timestamp). If a write makes an existing row become newest, that winning row
  also receives a fresh sequence so the feed reports the effective position change.
- A document whose newest row was written by `device` is left out; there is no fallback to an older
  row from another device. Server-side merges and switches to an existing row bypass this exclusion
  until the cursor passes that server-side change. The cursor still moves past excluded rows.
- `cursor` is where the next request should start; repeat with `since = cursor` while `more` is
  true. A page also stops before its body passes 8 KB, but always holds at least one change.
- Servers without this route (stock kosync, older crosspoint-sync) return 404; devices fall back to
  per-book requests.

Progress history (`progress_log`, which feeds reading days and streaks) only records a write whose
percentage differs from the previous value. A device's first write for a document compares against
the legacy shared `crossink-device` row when the id is a per-reader `crossink-…` id and that row
exists, otherwise against the document's newest row from any device.

#### DELETE /api/v1/progress/{document}

Removes a synced book completely. Deletes the kosync progress for **every** device plus everything
else stored server-side for that book: position samples, bookmarks, clippings, per-book reading
stats, connector matches and any queued connector events. Document metadata goes too, so the book
disappears from `GET /api/v1/progress` and `GET /api/v1/documents`, and `GET
/syncs/progress/{document}` goes back to returning `{}`.

```json
{"document": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "deleted": true, "rows": 14}
```

`rows` is the number of database rows removed. Returns `404 {"code": 2003, "message": "Unknown
document"}` when the user has no data for that document.

Bookmarks and clippings are hard-deleted rather than tombstoned — there is no book left to
delta-sync against. A device that still holds the file simply re-uploads its state on the next
sync, so this is a server-side reset, not a device-side delete.

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
- `text` ≤ 4096 UTF-8 bytes, `chapter` ≤ 64 chars, `note` ≤ 4096 bytes.
- `note` and `color` are preserved when omitted from updates.
- No per-book cap server-side; the current firmware stores up to 256 active clippings per book.

Endpoints: `GET /api/v1/clippings/{document}?since=&limit=` and
`PUT /api/v1/clippings/{document}` (batch max 50).

Clipping clients should use `GET ...?cursor=0&limit=1&format=reader`. Responses
advertise `sync_version: 2`, include each item's `revision`, and return a monotonic
`cursor` for the next page. Continue until `more` is false. This avoids losing
items that share a second-resolution timestamp. `format=reader` omits `note` and
`color` to bound firmware response memory. Legacy `since` requests remain supported.

`start_offset` and `end_offset` are optional chapter-visible Unicode-codepoint
positions, `[start, end)`, independent of pagination. Supply both or neither.
`layout_signature` preserves compatibility with older page-local word ranges.
A deleted ID cannot be resurrected by a delayed upload; create a new ID to save
the same quote again. Enable **Sync Clippings** in the firmware's **CrossPoint Sync**
settings to sync clippings alongside the current book's manual progress sync.

### Reading stats

Model (matches the firmware's nearby P2P stats sync): **each device uploads its own snapshot;
snapshots replace, never accumulate; the server aggregates across devices on read.** Never merge
another device's stats into local ones.

BookOrbit reading sessions are imported separately for matched books already known to Sync,
including their complete historical session lists. Existing links are picked up automatically;
linking or **Sync now** starts a background pass. The worker continues every minute, processes up
to three books and five 100-session pages per book per pass, and refreshes completed imports hourly.
It also tries matching up to three older/finished local books per pass. Books that exist only in
BookOrbit are not added to the Sync library by this import.

A book's new totals become visible only after all its pages have been validated. Session IDs
deduplicate retries and duplicate book matches. Full reconciliation replaces edited/deleted
sessions; failed requests retain the last complete import. Reading time, session counts, daily
time, history, and time/day histograms join the existing stats responses as a virtual
`connector:bookorbit` device named `BookOrbit`. Page counts and completed-book counts are not
inferred from session durations. Calendar days use the BookOrbit account's timezone (UTC fallback),
splitting sessions across local midnight; historical daily rows are retained beyond the bitmap's
730-day window.

**Overlap policy:** include every BookOrbit source, including KOReader on Kindle, Kobo,
manual entries, and missing/unknown sources, alongside direct device stats. Having a device
snapshot, the same reading date, or an equal duration is not evidence of a duplicate.
Repeated BookOrbit session IDs count once. Rows with different IDs also count once when the
external book ID, source, start timestamp, end timestamp, and duration all match exactly.
Entries without a positive time span are matched only by session ID. Different books, different
sources, and partial time overlaps remain separate. Original imported rows are retained.

Direct device snapshots contain cumulative totals without session IDs, source provenance, or
time intervals. They cannot prove overlap with a BookOrbit session, so no cross-source subtraction
is guessed. If the same physical device's stats are independently uploaded directly and through
BookOrbit, overlap between those channels still cannot be resolved automatically with this
contract. Sync does not export reading stats to BookOrbit, so there is no stats export/import loop.
The stats responses include `bookorbit: { excluded_sessions, excluded_seconds, reason }` for
identifiable repeated records only; the app explains when such duplicates were counted once.
Imported time is never converted into progress-log entries or extra page/sync counts.
Unlinking removes imported stats; relinking clears the old import, and changing
the BookOrbit server/user also clears stale matches, queued exports, and EPUB maps.

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

#### PUT /api/v1/stats/sessions

Uploads measured reading-session checkpoints alongside the existing counters.

```json
{"device_id":"reader-id","items":[{"session_id":"stable-session-id","document":"0123456789abcdef0123456789abcdef","started_at":1609502400,"ended_at":1609503000,"seconds":600,"utc_offset_minutes":0}]}
```

Accepts 1–20 records. IDs are scoped to the authenticated user and device;
`session_id` is 1–64 ASCII letters, digits, `_` or `-`, and `document` is a
32-hex reader document ID. Timestamps are integer Unix UTC seconds; the offset
records the device's local timezone at capture. Active seconds must be at least
10, no greater than the wall-clock span, and the span cannot exceed seven days.
Future timestamps beyond five minutes are rejected. Undated reading remains in
legacy counters and is not manufactured into dated sessions.

Checkpoints retain their ID and original book, start, and timezone. Later
checkpoints may increase both duration and end time; exact or older checkpoints
are acknowledged without decreasing stored values. Inconsistent identities or
mixed-direction updates reject the complete batch.

Returns `{"until":1609503100,"accepted_session_ids":["stable-session-id"]}`.
Readers must verify the specific acknowledged IDs before clearing their outbox.
HTTP success or an old server's generic stats response alone is insufficient.

CrossInk keeps session capture in RAM and writes it at existing reader save points
(progress saves, sleep/exit, tracking disable and restart handoffs), without an
additional per-minute session timer or extra book/global counter snapshots.
Stable IDs still allow cumulative updates at successive save points.

Sessions do **not** add to device totals, book totals, daily counters, or streaks:
those existing snapshots remain authoritative. Linked, enabled BookOrbit accounts
export measured sessions for matched books in bounded background passes. A stable
provider ID makes timeout retries and later checkpoints update the same session.
Old aggregate history remains intact; it is not converted into invented sessions.
XTC stats-only uploads require an existing/manual match because they carry no
book title or author metadata.

BookOrbit currently returns numeric IDs rather than the submitted client ID.
Sync saves a complete preflight ID boundary, verifies the new exact row after
upload, and retains its numeric ownership mapping across unlink/relink. An
uncertain initial export defers that book's history reconciliation while keeping
the previous published history. Verified exported rows are excluded individually
from imported stats; independent Kindle/other reader sessions remain included.
BookOrbit's current client API records these exports as `web` reading sessions.
Export errors appear with the connector's `queue_errors` and retry in the
background (or on **Sync now**). Account switches use separate ownership mappings.

#### PUT /api/v1/stats/books

Batch (max 20) of per-book `stats_v5` snapshots for one device:

```json
{"device_id": "A1B2C3D4", "items": [
  {"document": "a1b2c3d4e5f60718293a4b5c6d7e8f90", "v": 5,
   "sessions": 9, "seconds": 8400, "pages": 310, "completed": false,
   "avg_fwd": 12, "pace_n": 250, "eta": 5400,
   "start_manual": false, "finish_manual": false,
   "start_date": 1751000000, "finished_date": 0,
   "tod": [0, 3000, 4000, 1400], "dow": [0, 0, 1200, 0, 2000, 3000, 2200],
   "daily": [{"date": "2026-10-23", "seconds": 900}]}
]}
```

`daily` is optional: the book's seconds per local day, up to 20 per item, in the same shape as the
global upload's. A day sent again keeps the larger value, so a client can resend today as it grows.
The answer counts them as `accepted_daily`.

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

#### GET /api/v1/stats/overview?tz=&days=&language=&genre=&author=&group_by=&week_start=

A small digest for readers that want to show the account's totals on the device. It has the same numbers
the Stats page shows, from every source: syncs, chosen start and finish dates, and device stats.

```json
{"anchor_day": 9793, "days": 365, "history_b64": "...", "reading_days": 53,
 "current_streak": 2, "longest_streak": 6, "books_finished": 496, "finished_this_year": 31,
 "pages_read": 142177, "seconds": 2880, "sessions": 0, "today_seconds": 420, "week_seconds": 2880}
```

- `tz` is the caller's UTC offset in minutes as JS `getTimezoneOffset()` gives it. It decides what "today" and "this year" are.
- `anchor_day` is today, as days since 2000-01-01. In `history_b64`, bit N (LSB-first per byte) is set when day
  `anchor_day - N` was a reading day. The bitmap covers the last `days` days (default 365, at most 3650), so
  the response stays a few hundred bytes.
- All the counts cover the whole history, whatever `days` is: `reading_days`, the streaks, the finished counts and the pages.
  The time fields come from device stats: `seconds`, `sessions`, `today_seconds`, and `week_seconds` for the
  last 7 days including today. With `week_start=0` (Sunday) or `week_start=1` (Monday), `week_seconds` covers the
  calendar week so far instead, in every group too. Any other value is refused.

Filters narrow the digest to matching books: `language` (main subtag, so `en` also matches `en-GB`),
`genre` (one of the book's genres) and `author` (part of the name). All ignore case and can be combined.
A filtered digest counts only per-book data: the books' sync and session days, their finished counts and
pages, and their measured time (per-book stats and reading sessions). Device-wide totals with no book
attached are left out. Reading days and time per day come from the books' uploaded days, reading
sessions and imported time; where a book's sessions and its devices' days measure the same day, the
larger one counts.

`group_by=language` or `group_by=genre` adds `groups`, one digest per value, for the 20 values with the
most reading days. A book counts in each of its genres. The top-level fields stay the account's (or the
filter's, when one is given).

```json
{"anchor_day": 9793, "...": "...", "groups": {"ja": {"reading_days": 88, "...": "..."}, "de": {"...": "..."}}}
```

#### GET /api/v1/stats/global?device_id=&since=

Raw per-device snapshots (`{"devices": [{"device_id", "device", "updated_at", "stats": {...}}], "until": ...}`)
for clients that render per-device numbers like the P2P screen does. Each device's `stats.daily` lists its days.
`device_id` keeps one device. `since` keeps only the days uploaded at or after that time: pass the `until` of an
earlier answer to fetch what changed since then. Imported BookOrbit time comes whole whenever its import changed.

#### GET /api/v1/stats/books/{document}

Per-device rows plus a `combined` object (scalars/buckets summed, `completed` OR-ed, `avg_fwd`
weighted by `pace_n`, `start_date` = earliest non-zero, `finished_date` = latest). Each row's
`stats.daily` holds that device's days for the book; `combined.daily` sums every device per date. A
device restoring its own history reads its own row, so another device's time is never folded in.

#### GET /api/v1/stats/books?device_id=&limit=&cursor=&since=

Every book's stats, one item per device and book, ordered by document. Each item carries the book's
`title`, `author`, `filename` and `language`, so a client can match it to a file without knowing the
hash, plus `stats` with `daily` as above. Items are stored rows: a merged copy is listed under its own hash, where
`GET /stats/books/{document}` folds it into its book. `device_id` keeps one device's items. `limit` defaults to 50
(at most 200); pass the answer's `next`, URL-encoded, as `cursor` for the following page, until it is `null`.
Treat it as opaque: its format may change.
`since` keeps the books uploaded at or after that time: pass the `until` of an earlier answer (its first page's) to
fetch only what changed since then.

```json
{"items": [{"device_id": "A1B2C3D4", "document": "a1b2...", "title": "Kokoro", "author": null,
  "filename": "kokoro.epub", "language": "ja", "updated_at": 1761300000,
  "stats": {"v": 5, "sessions": 9, "...": "...", "daily": [{"date": "2026-10-23", "seconds": 900}]}}],
 "next": "a1b2...:A1B2C3D4", "until": 1761300100}
```

Merged documents (`POST /api/v1/documents/merge`, `{"document", "into", "stats"?}`): stats rows
stay under the hash each device uploaded them with and are combined on read. With `"stats": true`
(the default) the alias's rows count toward the canonical book, and each row carries its
`document`; with `"stats": false` they are left out. Unmerging hands the alias its stats back.

### Documents metadata (optional)

`PUT /api/v1/documents` — `{"items": [{"document": "...", "title": "...", "authors": "...",
"language": "ja", "filename": "...", "filesize": 812345, "bookfusion_id": "36835"}]}` (max 50).

Each item takes the same fields as progress-PUT `metadata`, with the same rules (see Metadata
capture above): omitted fields never overwrite stored values, `language` only fills a blank, and
`<service>_id` fields seed exact connector matches. `author` is still accepted for `authors`, and
`filesize` is this endpoint's own. Use it for books whose metadata a client knows without a
progress update, e.g. books it only uploads stats for. A merged copy's metadata goes to its book.
`GET /api/v1/documents` lists them, newest first, 500 per page, with the same `next`/`cursor`
paging as `GET /api/v1/progress`.

#### PUT /api/v1/documents/{document}/status

Manual reading status: `{"status": "reading" | "paused" | "finished" | "dnf"}`, or
`{"status": null}` to go back to deriving it from progress. `finished` also fans out a finished
event to linked write-connectors. `GET /api/v1/progress` items carry the effective `status`
(manual, else `finished` at ≥ 98%, else `reading`) and `cover_url`.

#### PUT /api/v1/documents/{document}/dates

Manual reading dates: `{"start_date": "2026-08-11", "finished_date": "2026-08-16"}` as calendar dates
(`YYYY-MM-DD`, no later than tomorrow). An omitted field is left alone; `null` clears it back to the
CrossInk / sync-history date. A start after the finish is a `400`. Manual dates win over device and
derived dates in `/stats/activity` (which flags them with `start_manual` / `finish_manual`). Setting a
finish date also marks the book `finished` and fans out a finished event dated that day. Response:
`{"document", "start_date", "finished_date", "status"}` with dates as unix seconds at UTC midnight.

#### GET /api/v1/documents/{document}/cover

`{"url": "https://..." | null, "pages": 433 | null}`: cover URL and print-edition page count,
resolved from the document's title/author and cached (a miss is retried after 7 days). Covers come
from iTunes Search (ebooks), then Open Library; page counts from Open Library, then Google Books when
the server has `GOOGLE_BOOKS_API_KEY`, then Amazon's "Print length" via SearchAPI when it has
`SEARCHAPI_KEY`. `GET /api/v1/progress` items also carry `page_count`.

#### PUT /api/v1/documents/{document}/info

Manual fixes when the lookup got it wrong: `{"cover_url": "https://...", "page_count": 433,
"genres": ["Fantasy", "Heist"], "moods": ["Tense"], "series": "The Founders", "series_position": 1}` (every
field optional). Manual values stick: lookups only fill blanks, and Hardcover's lookup leaves details set here
alone. `null` clears a field so it's looked up again.

The details Hardcover fills in can all be set this way:

- `genres` (up to 10), `moods` (up to 12) and `content_warnings` (up to 12): lists of names of at most 64
  characters. A list replaces the stored one, so to add one send the current list with it. Names are stored
  the way Hardcover's are (trimmed, one per name whatever the case, first letter capitalized), so "dark" set
  here and Hardcover's "Dark" count as one.
- `description`: up to 6000 characters.
- `release_year`: a whole number from 1 to 9999.
- `series` with an optional `series_position` (a number from 0 to 10000). They go together: a series set here
  replaces Hardcover's series and number, and next-in-series lookups stop for the book, since they follow
  Hardcover's series. `series_position` without `series` is rejected; `series: null` hands both back.

`language` (a BCP 47 tag) can be set the same way and then stays over device syncs; `null` clears it so the
next device sync fills it again. Returns the stored `{document, cover_url, page_count, title, author, language,
genres, moods, content_warnings, description, series, series_position, release_year}`.

#### GET /api/v1/documents/{document}/about

The book's description: `{"description": "...", "manual": false}`. `manual` is true when the description was set
with `PUT /info`, so a client can drop the Hardcover credit. `description` is null when there is none.

#### GET /api/v1/documents/{document}/cover/candidates?q=

Up to 12 covers to choose from (`{"items": [{url, title, author, source, pages}]}`), best matches
first, from Apple Books and Open Library. `q` searches a different title.

#### GET /api/v1/clippings

Every live clipping across all books, newest first (max 5000): `{"items": [{document, id, spine,
para, start_offset, chapter, text, note, created_at}]}`. Read-only convenience for apps; devices
keep using the per-document delta sync.

#### GET /api/v1/stats/activity?tz=

Pages and books derived from the progress history, for readers that never send stats (stock
CrossPoint, KOReader). Every progress change is logged server-side. `tz` is the client's
`Date#getTimezoneOffset()` so days bucket locally.

```json
{"pages_total": 1923,
 "books": [{"document": "...", "started_at": 1790000000, "last_at": 1790600000, "percentage": 0.997,
            "finished_at": 1790600000, "page_count": 400, "pages_read": 399,
            "days_to_finish": 7}],
 "days": [{"day": "2026-09-28", "pages": 56, "syncs": 4,
           "books": [{"document": "...", "pages": 56, "syncs": 4, "from": 0.41, "to": 0.55}]}]}
```

Pages are print pages (furthest percent x page count), not screen pages. A day's `pages` counts only
forward progress after a book's first logged sync, as a running max across devices; `syncs` counts
every logged sync that day, so any day with a sync is a reading day. `books` breaks the day down per
book for a reading timeline; `from`/`to` are the furthest position before and after that day. History from before the log
existed is backfilled from progress samples (migration 0013). `started_at` is CrossInk's
`start_date` (pinned to local noon on that day) when a device reported one, else the first sync. `finished_at` is CrossInk's
`finished_date` (pinned to local noon on that day) when a device reported one, else the first sync at
>= 98%, overridden by a manual status. A CrossInk finish day with no sync still gets a `books` entry
(`syncs: 0`) so the timeline can show it. `days_to_finish` counts calendar days from start to finish,
both included (a one-day read is 1); it is null when unfinished, finished only by a manual status, or
already finished on the first sync with no CrossInk start date. This never estimates reading time.

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
    {"id": "hardcover", "name": "Hardcover", "tier": 1, "beta": false,
     "carries": ["progress", "finished"], "capabilities": {"read": false, "write": true},
     "credential_kind": "token", "linked": true, "status": "ok", "account": "julia",
     "queue": {"pending": 0, "dead": 0}, "queue_errors": []},
    {"id": "readwise", "name": "Readwise", "tier": 1, "beta": false,
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

#### PUT /api/v1/connectors/{id}/options

Change a linked connector's per-account options. Connectors with options list them in
`GET /connectors` as `options` (`{key, label, default, choices?, gates?}`) with the current
`option_values`. Body: a partial `{"key": value}`; unknown keys and bad values are ignored.
Returns `{"id", "option_values"}`. Turning off a toggle that `gates` a kind drops that kind's
pending queue rows. Hardcover: `highlights` (bool, default `false`) posts clippings as journal
quotes; `privacy` is `private` (default), `follows`, or `public`.

#### DELETE /api/v1/connectors/{id}

Unlink; wipes the stored credential, all matches, and queued work.

#### GET /api/v1/connectors/{id}/matches

Lists resolved book matches (for a review UI): `{"connector": "hardcover", "matches": [{"document",
"external_id", "confidence", "source": "auto|manual|none", "query_used", "updated_at"}]}`.
The review endpoint (`GET /connectors/{id}/review`) additionally carries `push_note`: a
per-book condition from the last successful push (e.g. Hardcover has no page count for
the book, so progress cannot sync), or null. Cleared automatically when the condition
resolves or the match changes.
It lists every synced book, newest first, 500 per page, with the same `next`/`cursor` paging as
`GET /api/v1/progress`.

#### PUT /api/v1/connectors/{id}/matches/{document}

Manually set a match (sticky — never auto-recomputed). Body `{"external_id": "42"}`, or
`{"external_id": null}` to mark "never sync this document".

#### POST /api/v1/connectors/{id}/rematch/{document}

Force (re)matching now; returns the resolved match or null. Preserves manual overrides.

#### POST /api/v1/connectors/{id}/library/refresh

Force-refresh the connector's server-side library list. `{"count": 2}`. 400 for
connectors without a refreshable library.

#### POST /api/v1/connectors/{id}/lookup

Verify an externally-supplied book id against the user's account at the service.
Body `{"external_id": "…"}`. `{"found": true, "book": {"externalId", "title",
"author", "edition"}}` or `{"found": false}`. 400 for connectors without lookup.

**Matching** is server-side from the document's title/author (the EPUB metadata the firmware sends —
so connectors need "Send Metadata" on). **Fan-out** is automatic: a progress PUT enqueues a
progress/finished event to write-connectors that carry it; a clippings PUT enqueues highlight events
to highlight-connectors (Readwise, BookOrbit, and Hardcover when its `highlights` option is on). A background worker delivers them with retry/backoff.
**Fan-in** (read connectors: Audiobookshelf, Jellyfin, BookOrbit, Readwise Reader, BookFusion) is pulled on a
background interval for library-wide providers, and on-demand — when a device asks for progress on a
matched book — for per-book providers. Jellyfin and Spotify also run an hourly per-match pull for users
with matched books.
BookOrbit also pulls highlights on that refresh: each one is placed by its CFI in BookOrbit's copy of
the EPUB and stored as a clipping (chapter codepoint offsets, firmware-style id), skipped when the same
quote is already a clipping on the book, live or deleted.

For outgoing BookOrbit clippings, older records without text offsets are located by their full
quote in BookOrbit's EPUB. Whitespace, soft hyphens, and straight/curly quotation-mark differences are ignored; the match must be
unique across the whole book. Missing or ambiguous quotes fail explicitly rather than guessing
a location. When the formatting comparison finds nothing, long quotes (at least 40 characters
after normalization) can match with case and punctuation differences ignored, again requiring
the entire quote to be unique. Short selections remain strict. Clippings with offsets continue
to use their exact saved positions and text checks.

The connector list includes `queue_errors: [{kind, message, count}]` for linked services: up to
three recent grouped failures for that user's service, including pending retries and permanently
failed items. Completed items no longer contribute errors. Settings shows waiting/failed counts
and these messages, refreshing every five seconds while work is pending. The "Sync now" response's
`queued` value counts export items (progress and individual clippings), not distinct books or
successful deliveries. "Sync now" also requeues failed items for another attempt. For
Audiobookshelf it first pulls every matched book's position (the response adds `pulled`); the
server also pulls those positions every 15 minutes, so listening shows up without opening the book
on a reader.

### Auto-pause

Books in progress (status unset or `reading`) with no new position for the account's
auto-pause days become `paused` with `pause_reason: "auto"`; any new position un-pauses them.
`GET /api/v1/account/auto-pause` returns `{ "days": 30 }` (the default). `PUT` with
`{ "days": 0-365 }` sets it (`0` = never, `null` = back to the default). Changing it applies at
once: auto-paused books the new window no longer covers go back to reading, and books now past it
are paused. Manual pauses are left alone.

### Public profile

`GET /api/v1/profile` returns `{ "slug": null }` while off. `PUT /api/v1/profile` with
`{ "enabled": true }` turns it on and returns the random `slug` (kept while on; off then
on makes a new one). The public page is `GET /u/{slug}`: no auth, HTML with reading
stats, the books being read and the finished ones, embeddable in an iframe. 404 when off.

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

### Reading-history import

`POST /api/v1/account/import/history?preview=1` accepts authenticated multipart
form data with `file` (Goodreads/StoryGraph CSV, KOReader/KOInsight SQLite, or a ZIP
containing one supported database) and `timezone` (an IANA identifier). Preview
validates the file without writing account data. `/account/import/koinsight`
remains an alias for compatibility.

Database previews return `{ kind: "activity", source, books: [{ document, title,
author, start_date, finished_date, completed, existing_history, status, records }] }`.
To commit, POST the same file/timezone without `preview=1`, plus `choices`: a JSON
object mapping every preview document to a reviewed finish date or null for
unfinished. The previous `finishes` form field is also accepted. The response is
`{ books, imported_history, preserved_history }`.

CSV previews return `{ kind: "tracker", source, skipped, warnings, library, books }`.
Each book includes `source_id`, `title`, `author`, `isbn`, `user_rating`, `page_count`,
`status`, `start_date`, `finished_date`, `target`, `locked`, and `candidates`.
`target` is an existing document ID, `"new"`, or an empty string requiring a choice.
Commit with `choices` keyed by every `source_id`, each containing:

```json
{"target":"new","status":"finished","start_date":null,"finished_date":null}
```

`target: null` skips a row. Dates are `YYYY-MM-DD` or null, independently of status.
A known source identity cannot be redirected to another book. Targets must belong
to the signed-in account. Two rows cannot target the same book. All choices are
validated before a transactional write. The CSV response includes `books` and
`skipped`; no activity snapshots or reader positions are created.

See [supported fields, matching and limits](account-migration.md#import-reading-history).
The Library response includes nullable `isbn` and `user_rating` fields; `rating`
continues to mean the community catalog rating. Activity books include `completed`
independently of `finished_at`; undated finished books count in the all-time overview
but not `finished_this_year`.

`GET /api/v1/progress?include_history=1` includes metadata-backed historical books
with statistics, activity, or a manual status even when they have no current
progress. These rows have `history_only: true`, null `percentage`, `progress`,
`device_id`, and `device`; their timestamp comes from their last historical activity
or metadata. Pagination works across current and historical books. The app uses
this option for its Library. Without this option, the endpoint continues to return
only synced progress; the KOReader sync and progress change endpoints are unchanged.
