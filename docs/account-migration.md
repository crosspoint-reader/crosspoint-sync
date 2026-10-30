# Account export and migration

On the source server, open **Settings → Account migration → Export account data**.
Create or sign in to an account on the destination server, open the same settings,
and choose **Import data**. Hosted and self-hosted servers use the same format.
Both servers must support account archive version 1.

The JSON file contains document metadata and manual edits, aliases, every device's
progress, position samples and progress history, bookmarks, clippings (including
deletion markers), device book/global statistics, daily and per-book daily counters,
reading sessions, the auto-pause preference and public-profile preference.
Keep the file private: it contains your reading history and annotations.

The destination username and password stay unchanged. Public profiles retain the
destination link or receive a newly generated link; source URLs are not portable.
Appearance, catalogs and other settings stored only on a phone/browser are not included.
Passwords, integration tokens, service matches, service-imported history (such as
BookOrbit history), EPUB caches, and pending delivery jobs are not exported. Reconnect
services on a new server to fetch their history again.

By default, import requires an empty reading library. If the destination already
has data, export a backup first, then explicitly select **Replace existing reading
data and book matches**. This replaces the whole reading library, including overlapping
device IDs, rather than combining cumulative counters and risking double counting.
Existing destination service credentials remain, but book matches, EPUB caches and
queued deliveries are cleared. Import itself does not push data to external services.
Pause device syncing while migrating, then update readers to use the destination.

Import is atomic: invalid types, unknown fields, unsupported versions, missing
sections, duplicate identities and alias cycles reject the archive without changing
the destination. Progress/clipping sync cursors are regenerated for the destination.
The upload limit is 50 MiB (including the request envelope) and 200,000 records.

## API

Use the existing sync authentication headers (`x-auth-user` and `x-auth-key`) or an
authenticated website session. Every operation is scoped to that authenticated user;
archive usernames cannot select or create another account.

- `GET /api/v1/account/export` returns a JSON attachment with `Cache-Control: no-store`.
- `POST /api/v1/account/import` accepts `{ "archive": <exported JSON>, "mode": "empty" }`.
  Use `"mode": "replace"` only after choosing to replace the existing library.
- Success returns `{ "imported": <record count> }`. Invalid archives return 400,
  a nonempty destination in empty mode returns 409, and oversized requests return 413.

Archive envelope: `format: "crosspoint-sync-account"`, `version: 1`, `exported_at`
(ISO timestamp), `profile` (source username, auto-pause days, public-profile boolean),
and `data` (named arrays of portable database records). Account IDs, passwords,
server-local change sequences and clipping revisions are never exported or accepted.
Unknown data sections and columns are rejected; update the destination if it cannot
read fields exported by a newer server.

## Import reading history

In app **Settings → Import reading history**, choose:

- A **Goodreads library CSV** or **StoryGraph library CSV** (UTF-8, up to 10 MB).
- A **KOReader `statistics.sqlite3`** or **KOInsight SQLite database** (`.sqlite`,
  `.sqlite3`, or `.db`), or a ZIP containing exactly one supported database (50 MB).
  A CrossPoint database alongside it is ignored.

Choose **Review history** before importing. Uploads merge into the signed-in
account. Existing metadata, manual statuses/dates and personal ratings are kept;
missing fields are filled. Positions, position samples, sync change cursors,
authentication and integration credentials are never imported or changed. Imports
never queue updates to linked services. Export an account backup first for an undo
path. Historical books appear in the Library without a current reader position.

### Goodreads and StoryGraph

The preview shows reading status, optional dates, ISBN, personal rating and book
matches. A previously imported provider ID reuses its saved match. A unique ISBN
match is selected for review; title matches require an explicit choice. Search the
existing library to select another book, create a new book, or skip a row. Repeated
imports reuse source identities even if a book has since been merged.

- `read` becomes Finished, `currently-reading` becomes Reading, and StoryGraph
  `did-not-finish` / `dnf` becomes Did Not Finish. Paused is also recognized.
- To-read entries are skipped and counted in the preview; CrossPoint has no
  want-to-read shelf. Reviews, tags and other unsupported fields are not imported.
- A finished book with no date stays finished with an unknown date. It counts
  toward all-time finished books, but not a particular year or timeline day.
  **Date Added is never used as a reading date.**
- Goodreads imports `Date Read`, `Number of Pages`, ISBN/ISBN13 and `My Rating`.
  Its zero rating means unrated. Personal ratings are stored separately from
  Hardcover's community rating and displayed as **Your rating**.
- StoryGraph imports `Last Date Read` and `Dates Read`, supporting ISO calendar
  dates, DD/MM/YYYY display dates, and YYYY/MM/DD-YYYY/MM/DD reading periods.
  Only the latest period is kept for rereads. A currently-reading book uses an
  open reading period for its start date, not a previous completed read.
- CSVs add no reading sessions, reading time, daily counters or progress logs.
  Recorded start/finish dates mark only those calendar days; days between them
  are not invented. A finished book's known page count can contribute to total
  pages read, but not daily or weekly page activity.

### KOReader and KOInsight

Choose the time zone used for your reading history. For new history, the first
page record at or beyond 98% suggests a finish date. This is an estimate, not an
explicit finished-book flag: review the checked books and dates. KOReader imports
read the raw `book` and `page_stat_data` tables, never its calculated `page_stat`
view. Older KOReader schemas without `page_stat_data` are not supported.

Session counts group page activity with gaps of at most five minutes. Time-of-day
and daily totals use the start time of each page record. Page totals count recorded
page views, including rereads. Unfinished historical books appear under Paused.

Books with existing statistics from another device/import keep those statistics
and completion information; their history is only filled if they have no progress
log entries. This avoids doubling an earlier manual import, but does not repair
partially populated history for such books. Reuploads replace this importer's
own per-book history. KOReader and KOInsight share the import identity, so uploading
the same history through both formats does not count it twice. Upload a complete
history export when refreshing it.

All formats are limited to 10,000 books. Databases allow up to 200,000 page records;
ZIPs allow 100 entries and 100 MB of database contents. Temporary database copies
are opened read-only and removed after every request.
