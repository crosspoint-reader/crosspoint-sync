# CrossPoint stats sync for KOReader

Upload KOReader reading time and page history to CrossPoint Sync. The existing
CrossPoint dashboard shows daily activity, reading time, estimated sessions and
streaks. Keep KOReader's built-in Progress sync for reading positions.

After one-time setup, stats sync in the background after successful KOSync progress
uploads to the same server and account. This includes manual Push progress,
automatic pushes, and successful queued retries. Pull progress alone does not
trigger sync. It also uploads highlights, their notes, and bookmarks for the open
book. It does not change KOReader's database or reading position, or send reading
history to linked services. Uploaded highlights use the server's existing configured
highlight connectors and microblog posting settings.

## Install

1. Update your CrossPoint Sync server to a version containing the
   `/api/v1/stats/koreader` endpoint. Older servers will return an error.
2. Unzip `crosspoint-koreader.zip` into KOReader's `plugins` folder. You should have
   `koreader/plugins/crosspoint.koplugin/main.lua`, without an extra nested folder.
3. Restart KOReader. Enable **CrossPoint stats sync** in plugin management if needed.
4. In KOReader's main menu, open **CrossPoint stats sync → Set up server and account**.
5. Enter the server root URL (including any deployment path prefix), your
   CrossPoint **sync username and password**, and a reading time zone such as
   `America/New_York`, `Europe/London`, or `UTC`. Use the same time zone on each
   reader. These are the credentials used by Progress sync, not a recovery token.
6. Keep using normal **Progress sync → Push progress**. After a successful push,
   stats upload automatically, including historical reading for all books on the
   first sync. Later uploads skip books whose history has already been acknowledged.
   A first sync can take a while for a large library.

Configure Progress sync with the same server URL and account as this plugin.
Automatic stats sync only follows matching uploads; it does not send history to
an unrelated KOSync server. It never reconnects Wi-Fi after suspend/disconnect.
If the reader goes offline or a stats upload fails, it retries after the next
successful progress push while online. Progress sync succeeds independently.

Uploads run in a separate background process, whether KOReader's optional Turbo
UI loop is enabled or disabled. You can keep reading while slow network requests
finish. The UI captures the current book's annotations before starting the worker;
the worker reads history through its own read-only SQLite connection. Only the
parent process updates plugin settings.

Suspend/exit cancels the worker, and a five-minute deadline stops stuck jobs.
Acknowledged batches are checkpointed so interrupted uploads can retry safely.
Only one worker runs at a time. TLS verification stays enabled.

Automatic successes are quiet. Failures show a brief notice; open **CrossPoint
stats sync → Last stats sync result** for details. Use **Sync all reading history
now** for an explicit full backfill/retry, including after clearing server data.
Acknowledged book fingerprints persist across restarts; the manual action bypasses
them. You do not need to open the plugin menu for everyday syncing.

For books to match existing Progress sync entries, use its binary/content checksum
method rather than filename matching. You can merge pre-existing duplicates in the
CrossPoint library.

For history uploads, Reading statistics must be enabled in KOReader. The plugin reads the current
`settings/statistics.sqlite3` schema (`book` and `page_stat_data`). Legacy databases
must first be upgraded by opening them in a current KOReader release.

## Highlights and bookmarks

Open a book and push progress to upload its annotations. Repeat for older books:
the all-book statistics backfill does not scan unopened books for annotations.
Use the manual sync action while a book is open to resend all its live annotations,
including after clearing server data. No statistics database is required for
annotation uploads.

