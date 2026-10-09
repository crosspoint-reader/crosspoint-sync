# Design: Incremental Bulk Sync

Status: **implemented, not yet released.** Rollout steps 1 to 5 are done: the server change feed
(step 2) in this repo, and the firmware steps (1, 3, 4, 5) plus the separate alternate-method fix on
CrossInk's `feat/sync-server-file-transfer` branch, pending merge. Readers need a server with the
change feed for incremental syncs; older servers keep the per-book walk.

Make CrossInk's bulk sync actions (Sync Books, today called Sync All Books, and Sync Folder) cost
work proportional to the number of books that **changed**, not the size of the library. Spans both
repos: a progress change feed in crosspoint-sync, and in CrossInk a pending-push list, a sync-owned
document-id map, and parked remote positions. Nothing depends on the Library index, so File
Browser-only users behave the same as Library users.

## Problem

Today every bulk action visits every book in scope
(`crossink/src/activities/network/StatsUploadActivity.cpp`):

| Book state | SD work | Network |
| --- | --- | --- |
| Never opened | Construct `Epub`, read progress, compute KOReader document hash | Usually none (stats/clippings come back `Skipped`) |
| Read, unchanged since last sync | Full EPUB metadata load | 1 progress GET, plus stats PUT and clippings PUT **every time** |
| Read since last sync | Full EPUB metadata load | Progress GET + PUT, stats PUT, clippings PUT |

- Syncing 3 recently read books in a 50-book `/Read` folder still does ~47 books of TLS round trips.
- The upload button on the Reading Stats screen runs Sync All Books
  (`BookStatsActivity::startSyncAllBooks`, `Scope::Library`), so it walks the whole Library index,
  not just overall stats.
- Smart sync skips the progress **PUT** when local and remote are within 0.1%
  (`KOReaderSyncActivity.cpp`), but the GET still happens for every book.
- The only incremental piece is the daily global counters (`counter.uploaded == counter.seconds` in
  `ReadingSyncUpload::globalStats`).

The per-book GET is also the **only** way remote progress reaches the device. Nothing syncs
automatically when a book is opened, so a bulk action cannot simply become push-only.

## Goals

- Bulk sync cost scales with books changed on either side, not library size.
- Remote progress (phone, another reader, fan-in connectors) still reaches the device in bulk.
- Reading Stats upload sends only stats.
- Stock KOSync servers keep today's behavior unchanged.
- C3-safe: fixed small RAM, streaming SD reads, no new per-book heap growth.

Non-goals (v1): pulling stats or clippings from the server, background or automatic sync, triggering
per-book connector refreshes (BookFusion/Kindle) from the feed.

## Overview

```
                 pull                                   push
device  --GET /api/v1/progress/changes?since=N-->  server
        <--[{document, aliases, ...}]--
          | match via sync_ids.bin (books touched on this device)
          | only books inside the sync's scope: apply if remote is further ahead,
          |   else mark local book pending; books outside the scope are left alone
          | unmatched: park remote position, offer it when the book is first opened
          |   (only if the book is inside a prepared scope)
        --PUT progress / stats / clippings for pending books only-->
```

The work ships in five steps plus one separate fix; see Rollout for the order and dependencies.

## 1. Targeted uploads: Reading Stats and Clippings

Two single-purpose actions that never pull and never push progress. Both use the existing Wi-Fi flow
and result screen.

**What to Sync toggles govern everything.** Reading Stats and Clippings sync are off by default and
turned on under Settings → System → Sync Server → What to Sync. Every action follows them: Sync
Books and Sync Folder skip a data type whose toggle is off, and the targeted rows below only appear
when their toggle is on.

- **Toggle off:** nothing is marked. `BookReadingStats::save` and clipping store writes do not set
  `STATS` / `CLIPPINGS` pending bits, and existing bits of that type are cleared, so the pending
  list never accumulates entries for data the user chose not to sync.
- **Toggle turned on:** its catch-up flags are cleared, both the whole-card flag (`statsCaughtUp` /
  `clippingsCaughtUp`) and the matching bit on every prepared scope. The next sync that includes
  that data type runs a catch-up (below) for its own scope to find everything changed while it was
  off. That walk is the cost of having turned syncing off.

Clippings sync only from File Transfer's Sync Clippings, or as part of Sync Books / Sync Folder /
Sync Book when the Clippings toggle is on.

- **Reading Stats upload.** `BookStatsActivity::startSyncAllBooks` stops launching `Scope::Library`.
  It uploads overall stats and daily counters through `ReadingSyncUpload::globalStats()`, plus
  per-book stats for pending entries with `STATS` set (section 2), clearing that bit on success.
  Per-book stats go in batched requests: `PUT /api/v1/stats/books` already accepts an `items` array
  (`MAX_BOOK_BATCH`), and each request costs a TLS handshake on the device. The Reading Stats
  screen's sync button follows the same visibility rule as File Transfer's Sync Reading Stats (today
  it checks credentials only).
- **Sync Clippings (new).** An action in File Transfer (below). Uploads clippings for pending
  entries with `CLIPPINGS` set, through the existing `ClippingsUpload::upload`, clearing that bit on
  success. Today clippings only upload as part of a book sync (`ReadingSyncUpload::extras`).

**Visibility rule** for Sync Reading Stats, Sync Clippings, and the Reading Stats screen button:
credentials exist, the server's support is known to be `SyncServerSupport::SUPPORTED` (an `UNKNOWN`
custom server hides them until Authenticate or a first upload confirms support), and the matching
What to Sync toggle is on.

Before the pending list ships (rollout step 1), Sync Reading Stats runs the stats-only card walk
below every time and Sync Clippings runs the clippings-folder listing every time. After it ships
they upload pending entries, plus a **one-time catch-up** for data saved before upgrading that
nothing marked as pending. Each catch-up runs once each time it is needed (after upgrading, or after
its toggle is turned back on), is recorded in `sync_state.bin` (`statsCaughtUp`,
`clippingsCaughtUp`), and shows its own progress text with Exit available; an interrupted catch-up
is not recorded as done, and the next run resumes where it stopped.

