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
