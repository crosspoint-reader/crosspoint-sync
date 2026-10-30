# Syncing CrossInk Reading Stats to crosspoint-sync

A firmware integration guide for shipping per-book and overall ("global") reading-stats sync
against `https://sync.crosspointreader.com` (or any self-hosted crosspoint-sync instance).
It maps CrossInk's existing structs (`BookReadingStats`, `GlobalReadingStats`) onto the wire
format 1:1 — no on-device data-model changes are needed.

Full endpoint reference: [docs/API.md](../API.md) (§ Reading stats).

## The model in one paragraph

Stats sync works exactly like CrossInk's nearby (ESP-NOW) stats sync, just with a server in the
middle. **Each device uploads its own snapshot; a re-upload replaces that device's previous
snapshot; nothing is ever merged into another device's numbers.** The server keeps one row per
`(user, device_id)` for global stats and one per `(user, device_id, document)` for book stats,
and computes combined views on read. So the device-side logic is: serialize current stats →
PUT → done. There is no diffing, no conflict handling, and re-sending the same snapshot twice
is harmless.

## Prerequisites (all already in the firmware)

- **Auth**: the same headers the KOReader sync client already sends —
  `x-auth-user` / `x-auth-key` from `KOReaderCredentialStore`. No new credentials.
- **HTTP + TLS**: same `SecureHttpClient` path used for kosync (TLS 1.3 / wolfSSL, ≥55KB heap
  before handshake).
- **JSON**: ArduinoJson.
- **device_id**: any stable per-device string ≤128 chars. Recommendation: reuse whatever the
  kosync client sends as `device_id`, or derive `"crossink-" + MAC hex`. This is the key that
  keeps devices' snapshots separate — it must not change across boots.
- **document hash**: the same 32-hex id used for progress sync (`KOReaderDocumentId`, filename
  or binary method per the device setting). Book stats and progress for the same book should use
  the same hash so a future UI can join them.

## 1. Overall stats — PUT /api/v1/stats/global

Send after a reading session ends (or from the sync menu). One small JSON object, ~500 bytes:

```json
{
  "device_id": "crossink-a1b2c3d4e5f6",
  "device": "CrossInk",
  "v": 5,
  "sessions": 312,
  "seconds": 184300,
  "pages": 9120,
  "completed": 14,
  "tod": [1200, 84000, 60100, 39000],
  "dow": [8000, 9000, 7000, 11000, 12000, 60000, 77300],
  "anchor_day": 9650,
  "history_b64": "<base64 of readingHistoryBits, 92 bytes -> 124 chars>",
  "streak": 21
}
```

Field mapping from `GlobalReadingStats`:

| JSON | struct field | notes |
|------|--------------|-------|
| `v` | — | schema version; send `5` (bump if the struct changes) |
| `sessions` | `totalSessions` | |
| `seconds` | `totalReadingSeconds` | |
| `pages` | `totalPagesTurned` | |
| `completed` | `completedBooks` | |
| `tod` | `timeOfDaySeconds[4]` | [morning, afternoon, evening, night], same order as on device |
| `dow` | `dayOfWeekSeconds[7]` | Mon..Sun, same order as on device |
| `anchor_day` | `readingHistoryAnchorDay` | days since 2000-01-01, unchanged |
| `history_b64` | `readingHistoryBits[92]` | plain base64 of the raw 92 bytes; bit semantics unchanged (bit 0 = anchor day, bit N = anchor_day − N, LSB-first per byte) |
| `streak` | `longestReadingStreak` | |

Response: `200 {"until": 1752345678}`. Non-200 → treat like a kosync sync failure (show error,
retry later); the server state is unchanged on validation failures (`403 {"code":2003,...}`).

Sketch (ArduinoJson):