A catch-up cannot tell which books changed while the toggle was off, so it re-sends everything of
its type: every book's stats (batched; the server overwrites with the same values) and every book's
clippings (one request per book). For a reader with hundreds of annotated books, turning Clippings
back on means one longer sync, with progress text and Exit. The user docs say so.

- **Sync Reading Stats catch-up: walks the card.** Per-book stats live in each book's `epub_<hash>/`
  (or XTC) cache folder, named by a hash of the book path, and the cache does not record which book
  it belongs to. So the catch-up walks the card with `FolderBookIterator("/")` and, per EPUB/XTC
  book, only checks whether a stats file exists (path hash plus one exists check). Only books with
  stats need their document id (free in filename mode, the ~8 small reads in binary mode, recorded
  in the book cache, and in `sync_ids.bin` unless the book is finished). No EPUB loading, no
  progress requests. Uploads are batched. Progress text: "Scanning your SD card for reading stats…".
  An interrupted catch-up resumes the same way as a first walk: a catch-up id stored with its scope
  in `sync_state.bin` (the whole-card entry, or the folder's entry for a folder catch-up), stamped
  into each processed book's cache sync file, and skipped on resume. Folder catch-ups can be
  interrupted and resumed independently of each other.
- **Sync Clippings catch-up: no card walk.** All clippings live in one folder,
  `/.crosspoint/clippings/`, and each file's header stores the book path (`ClippingFileHeader` in
  `src/ClippingStore.cpp`). The catch-up lists that folder, reads each header, skips books that no
  longer exist, gets the id, and uploads. Progress text: "Checking clippings…".
- **Catch-ups are per scope.** Besides the whole-card flags, each prepared scope in `sync_state.bin`
  carries its own `statsCaughtUp` / `clippingsCaughtUp` bits.
  - **First walk:** a completed first walk of a scope reconciles stats and clippings for its books,
    so it sets that scope's bit for each toggle that was on for the whole walk. A type whose toggle
    was off is not uploaded and its bit stays clear. A completed `/` walk also sets the whole-card
    flags.
  - **Later syncs:** when Sync Books or Sync Folder runs with a toggle on and its scope's bit is
    clear (for example the toggle was just turned on, or the scope was walked while it was off), it
    runs that catch-up for its own scope before its pull, with the same progress text and Exit, then
    sets the bit.
  - **Folder catch-ups stay in the folder:** stats walks only that folder (one stats-file check per
    book, no EPUB loading); clippings lists `/.crosspoint/clippings/` and keeps files whose header
    path is inside the folder (no walk). A folder-only user never walks the rest of the card.
  - **Whole-card catch-ups** (Sync Books, or the targeted Sync Reading Stats / Sync Clippings rows)
    set the whole-card flag and the bit on every prepared scope, since they cover them.
- Resetting the server URL or username clears both flags along with every cursor.

### Entry points: a Sync Server section in File Transfer

Sync actions move out of Settings into File Transfer (`NetworkModeSelectionActivity`), next to the
other ways of moving books and data between devices. Settings → System → Sync Server keeps only
configuration (credentials, server URL, and the stats, clippings, behavior, matching, and metadata
options).

- New **Sync Server** section in File Transfer, grouped like the existing Nearby device section,
  with up to three rows that follow one naming pattern:
  - **Sync Books**: the full bulk sync (same `StatsUploadActivity` flow and confirmation). Renames
    today's "Sync All Books" (`STR_SYNC_ALL_BOOKS`) everywhere it appears, including the bulk sync
    screen title and confirmation; update every translation file.
  - **Sync Reading Stats**: the stats-only upload above.
  - **Sync Clippings**: the clippings-only upload above.
- File Transfer is the only home for these actions. Remove Sync All Books from Settings → System →
  Sync Server.
- Sync Books is always visible; without credentials, selecting it shows the existing
  `STR_SET_CREDENTIALS_FIRST` message, worded to point at Settings → System → Sync Server. Sync
  Reading Stats and Sync Clippings follow the visibility rule above (credentials, confirmed server
  support, and their What to Sync toggle on).
- The Reading Stats screen's own sync button stays as the stats-only upload. Sync Folder and
  per-book Sync Book stay in their context menus.
- "Sync Books" (bulk) and "Sync Book" (one book, context menus) differ by one letter. They never
  appear on the same screen, but check the translations keep them distinct.
- **Sequencing:** `fix/sd-card-plugins` also adds a File Transfer item (OPDS). Rebase it onto
  `development` and land it before this menu change, then add the Sync Server section on top.

## 2. Pending-push list (firmware)

A small SD file listing books whose local state changed since their last successful upload.

- **Path:** `/.crosspoint/sync_pending.bin`.
- **Format:** version byte, then per entry: a `u8` dirty mask (`PROGRESS`, `STATS`, `CLIPPINGS`),
  then a length-prefixed absolute path. Expected size is tens of entries, so a linear dedupe scan on
  append is fine; appending an existing path ORs its mask in place.
- **Append points:** where the reader already persists per-book state: progress save sets
  `PROGRESS`, `BookReadingStats::save` sets `STATS`, clipping store writes (add, edit, delete) set
  `CLIPPINGS`. `STATS` and `CLIPPINGS` are only set while their What to Sync toggle is on. The
  reader keeps an in-memory "already marked" flag per bit for the open book, so each bit is written
  at most once per reading session, however often progress is saved.
- **Removal:** each successful upload clears its own bit; the entry is removed when the mask is
  empty. A failed upload keeps its bit. Only data that changed is sent: a book whose progress moved
  does not re-upload unchanged clippings.
- **Folder scope:** filter entries by path prefix.
- **Size** is bounded by books changed since their last upload, not library size, because data types
  that are toggled off are never marked.
- **Writes are atomic** (see "Crash-safe sync files" in section 4): the list is small, so every
  change rewrites it through `.tmp` and keeps the previous version as `.bak`.
- **The file is never deleted.** An empty list is a valid file with just the version byte, so a
  missing file can be told apart from one that was never needed.