Highlights retain text, notes, chapter and color. They appear as clippings in the
app. Bookmark uploads retain the KOReader location, percentage and a summary
(up to the server's 256-character limit). EPUB bookmark locations are native
XPointers; PDF bookmark locations are page numbers encoded as strings. Future
firmware must interpret the location format for the document. KOReader highlight
coordinates are not converted to firmware spine/word offsets; text sync does not
provide on-device highlight placement.

Stable IDs allow edits without duplicates. Only annotations previously acknowledged
on this reader generate deletion markers when removed. Missing books and unavailable
annotation lists never delete server data. Uploads are batched in groups of 50;
acknowledged batches persist, and failures retry after the next successful progress
push. Highlight text and notes must each fit the server's 4096-byte limit; oversized
items report an error instead of being silently truncated.

This version uploads only; it does not import server annotations into KOReader.
The bookmarks API is shared with firmware clients, not specific to the plugin.
Bookmark conflicts retain the server's last-write-wins behavior, including restores;
clipping deletion markers cannot be resurrected under the same ID. Recreate a deleted
highlight in KOReader to give it a new creation identity.

## What gets counted

- Records are deduplicated by book, page, original page count, and start timestamp.
  Repeated uploads, retries, and copies of the same history synced between devices
  do not add the same reading twice. A longer duration for an existing record wins.
- Each request commits one complete book. If a later book fails, earlier books stay
  synced. All source records stay on the reader; retrying sends them again safely.
- Layout changes retain each event's original page count. Screen-page records are
  not claimed to be print-page counts. Existing dashboard page estimates still
  depend on book metadata and progress history.
- Sessions are estimated using gaps of over five minutes between page records.
  The current unfinished page is included after KOReader records it.
- Completion is not inferred from visiting the last page. Mark finished books in
  CrossPoint. Existing titles, statuses, dates, and firmware stats are preserved.
- Source records are retained server-side. Deleting/resetting statistics on the
  reader does not erase history already uploaded. Explicit history-file imports
  retain their existing replacement behavior for the imported books.
- This version supports up to 20,000 distinct page records per book (4 MB request
  limit). Larger books can still use Settings → Import reading history.

## Existing history imports

New manual KOReader/KOInsight imports and plugin uploads share source records and
are counted once. Imports made before this plugin version stored only aggregates.
If the plugin reports that an older import cannot be reconciled, re-import the
**original complete history file** through CrossPoint Settings first. This records
the source events without duplicating the imported totals. Export an account backup
before replacing imported history; a smaller history file can replace that book's
previous imported totals. Firmware stats are kept separately.

If the complete original history is unavailable, leave that book unsynced rather
than clearing existing stats to bypass the conflict. A failure stops the current
sync and reports the book involved.

## Connection and credentials

HTTPS certificates and hostnames are verified using the bundled Mozilla CA roots.
Redirects are refused so credentials cannot be forwarded to a different server.
HTTP is accepted only for localhost development. For a private CA, add its root
certificate to `cacert.pem`; there is no "disable verification" option.

KOReader stores the MD5 sync credential in `settings/crosspoint.lua`, like a saved
Progress sync credential. It grants account access; protect the device and its
backups. The plaintext password is not saved. A wrong device clock can cause TLS
verification to fail.

`cacert.pem` is the Mozilla CA bundle distributed by curl at
https://curl.se/docs/caextract.html, downloaded November 13, 2026. Its license is
https://www.mozilla.org/en-US/MPL/2.0/. Refresh it from https://curl.se/ca/cacert.pem
when updating the plugin. Other plugin files use the repository's MIT license.

## Development

From the repository root:

```sh
npm run build:koreader
npm run test:koreader
npx vitest run test/koreader-sync.test.ts test/koinsight-import.test.ts
```

The ZIP is written to `dist/crosspoint-koreader.zip`. Tests require Lua and LuaJIT.
The sync suite mocks UI and HTTP responses, including retries and partial batches.
The background suite uses real OS child processes and a delayed worker to verify
that UI polling continues, plus cancellation, deadlines, worker crashes, checkpoint
recovery, and cleanup. Both suites run in CI and the release script.

These checks do not emulate Kobo hardware or exercise KOReader's full UI, network,
and TLS stack. Real-device page turns, Wi-Fi and suspend/resume still need testing.

To publish an installable ZIP as a tagged GitHub release, commit and push the
release first, then run `npm run release:koreader -- koreader-v0.1.0` with a new
version. This runs tests, builds the ZIP, creates the tag at that commit, and
publishes immediately through the authenticated GitHub CLI. See the repository
README for prerequisites.
