# CrossPoint stats sync for KOReader

Upload KOReader reading time and page history to CrossPoint Sync. The existing
CrossPoint dashboard shows daily activity, reading time, estimated sessions and
streaks. Keep KOReader's built-in Progress sync for reading positions.

This first version syncs manually. It does not change KOReader's database, upload
highlights, change reader positions, or send history to linked services.

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
6. Choose **Sync all reading history now**. This explicitly includes historical
   reading on every book in the statistics database. Repeat after reading to send
   new activity. A first sync can take a while for a large library.

For books to match existing Progress sync entries, use its binary/content checksum
method rather than filename matching. You can merge pre-existing duplicates in the
CrossPoint library.

Reading statistics must be enabled in KOReader. The plugin reads the current
`settings/statistics.sqlite3` schema (`book` and `page_stat_data`). Legacy databases
must first be upgraded by opening them in a current KOReader release.

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

The ZIP is written to `dist/crosspoint-koreader.zip`. The plugin tests need `lua`
(or run `luajit koreader/tests/sync_test.lua` for KOReader's LuaJIT runtime).
Tests mock KOReader's UI and transport. Real-device installation, menu placement,
Wi-Fi, and TLS behavior still need device testing before a public release.