- **Missing or corrupt file (and `.bak` also bad):** if `sync_state.bin` shows no prepared scopes
  and no completed catch-ups, this is a reader that has never synced: create an empty list. If it
  does, the list was lost: treat it as empty, and clear the prepared scopes and both catch-up flags,
  so each scope re-runs its one-time walk and each catch-up runs again. Unpushed changes are
  recovered by those runs.
- **Renamed, moved, or deleted books:** see "Renames, moves, and deletes" in section 4. In-app
  renames and moves rewrite the entry's path; in-app deletes remove it. A path changed on a computer
  fails `Storage.exists`; the entry is dropped with a log line, and the book's next local change
  re-adds it.

Push without a GET is safe because the pull (section 4) runs first and has already compared remote
state for every book it touched. The exception is a book the user skipped in Ask mode: see "Ask on
conflicts in a batch" in section 4.

## 3. Progress change feed (server)

### Sequence column

`progress.updated_at` cannot be the cursor. Fan-in stores the external service's timestamp
(`connectors/fanin.ts`, `exact ? ch.updatedAtMs / 1000 : nowSeconds()`), so a Kindle position
imported today can carry yesterday's `updated_at` and would fall behind a timestamp cursor.

Migration `0024_progress_change_seq.sql`:

```sql
CREATE TABLE change_seq (id INTEGER PRIMARY KEY CHECK (id = 1), value INTEGER NOT NULL);
ALTER TABLE progress ADD COLUMN change_seq INTEGER NOT NULL DEFAULT 0;
UPDATE progress SET change_seq = rowid;
INSERT INTO change_seq (id, value) VALUES (1, COALESCE((SELECT MAX(change_seq) FROM progress), 0));
CREATE INDEX idx_progress_change_seq ON progress(user_id, change_seq);
```

`upsertProgress()` (`routes/kosync.ts`) increments `change_seq.value` and stamps the row in the same
transaction. KOSync PUT, v1 PUT, and fan-in already go through it. Document merges do not:
`mergeDocuments` (`models/merge.ts`) rewrites `progress` rows directly, so it must also stamp a new
`change_seq` on the canonical document's rows. Otherwise a user's merge in the web app never reaches
devices until the next progress write. The migration stamps existing rows with their `rowid` (and
starts the counter at the highest one), so they are returned by `since=0` and a device's cursor moves
past them instead of replaying them on every sync.

Migration `0025_progress_server_change_seq.sql` adds `progress.server_change_seq` (default 0).
Merges stamp both sequence columns. When an upload lowers the previous winner's timestamp and
another existing row becomes newest, that winning row also receives the write's sequence in both
columns. This records a change to the effective position even though its original row was not
uploaded again. Progress writes use nested savepoints so the cursor and selected position change
atomically both individually and inside a batch.

Ordinary uploads preserve `server_change_seq`. The feed checks its maximum across the document's
rows, so a later upload (including a new device row) cannot hide an unconsumed merge notification.

### History check for a device's first write

`upsertProgress` only writes a `progress_log` entry (and runs auto-unpause/auto-finish) when the
percentage differs from **that device's** previous row. A device id with no row yet always logs.
Every log row counts as a sync and marks a reading day in `computeActivity` (`models/activity.ts`),
which feeds the reading calendar and day streak, even with 0 pages.

Change the previous-value lookup when the device has no row of its own:

1. If the id is a per-device CrossInk id (`crossink-<mac>`) and the document has a legacy shared
   `crossink-device` row, compare against that row. This reproduces exactly what the old shared row
   would have logged, so the id switch (Decisions 1) is invisible to users.
2. Otherwise compare against the document's newest row from any device (same ordering as the KOSync
   GET), so a brand-new reader pushing a position another device already reported logs nothing.

Comparing only against the newest row is not enough for case 1: if the phone saved a lower position
more recently, the reader's re-push differs from the newest row and would still log.

### Endpoint

```
GET /api/v1/progress/changes?since=<seq>&device=<id>&limit=<n>
```

Response:

```json
{
  "cursor": 4812,
  "more": false,
  "changes": [
    {
      "document": "a1b2...",
      "aliases": ["c3d4..."],
      "percentage": 0.4213,
      "progress": "/body/DocFragment[12]/body/p[3]/text().0",
      "position": { "pctQ": 421300, "spine": 11, "page": 4, "pages": 30 },
      "device": "Phone",
      "device_id": "...",
      "timestamp": 1791234567
    }
  ]
}
```

- One entry per document: the newest row (same tie-break as `GET /api/v1/progress`), included only
  if that row's `change_seq > since`.
- `position` is the parsed rich position object, or `null` for rows written by plain KOSync
  clients.
- `document` is canonical; `aliases` comes from `document_aliases` so the device can match whichever
  hash it uses.
- `device` self-exclusion: the server picks each document's newest row first; if that row was
  written by the requesting device id, the document is left out of the page. It does **not** fall
  back to the newest row from another device (that older position would make the reader mark itself
  pending and re-push for nothing). Relies on per-reader ids (Decisions 1).
  Server-side changes bypass self-exclusion while the document's `server_change_seq > since`:
  the original uploader still needs to learn about merges and changes in the selected row.
- The route sits behind the same auth middleware as the rest of `/api/v1`.
- `cursor` is the highest `change_seq` in this page. `more` tells the device to request again.
- `limit` defaults to 20, max 50. The server also stops adding changes once the response body passes
  8 KB (always at least one change), because xpath and `position` lengths vary. The firmware reads a
  page into one fixed 8 KB buffer allocated for the pull and parses it with an ArduinoJson filter
  keeping only the fields above; a change too large for the buffer is logged and skipped (the cursor
  still advances past it).
- `since=0` returns a full snapshot (first run, cursor reset).
- `limit=0` returns only `cursor` (the current highest `change_seq` for the user) and no changes,
  for the first walk (section 4, "First sync per scope").
- Unknown route (stock KOSync or older crosspoint-sync) returns 404, and the device uses the legacy
  per-book path.

The feed only reports what the server already has. It does not call the per-book connector pullers
in `connectors/refresh.ts`; a single-book sync still does.

## 4. Document-id map, parked positions, and pull (firmware)

The server identifies books by KOReader document hash. The device needs to turn a hash back into a
local file. Today no hash is stored anywhere; each sync recomputes it from the file.