```cpp
JsonDocument doc; // ~1KB is plenty
doc["device_id"] = deviceId;
doc["device"]    = "CrossInk";
doc["v"]         = 5;
doc["sessions"]  = g.totalSessions;
doc["seconds"]   = g.totalReadingSeconds;
doc["pages"]     = g.totalPagesTurned;
doc["completed"] = g.completedBooks;
JsonArray tod = doc["tod"].to<JsonArray>();
for (auto s : g.timeOfDaySeconds) tod.add(s);
JsonArray dow = doc["dow"].to<JsonArray>();
for (auto s : g.dayOfWeekSeconds) dow.add(s);
doc["anchor_day"]  = g.readingHistoryAnchorDay;
doc["history_b64"] = base64Encode(g.readingHistoryBits.data(), 92);
doc["streak"]      = g.longestReadingStreak;
// PUT to <serverUrl>/api/v1/stats/global with the kosync auth headers
```

## 2. Per-book stats — PUT /api/v1/stats/books

Batch endpoint: up to 20 books per request, one `device_id` per request. Syncing just the
currently open book after each session is the simplest correct behavior; a "sync all" menu action
can page through every book with stats in chunks of 20.

```json
{
  "device_id": "crossink-a1b2c3d4e5f6",
  "items": [
    {
      "document": "25f8abb4f4f5594f02f361726814fea1",
      "v": 5,
      "sessions": 9,
      "seconds": 8400,
      "pages": 310,
      "completed": false,
      "avg_fwd": 12,
      "pace_n": 250,
      "eta": 5400,
      "start_manual": false,
      "finish_manual": false,
      "start_date": 1751000000,
      "finished_date": 0,
      "tod": [0, 3000, 4000, 1400],
      "dow": [0, 0, 1200, 0, 2000, 3000, 2200]
    }
  ]
}
```

Field mapping from `BookReadingStats` (stats_v5):

| JSON | struct field | notes |
|------|--------------|-------|
| `document` | — | same hash used for this book's progress sync |
| `sessions` | `sessionCount` | |
| `seconds` | `totalReadingSeconds` | |
| `pages` | `totalPagesTurned` | |
| `completed` | `isCompleted` | boolean |
| `avg_fwd` | `avgSecondsPerForwardPage` | |
| `pace_n` | `paceSampleCount` | used server-side to weight combined pace |
| `eta` | `estimatedTimeLeftSeconds` | |
| `start_manual` / `finish_manual` | `startDateManual` / `finishedDateManual` | booleans |
| `start_date` / `finished_date` | `startDate` / `finishedDate` | **convert to unix seconds** (midnight UTC of the stored date); send `0` for "not set" |
| `tod` / `dow` | `timeOfDaySeconds` / `dayOfWeekSeconds` | same order as on device |

Response: `200 {"until": ..., "accepted": <n>}`. All integers must be non-negative JSON numbers
and booleans real booleans — the server rejects the whole batch with 403/2003 if any item is
malformed, so nothing partial is written.

## 3. Reading combined stats back (optional, for the stats screen)

### Two-way reading streak

`GET /api/v1/stats/streak?tz=<minutes>` returns a compact calendar for readers:

```json
{"v":1,"anchor_day":9799,"history_b64":"<92 bytes in base64>","streak":21,"current_streak":5}
```

`tz` follows JavaScript's `Date#getTimezoneOffset()` convention (New York at
UTC−4 sends `240`). The anchor is today in that timezone; bit N represents
`anchor_day - N`, with the same bit order as global uploads. The 730-day bitmap
combines device calendars, recorded daily reading, imported BookOrbit days,
progress-sync days, and the calendar's chosen start/finish dates. Duplicate days
count once; future dates are excluded. Longest streak uses all available dated
history, including dates older than the bitmap. Current streak allows today to
remain unread and is bounded by the 730-day reader window.

CrossInk downloads this after uploading overall stats, including from an empty
device with nothing to upload. It keeps a separate, server/account-specific
calendar and combines it with local reading only when displaying streaks.
Downloaded history and totals never become part of device uploads or nearby
exports. Each successful download replaces the cached server calendar so date
edits take effect; local offline reading is preserved. Older servers returning
404/405 continue to sync without this download. Failed or malformed responses
retain the last good calendar. Reading Stats must be enabled under What to Sync.