The Library index is **not** used for this. Some users never open the Library, so the index may be
missing or frozen at whatever was on the card when it was last built, and nothing on the device can
tell which books were added since without walking the card.

### Matching uses only the configured method

Matching uses only the document matching method the user chose (Filename or Binary). The device
never records or looks up the other method's hash. An optimized EPUB has different bytes than the
original, so a position stored under the other method can belong to a different file version and
land far from the right place.

Today's Smart sync probes the alternate method too (`alternateMatchMethod` in
`KOReaderSyncActivity::performSync`, added in #2192) and can adopt a remote position found under the
other hash. That is a bug in the existing per-book path and is fixed separately: remove the
alternate probe so single-book Sync Book and the legacy walk also stick to the configured method.
Users whose devices use different methods can merge the documents in the web app; the feed then
lists both hashes in `aliases`.

### Which books a pull needs to find

1. **Books opened or synced on this device.** Nearly every real case: the book being read on both
   devices. The firmware computes these hashes anyway, so it records them (below).
2. **Books read elsewhere but never opened here.** Nothing can match these without walking the card.
   Their remote position is parked and offered when the book is first opened, if the book is inside
   a prepared scope.

### Sync id map: `/.crosspoint/sync_ids.bin`

- **Contents:** header (version, match method), then one variable-length entry per touched book:
  16-byte raw MD5, `u8` path length, absolute path.
- **Written** whenever a document hash is computed: Sync Book, bulk push, and on book open when
  needed (below). Filename mode is MD5 of the basename, no file I/O.
- **Forward copy in the book cache:** the same 16 bytes plus match method are also saved as a small
  file in the book's `epub_<hash>/` cache folder, so "what is this book's id" on open is one small
  read instead of a scan of `sync_ids.bin`. The cache folder already follows the book through
  renames and moves.
- **Size** grows with books touched on this device, not library size. Only books with saved
  progress, stats, or clippings are recorded, including during a first walk, so a 6000-book card
  with 200 read books records about 200 entries. Lookup streams the file once per feed page and
  compares against that page's `document` and `aliases`.
- **Finished books are removed and never re-recorded.** When a book's `isCompleted` becomes true
  (the reader's completion flow and the Mark as finished action in `BookActions.cpp`), its entry is
  removed from `sync_ids.bin`. Every place that records an id (first walk, push, stats catch-up,
  single-book Sync Book, on-open hashing) checks the book's stats first and skips `sync_ids.bin` for
  a finished book; it still writes the id to the book's cache copy, so pushes keep working. Only the
  pull's reverse lookup is affected: the book's cache copy of its id stays, so pending stats and
  clippings still upload. A later remote change for it is unmatched and parked (offered on open if
  remote is ahead; if local is ahead, it is pushed back). Reopening or un-finishing the book
  re-records it the next time its id is computed.
- **Compaction:** while streaming the file during a pull, count entries whose path no longer exists.
  If they exceed a quarter of the entries, rewrite the file without them at the end of the sync
  (atomic rewrite). Together with finished-book removal and in-app deletes, the file stays close to
  "books currently being read" instead of growing forever.
- **No duplicates:** a new entry is appended only if that path is not already recorded with the same
  id (a short scan first; recording is rare).
- **Duplicate copies:** in binary mode two copies of the same file share an id, so an id can map to
  several paths. A matched change applies to every existing path with that id that is inside the
  sync's scope; in Ask mode the user is asked once and the answer applies to all of them.
- **XTC books are never recorded in `sync_ids.bin`.** The file only serves the progress pull, and
  XTC books have no KOReader position. Their id is stored only as the cache copy in their XTC cache
  folder, which the stats push uses.
- **Renames, moves, deletes:** see "Renames, moves, and deletes" below.
- **Paths changed on a computer:** the stored path fails `Storage.exists`. The change is parked, and
  the next open from the new path re-records the hash and matches it.
- **Match method change:** every book gets a new id, so to the server they are new documents.
  Changing Document Matching in Settings → System → Sync Server first shows a confirmation warning
  that progress already uploaded will no longer match this device's books (it stays on the server
  under the old ids; merging in the web app reconnects it). On confirm, the device resets everything
  a server change resets: discards `sync_ids.bin`, clears the cursors, prepared scopes, and both
  catch-up flags in `sync_state.bin`, and the next sync of each scope walks again under the new ids.

### Renames, moves, and deletes

Every in-app path change already funnels through `src/util/BookMoveUtils.cpp`, which migrates the
book's path-keyed reader state:

| Entry point | Function |
| --- | --- |
| File Browser rename (`FileBrowserActivity::renameFile`) | `renameFilePreservingBookState` → `migrateRenamedBookState` |
| Web portal rename (`CrossPointWebServer.cpp`) | `renameFilePreservingBookState` → `migrateRenamedBookState` |
| Move to Read (`BookActions.cpp`, `EpubReaderActivity.cpp`) | `migrateMovedEpubState` |
| Delete book (File Browser and Library actions, web portal delete) | the existing delete path that removes the book's cache and stats |

Folder renames are not offered in-app (the web portal rejects directories), so path changes are per
book. Both migrate functions gain one step, committed and rolled back with the existing bookmark and
clipping migrations:

- **`sync_ids.bin`:** rewrite the entry's path.
- **`sync_pending.bin`:** rewrite the entry's path, so a not-yet-uploaded book is not lost.
- **Delete:** remove the book's entries from `sync_ids.bin` and `sync_pending.bin`. Parked entries
  are keyed by hash, not path, and are left to age out.
- **Filename match method only: the document id changes.** The id is MD5 of the basename, so a
  renamed book becomes a different document to the server. This is left as is: the firmware never
  merges documents on the user's behalf, because a rename may be meant to keep two copies apart.
  Merging stays a deliberate action in the web app (`POST /api/v1/documents/merge`).
  - Recompute the hash and replace the book's `sync_ids.bin` entry, so the renamed book pushes and
    pulls under its new id. The old id is no longer recorded.
  - Feed changes for the old id no longer match any book. They are parked like any other unmatched
    change and age out under the parked-entry cap.
  - If the user later merges the two documents in the web app, the feed lists the merged hash in
    `aliases`, and the renamed book matches again with no firmware action.
  - Moves keep the basename and binary mode is content-based, so neither changes the id.

### Computing the hash

Binary mode (`KOReaderDocumentId::calculate`) reads 1 KB at offsets 0, 1 KB, 4 KB, 16 KB, ... (each
4x the last) that fall inside the file: about 8 small seek-and-read steps for a typical 2 to 5 MB
EPUB. It runs in one shot, not spread across loop iterations:

- It is short enough that splitting it would add complexity for little gain (to be confirmed by
  timing on X4).
- Resuming across iterations would keep the EPUB open between them. The render task opens the same
  EPUB through `ZipFile` to load sections, and real SD cards allow only one open reader per file, so
  the hash must run while the render task cannot touch the book.

When it runs:

- **On open, only if needed:** the parked file is non-empty and the book's cache has no stored id.
  It runs in `onEnter` before the first page renders, so no page turn can arrive mid-hash.
- **Otherwise deferred:** to bulk push or Sync Book, which compute it already. A normal open with
  nothing parked does no hashing.

### Parked remote positions: `/.crosspoint/sync_parked.bin`

- **Contents:** one entry per unmatched document: its hashes (`document` plus up to 3 `aliases`),
  percentage, xpath, device name, and timestamp. A newer change for the same document replaces the
  old entry.
- **Layout:** fixed 384-byte slots, so replacing or removing an entry is an in-place write: 4 x
  16-byte hashes, percentage, timestamp, rich position ints, device name truncated to 32 bytes, and
  xpath up to 256 bytes. A change whose xpath is longer is not parked (logged).
- **Cap: 32 entries (12 KB).** Most parked entries are books started on another device that are not
  on this reader, and they never clear on their own. 32 keeps the most recently updated ones; the
  oldest is evicted when full (logged). An empty file costs nothing on open; a full one is a single
  12 KB sequential read.
- **Slots carry a CRC32**, so a slot torn by a power cut is treated as empty.
- **On book open (both Smart and Ask on conflicts):** only for a book inside a prepared scope (so a
  reference book deliberately kept out of synced folders is never prompted). If the file is
  non-empty and sync is configured, compute (or look up) the book's hash and check for a parked
  entry. If the remote position is further ahead than local, ask "Continue from 45% (Phone)?" (same
  choice manual sync offers today) and map it with the existing `ProgressMapper` path while the EPUB
  is already loaded. If local is ahead, add the book to the pending-push list. The entry is removed
  once the user applies it, declines it, or local is already ahead. No network involved.
- **Backup check at sync:** the on-open check misses a book whose change was parked after it was
  opened (for example a Sync Folder run while that book was already open in a previous session and
  its id was not yet recorded), or whose open-time hash failed. Bulk push therefore also checks
  parked entries: for each pending book, compute or look up its hash (push needs it anyway), and if
  a parked entry matches, apply the same smart sync rule bulk sync uses today (Ask on conflicts
  prompts instead). Like the push, this only covers pending books inside the sync's scope. Remote
  further ahead: save the remote position and skip that book's progress push. Local ahead: push as
  normal. Remove the entry once resolved. Because pull runs before push, a change parked earlier in
  the same sync is matched here too. In Smart mode this path applies without a prompt, matching
  existing bulk sync behavior.
- EPUB only. XTC has no KOReader position.

### Ask on conflicts in a batch

The setting's "Ask every time" option is renamed **Ask on conflicts** (`STR_ASK_EVERY_TIME`
relabelled in every translation; the stored `KOReaderSyncBehavior::ASK_EVERY_TIME` value is
unchanged), and one rule applies to every sync path: single-book Sync Book, the legacy per-book walk
(stock KOSync and first walks), and the incremental pull. A **conflict** means the server has a
position for the book and it differs from the reader's by more than the 0.1% smart-sync epsilon:

- Positions match: no prompt; the result says "Already synced".
- No remote position: upload silently. (Today Ask mode shows "No remote progress, upload?".)
- Positions differ: show the compare screen (with Skip book in batches).

With incremental sync, conflicts are only found for books the feed reports as changed, or with a
parked entry; books that changed only on this reader upload without a prompt. Because the rule also
changes today's single-book and legacy paths, the rename and the rule ship in rollout step 1. The
first walk of a scope uses the same rule, so it never asks about every book.

Batches already offer Skip book on every prompt, label Back as Exit (stopping the whole sync), and
honor a held Exit while running. The incremental design keeps that behavior. Every conflict (during
pull, or in the backup parked check) shows three choices:

- **Apply remote:** save the remote position.
- **Upload local:** push this book's progress.
- **Skip book:** decide later.

The Back hint reads **Exit** on every batch prompt; the touch header's back arrow performs the same
Exit. Exit stops the sync and keeps the results so far. Smart mode never prompts.

**Skip must park.** Today a skipped book is asked about again next sync because every sync GETs
every book. Here, the pull only sees changes since the scope's cursor, so the skipped change is not
delivered again, and push no longer GETs. Without a record, the next sync would push the local
position over the remote one without asking. Skip therefore parks the remote position, and:

- A book with a parked entry never has its progress pushed. Stats and clippings still upload.
- Replays are not filtered. If a scope with an older cursor receives a change another scope already
  applied, and the book has moved on locally, Ask on conflicts prompts again. Users who want this
  resolved automatically choose Smart sync.
- In Ask mode, the backup parked check at the next sync asks again with the same three choices, and
  so does opening the book. The user is asked until they choose.

### Pull flow

1. Request `/changes` from the scope's cursor.
2. Stream `sync_ids.bin` once per page and match each change's `document` and `aliases`.
3. Matched, but every matching path is outside the sync's scope: leave it alone. It is not applied,
   not parked, and not prompted. A later sync whose scope covers that book receives it through its
   own cursor.