### Other combined statistics

- `GET /api/v1/stats/summary` — everything already combined server-side: scalars and `tod`/`dow`
  summed across devices, history bitmaps OR-ed after re-anchoring to the newest `anchor_day`,
  `streak` (all-time longest) and `current_streak` recomputed from the combined calendar. The
  response is the same shape as the global upload plus `current_streak` and a `devices` list —
  render it exactly like the local stats screen renders `GlobalReadingStats`.
- `GET /api/v1/stats/global` — raw per-device snapshots, if you want the nearby-sync-style
  per-device display instead. Note this returns *other devices' snapshots too* — same rule as
  nearby sync: display, never merge into local files.
- `GET /api/v1/stats/books/{document}` — per-device rows plus a `combined` object for one book.

The streak response fits a 256-byte receive buffer. Other responses grow with
history and device count; do not buffer them in the reader's streak-sync path.

## 4. When to sync

Suggested triggers, mirroring the existing kosync UX:

1. **On the existing KOReader-sync action** (user already has WiFi up): after progress sync,
   also PUT global stats + current book's stats. Two extra small requests on an
   already-established connection.
2. **Manual "Sync stats" menu item**: pages through all books with local stats in batches of 20.
3. Never on a timer — WiFi is expensive on this hardware; piggyback on user-initiated syncs.

Ordering doesn't matter and retries are safe (uploads are idempotent replacements). If the device
was offline for a month, one sync catches everything up — snapshots carry totals, not deltas.

## 5. Related integrations worth pairing with stats

- **Document metadata**: book-stats rows are keyed by document hash only. If the device also sends
  the optional `metadata: {filename, title, authors}` object with its progress PUTs (the
  crosspoint-reader "Send Document Metadata" setting, KOReader PR #15306 shape), the server stores
  title/author per document — so any stats UI can show "Foundryside · 2h 20m" instead of a hash.
  No stats-side changes needed; it's a progress-sync feature that stats views benefit from.
- **On-device sign-up**: the server has open registration (`POST /users/create` with
  `{username, password: md5}` → 201, or 402 if taken). crosspoint-reader now exposes this as a
  "Sign Up" button next to Authenticate; CrossInk can mirror that so first-time users never need
  a computer. See `KOReaderSyncClient::createUser()` in crosspoint-reader for a reference
  implementation.
- **Default-server migration caution**: if CrossInk also changes its default sync server to
  crosspoint-sync, replicate crosspoint-reader's config-version migration: a pre-existing config
  with credentials and an *empty* server URL was implicitly syncing to sync.koreader.rocks — pin
  that URL explicitly on upgrade instead of silently moving the user (crosspoint-reader's
  `KOReaderCredentialStore::fromJson` cfgVersion 2 migration is the reference).

## 6. Gotchas

- **Don't sum server data into local files.** Same invariant as nearby sync. Local
  `global_stats.bin` remains this device's truth; the server combines on read.
- **`device_id` stability is the whole ballgame.** If it changes (e.g. derived from a setting a
  user can edit), the server sees a "new device" and totals double. Derive from MAC.
- **Dates**: `ReadingStatsDate` → unix seconds conversion is the only real data transform in this
  integration; `0` means unset on the wire.
- **Bitmap**: send the raw 92 bytes base64'd — do not re-pack or reverse bit order; the server
  uses the device's exact semantics.
- **Heap**: both PUT bodies are < 1.5KB; a single 2KB JsonDocument covers every request and
  response in this guide. The TLS handshake (~55KB) remains the binding constraint, same as
  kosync today.
- **Auth failures** return the familiar kosync error shape (`401 {"code":2001,...}`) — the
  existing error handling paths apply as-is.