4. Matched, the path exists, and it is inside the scope: Smart mode applies the existing smart sync
   rule. Remote further ahead → save remote position (reuse `KOReaderSyncActivity`'s mapping path).
   Local further ahead → set `PROGRESS` on its pending entry. Within epsilon → nothing. Ask on
   conflicts prompts instead (see "Ask on conflicts in a batch").
5. Unmatched or stale path: park it (offered on open only if the book turns out to be inside a
   prepared scope).
6. Persist the scope's cursor after the whole page is handled. A crash re-processes that page, and
   applying the same change twice is harmless. The cursor always advances because nothing is
   dropped: every change is either applied, marked pending, or parked.

### Cursor storage: one per prepared scope

Each prepared scope keeps its own cursor in `/.crosspoint/sync_state.bin` (below), all keyed to base
URL plus username; changing either clears every cursor and prepared scope. Sync Folder pulls from
that folder's cursor and only acts on books inside the folder; Sync Books pulls from `/`'s cursor
and acts on every book. Because each scope reads the feed from its own position, a change skipped by
one scope is not lost: the next sync of a scope that covers the book receives it. A change applied
by one scope and later replayed by another is a no-op (equal positions).

- A folder that is covered by a prepared ancestor but has no cursor of its own starts from a copy of
  the ancestor's cursor the first time it is synced, and needs no walk.
- The scope list is capped at 32 entries (each about 270 bytes: path up to 255 bytes, cursor,
  last-synced time; about 9 KB in all). Lookups read the list one entry at a time, so RAM use is
  constant regardless of the cap. When full, the least recently synced scope is dropped. If `/` is
  prepared, a dropped folder simply restarts from a copy of `/`'s cursor; otherwise its next sync
  walks it again under a new walk id (ids already recorded are reused).

### First sync per scope

`sync_ids.bin` and `sync_pending.bin` start empty after upgrading, so an incremental sync alone
would match nothing and push nothing. Each scope therefore runs a one-time walk, but only over what
the user asked to sync: a user with 6000 books who only ever runs Sync Folder on `/Read` never walks
the rest of the card.

- **`/.crosspoint/sync_state.bin`** holds the base URL and username, a short list of **prepared
  scopes** (folder paths; `/` means the whole card) each with its own cursor, any first-walk walk id
  and catch-up id (for resume), and its own `statsCaughtUp` / `clippingsCaughtUp` bits, plus the
  whole-card catch-up flags and resume id (section 1). Existence of `sync_ids.bin` or
  `sync_pending.bin` is never used as the signal.
- **Sync Folder on an unprepared folder** (neither it nor an ancestor is prepared): walk that folder
  with today's per-book path (`FolderBookIterator`). It records each book's id in `sync_ids.bin` and
  the book cache and reconciles progress, stats, and clippings. Then add the folder to the prepared
  list. A folder whose ancestor is prepared needs no walk.
- **Sync Books when `/` is unprepared:** walk the whole card with `FolderBookIterator("/")`, not the
  Library index, so File Browser-only users are covered. Then mark `/` prepared, which also covers
  every folder.
- **Each walk sets its scope's cursor:** read the server's latest `change_seq` with `GET
  /api/v1/progress/changes?limit=0` before the walk and save it as the scope's cursor after the walk
  completes. Reading it first means changes made during the walk are replayed later, which is
  harmless; reading it after would skip them.
- **The walk clears pending bits** for every book it uploads, exactly as the push does, so the next
  sync does not send those books again.
- **The walk only records ids and computes hashes for books with saved progress, stats, or
  clippings,** and skips `sync_ids.bin` for finished books (cache copy only). Untouched books are
  skipped without hashing. Today's walk computes the hash before checking whether there is anything
  to upload (`uploadBookExtras` in `StatsUploadActivity.cpp`); the walk reorders that.
- **Books outside every prepared scope** are never acted on by a scoped sync. Their remote changes
  reach them only through a sync whose scope covers them.
- **Resume by walk stamp, not by position.** Each walk gets an id, stored with its scope in
  `sync_state.bin`. When the walk finishes a book, it writes that walk id into the book's small sync
  file in its cache folder (the same file that holds its document id). An interrupted walk (Exit,
  reboot, power cut) resumes by skipping books already stamped with the current walk id, which costs
  one small read per book instead of a server request. This does not depend on file order, so it
  survives cold boots (which always mark the Library index stale) and card edits made on a computer.
  Books added since simply get walked.
- An interrupted walk does not mark its scope prepared.
- **Progress text.** The bulk sync screen says what it is doing, and the walk text appears only when
  a walk actually runs:
  - Sync Books, first walk: "Scanning your SD card for books to sync…" with the running counts.
  - Sync Folder, first walk of that folder: "Scanning this folder for books to sync…".
  - Every later run: "Checking for updates…" during the pull, then "Uploading changes…" during the
    push.
  - The Exit hint is shown throughout (see "Exiting mid-sync"), so a user who does not want to wait
    for a large card can stop; the scope is not marked prepared, and the next run resumes by
    skipping books already stamped with this walk's id.
- **Stock KOSync servers** have no feed, so every sync stays a legacy walk of its scope. Sync Books
  uses `FolderBookIterator("/")` there too, replacing today's Library index dependency (which only
  sends overall stats when the index is missing).

### Crash-safe sync files

All sync files use the same pattern as `GlobalReadingStats` and `DailyReadingStats`:

- **Whole-file rewrites** (`sync_state.bin`, `sync_pending.bin`, and `sync_ids.bin` when a path
  changes or an entry is removed): write `<name>.tmp`, close it, rename the current file to
  `<name>.bak`, then rename `.tmp` into place.
- **Appends** (`sync_ids.bin` new entries) and **in-place slot writes** (`sync_parked.bin`) carry a
  CRC32 per entry or slot. A bad entry is skipped and a bad slot is treated as empty.
- **Loading:** read the main file; if it is missing or fails its checks, read `.bak`; if both are
  bad, fresh start for that file:
  - `sync_state.bin`: no cursors, no prepared scopes, catch-up flags cleared, so the next syncs walk
    and catch up again.
  - `sync_pending.bin`: empty, plus the reset of scopes and catch-up flags only if something had
    already been prepared (section 2).
  - `sync_ids.bin`: empty; it refills as books are synced or opened, and unmatched changes are
    parked meanwhile.
  - `sync_parked.bin`: empty.

## Sequence of a bulk sync

Sync Books or Sync Folder against a server that supports the CrossPoint API:

1. **Confirm and connect.** Existing flow: confirmation, Wi-Fi, NTP time sync. Server support for
   stats and clippings is already known from Authenticate or a previous upload; there is no mid-sync
   probe.
2. **Overall stats.** Global snapshot plus unsent daily counters, first as today, so per-book
   failures never starve them.
3. **Prepare scope if needed.** If the scope is not prepared, run its one-time walk (section 4)
   instead of steps 4 and 5, then finish. If it is prepared but a toggle is on and the scope's
   catch-up bit for it is clear, run that catch-up for the scope first (section 1).
4. **Pull.** Page through `/changes` from the scope's cursor until `more` is false. Each change for
   a book in scope is applied or marks it pending; unmatched changes are parked; changes for books
   outside the scope are left alone. The scope's cursor is saved after each page. A 404 here
   switches the rest of the run to the legacy per-book walk.
5. **Push.** For each pending book in scope:
   1. Get its id (book cache, else compute it, save it to the book cache, and record it in
      `sync_ids.bin` unless the book is finished).
   2. Backup parked check (section 4).
   3. Progress PUT if `PROGRESS` is set, unless step 4 or the parked check applied a newer remote
      position, or the book still has a parked entry (skipped). Positions are queued and sent up to
      8 at a time with `PUT /api/v1/progress/batch`; a 404 switches the rest of the run to one
      `PUT /syncs/progress` per book.
   4. Stats PUT if `STATS` is set (batched across books); clippings upload if `CLIPPINGS` is set.
   5. Clear each bit that succeeded; remove the entry when none remain.
6. **Result.** Counts screen, Wi-Fi off.

**Exiting mid-sync.** Today's batch already shows Exit while running, accepts a held Exit at step
boundaries (buttons are polled, not queued, by `HalGPIO::update`), and checks it inside the per-book
sync before fetching, applying, and uploading. In the incremental design:

- The batch does one unit of work per loop iteration (one feed page, one applied change, one upload)
  and checks Exit between units, with no per-book child screen during automatic work.
- Exit is accepted as a press edge **or** a held button (`isPressed`), so holding Exit during a
  request stops the sync as soon as that request returns. A request in flight is never aborted
  mid-transfer.
- The Exit hint is shown for the whole run, not only on prompts.
- Stopping is always safe: cursors are saved per page, pending bits are cleared per successful
  upload, and a first walk resumes by walk stamp, so the next sync picks up where this one stopped.

Pull runs before push so the push never needs a per-book GET: every pending book that has a newer
remote position was already compared and resolved in step 4.

## Bulk sync after this change

| Action | Pull | Push | Global stats |
| --- | --- | --- | --- |
| Reading Stats upload | No | Same as Sync Reading Stats | Yes |
| Sync Reading Stats (File Transfer) | No | Pending `STATS` only (first run: card walk for stats files) | Yes |
| Sync Clippings | No | Pending `CLIPPINGS` only (first run: clippings folder listing) | No |
| Sync Folder | Feed from the folder's cursor, applied only to books in the folder | Pending under folder, plus a folder catch-up when needed | If Reading Stats is on |
| Sync Books (was Sync All Books) | Feed from `/`'s cursor, all books | All pending, plus a whole-card catch-up when needed | If Reading Stats is on |
| Any action, stock KOSync server | Legacy per-book walk | Legacy | If Reading Stats is on |

Scope limits both the pull and the push. Each scope has its own cursor, so a change ignored by Sync
Folder is still delivered to Sync Books or to a Sync Folder that covers that book. Pull cost scales
with changes, so reading the feed once per scope is cheap.

## Rollout

Separate fix, can ship now: remove Smart sync's alternate-method probe so matching sticks to the
configured method (section 4, "Matching uses only the configured method").

1. Firmware: File Transfer Sync Server section (Sync Books moves out of Settings; Sync Reading Stats
   and Sync Clippings added) and the stats-only Reading Stats upload. Before the pending list
   exists, Sync Reading Stats (and the Reading Stats screen button) run the stats-only card walk
   from section 1 every time, and Sync Clippings runs the clippings-folder listing every time. Both
   are cheap; step 3 narrows them to pending entries plus a one-time catch-up. Also: rename Ask
   every time to Ask on conflicts and apply the conflict rule to single-book Sync Book and the
   legacy walk. Lands after `fix/sd-card-plugins` is rebased and merged.
2. Server: migration, `upsertProgress` sequence stamp (including merges) and first-write history
   check, `/changes` route with `limit=0`, tests.
3. Firmware: `sync_pending.bin` with its dirty bits and append points, and the crash-safe file
   pattern. Sync Reading Stats and Sync Clippings switch to the pending list plus their one-time
   catch-ups (with `sync_state.bin` holding the catch-up flags and resume id). Sync Books walks the
   card instead of the Library index.
4. Firmware: per-reader `device_id` in progress PUTs. Ships after step 2 is deployed, so the
   first-write history check is already live when readers start writing new rows.
5. Firmware: the incremental bulk sync. `sync_state.bin` scopes with per-scope cursors, walk stamps,
   and per-scope catch-up bits and resume ids (step 3 only has the whole-card catch-up flags), first
   walk per scope, folder catch-ups, `sync_ids.bin` (with finished-book removal and compaction),
   parked positions with the on-open prompt, the pull, the Document Matching warning. No Library
   index format change.

Steps 2 and 3 are independent. Step 4 needs step 2. Step 5 needs steps 2 to 4.

Every firmware step adds its `CHANGELOG.md` entries and updates user docs (user guide, sync docs).
New or changed UI strings, translated in every `lib/I18n/translations/*.yaml`:

- New: "Sync Reading Stats", "Sync Clippings", the "Sync Server" File Transfer section header, the
  parked prompt ("Continue from 45% (Phone)?"), and the bulk sync progress text ("Scanning your SD
  card for books to sync…", "Scanning this folder for books to sync…", "Checking for updates…",
  "Uploading changes…"), and the catch-up text ("Scanning your SD card for reading stats…",
  "Checking clippings…").
- Renamed: "Sync All Books" becomes "Sync Books".
- Renamed: the "Ask every time" option becomes "Ask on conflicts" (`STR_ASK_EVERY_TIME`).
- New: the Document Matching change warning (progress already uploaded will no longer match).

## Decisions

1. **Per-reader device id.** Progress PUTs currently send a constant `device_id` of
   `crossink-device` (`lib/KOReaderSync/KOReaderSyncClient.cpp`), so every CrossInk reader shares
   one progress row per document, and `device` exclusion in the feed would hide another CrossInk
   reader's progress. CrossInk sends the per-device id that stats already use
   (`StatsUploadClient::deviceId`, MAC-based) in progress PUTs. The old shared `crossink-device` row
   stays in place and a new row is added per reader. Every "current progress" read picks the newest
   row across devices, so what users see does not change, and the old row loses as soon as any
   reader pushes. The history-check change in section 3 keeps the switch from adding 0-page reading
   days. No migration needed; stale shared rows can be cleaned up later.
2. **Filename not sent by default.** Matching does not use it, and the server already prefers EPUB
   metadata (`extractTitleAuthor` in `connectors/matching.ts`), parsing the filename only when the
   title is empty. The Send Metadata toggle keeps controlling filename, title, and author as today.
3. **Single-book Sync Book.** Keeps its own GET and prompts only on a conflict ("Ask on conflicts in
   a batch" in section 4). On success it also records the book's id (cache copy always;
   `sync_ids.bin` unless finished), clears that book's pending bits for whatever it uploaded, and
   removes any parked entry for the book, so the next bulk sync does not repeat or re-ask it. It
   does not advance any feed cursor.

## Open questions

1. **Hash timing.** Measure binary-mode hashing on X4 for small and large EPUBs. Confirm
   `KOReaderDocumentId::calculate`'s 1 KB stack buffer fits the reader's `onEnter` call stack, or
   pass a scratch buffer.
2. **Parked xpath size.** 256-byte xpaths is a starting point. The dev database's longest xpath is
   65 bytes (25 rows); check production `progress` lengths before fixing the slot size.

## Verification

- **Server:** vitest for sequence monotonicity across all write paths including merge, fan-in rows
  with old `updated_at` appearing after the cursor, alias inclusion, device exclusion, paging,
  `since=0`. A new `crossink-<mac>` id writing the legacy `crossink-device` row's percentage adds no
  `progress_log` row, even when a newer lower row from another device exists. A new id with no
  legacy row writing the newest percentage adds none; a different percentage does.
- **Simulator:** fixture with read, unread, and remotely updated books, with no Library index.
  Assert that Sync Folder touches only pending and feed-matched books, that an unmatched change is
  parked and offered on first open, that a pending book with a parked entry is resolved by the
  backup check during push, that Skip in Ask mode parks and is asked again next sync without pushing
  local progress, that Sync Clippings uploads only books with changed clippings, that a book moved
  in-app keeps matching, and that the cursor survives a restart. Rename a pending book in the File
  Browser and via the web portal: it still uploads. In filename mode the server gets a new document
  and no merge request; merging both in the web app makes the renamed book match feed changes for
  either id.
- **Touch simulator** (`x4-pro-simulator`, `run_reading_upload_smoke_test.py --touch`): Skip book
  taps in portrait and in the landscape two-row layout, the touch Exit arrow during a bulk sync, and
  the parked "Continue from" prompt.
- **Catch-up:** stats saved before the pending list existed upload on the first Sync Reading Stats
  and not on the second; the same for a clippings file; an interrupted catch-up resumes, skipping
  books it already processed; a completed Sync Books first walk skips both catch-ups.
- **Ask on conflicts:** single-book Sync Book and a bulk walk (also against a stock KOSync server)
  upload silently when there is no remote position, report Already synced when positions match, and
  show the compare screen only when they differ. A first walk of 50 books with no remote progress
  shows no prompts.
- **What to Sync:** with Clippings sync off, Sync Clippings is hidden, clipping edits set no pending
  bits, and Sync Books uploads no clippings. Turning it on clears `clippingsCaughtUp`, and the next
  Sync Books or Sync Clippings runs the catch-up and uploads clippings made while it was off. The
  same for Reading Stats (card walk). A first Sync Books walk with stats off leaves `statsCaughtUp`
  clear. With `/read` prepared while stats was off, turning stats on and running Sync Folder on
  `/read` runs a stats catch-up over `/read` only and uploads books changed there while it was off;
  books outside `/read` are not touched.
- **Scope isolation:** a book outside `/read` that this device has synced before changes on the
  phone. Sync Folder on `/read` leaves its position untouched in Smart and Ask modes, with no prompt
  and no parked entry; a later Sync Books applies it.
- **Crash safety:** corrupt each sync file in turn (main only, then main and `.bak`): the `.bak` is
  used, then a fresh start resets scopes and catch-ups as described.
- **Match method change:** the warning appears; confirming resets cursors, scopes, catch-ups, and
  `sync_ids.bin`; cancelling changes nothing.
- **Walk resume:** Exit partway through a first walk (and separately, reboot mid-walk), then sync
  again: books stamped with the walk id are skipped and the rest are walked; books added in between
  are included. The same for an interrupted stats catch-up.
- **Pending file:** a never-synced reader with no `sync_pending.bin` creates an empty one without
  resetting anything; deleting it (and `.bak`) after a scope is prepared resets scopes and
  catch-ups. A first walk leaves no pending bits for the books it uploaded.
- **Scoped first sync:** a fixture card with books outside `/read`. First Sync Folder on `/read`
  walks only `/read` and records ids only for read books there; a later Sync Books walks the rest
  and sets its own cursor.
- **Hardware (X4):** large card (1,000+ books), Library never opened. The first Sync Folder on
  `/Read` walks it ("Scanning this folder…"). Then read 3 books, advance a fourth on the phone, and
  Sync Folder again: serial log should show 3 pushes, 1 pull applied, and no walk. Copy a new book
  into `/Read` via computer, advance it on the phone, sync, then open it on the reader: expect the
  "Continue from" prompt. Check `ESP.getMaxAllocHeap()` during a feed page parse.
