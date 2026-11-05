# CrossPoint Sync app

Companion app for a crosspoint-sync server: reading stats, currently reading, clippings per book,
and marking books reading / paused / finished / did not finish. It also browses OPDS catalogs
(Project Gutenberg built in; add Calibre, Kavita, Mayberry, or any OPDS 1.2/2.0 feed with no login,
a password, or a token), downloads books, and sends them to a CrossPoint over Wi-Fi via its File
Transfer server (`crosspoint.local`), optionally optimizing EPUBs before sending.

The OPDS client (`src-tauri/src/opds`) is ported from common-stacks. EPUB optimization runs a
[pinned copy of CrossPoint Reader's JavaScript optimizer](src/epub/vendor/README.md) in the app's
WebView: images fit the reader's screen in grayscale, SVG covers are fixed, and embedded fonts
are removed. The app detects X3/X4 through the reader's HTTP API. It uses normal optimization
mode; the reader's advanced crop/split/rotation controls are not exposed. Saved originals remain
unchanged, and optimization failures stop the send.

Downloads live in `~/Books/CrossPoint Sync` on desktop and in app storage on
phones. `cargo test -- --ignored` runs a live Gutenberg search-to-download check. Styled with the crosspoint-tools
design tokens (`src/index.css`).

Tauri 2 shell around a React + Tailwind UI, so one codebase builds for macOS, Windows, Linux,
iOS and Android (and runs as a plain web page with `npm run dev`). The UI calls the server's
`/api/v1` with the kosync credentials. Inside the app, requests go through the Tauri http plugin
(Rust side), so self-hosted servers work over plain `http://` on a LAN and regardless of the
server's `CORS_ORIGINS`. In a plain browser it falls back to `fetch` and needs CORS.

Sign in with **CrossPoint** (sync.crosspointreader.com) or **Self-hosted**: type `host:port` or a
full URL. Without a scheme it tries `https://` then `http://`, and only accepts a server that
answers `/healthz` like crosspoint-sync. The last server is remembered after signing out.

```sh
npm install
npm run dev                          # browser, http://localhost:1420
npm run tauri dev                    # desktop window
npm run tauri ios dev                # iOS simulator (needs Xcode)
npm run tauri android init && npm run tauri android dev
npm run tauri build                  # release desktop bundle
```

## Reading widgets and optional goals

The widget gallery offers **Continue Reading**, **Reading Streak**, and **Yearly Goal**.
Apple widgets support small, medium, and large layouts, plus extra-large on iPad.
The iPhone widgets can also appear on your Mac through Apple's Continuity widget support;
they use the iPhone's saved account, rather than the native Mac app's account.
Android offers the same three choices, with details adapting to launcher resizing.
Streaks use recorded reading days, including readers that do not report reading time.
Gallery book samples use *Eternity’s Tomb* by Dan Moren, with the cover bundled from
[the author's book page](https://dmoren.com/writing/eternitys-tomb/).

Choose an optional books-finished target in **Settings → Reading goals**. Each calendar
year has its own target, synced with your account. A target adds a progress card to Stats
and populates the goal widget; removing it removes the Stats card. Unset years have no
target or goal prompts in Stats or the other widgets, and targets never carry forward
automatically. You can explicitly choose a future year's target in advance.
Goals require an updated server with migration `0044_reading_goals.sql`.

Widgets keep saved data offline and clear it on sign-out. The OS controls background
refresh timing. Saved yearly targets remain available offline across year/timezone
changes; completion counts update on the next successful sync. Apple widget taps use
the `crosspointsync://widget/…` app links. On Mac, iPhone-widget interactions follow
the system's Continuity behavior.

Native widget date/compatibility checks (no simulator needed):

```sh
swiftc -module-cache-path /tmp/crosspoint-swift-cache \
  src-tauri/gen/apple/CrossPointWidget/ReadingMetrics.swift \
  scripts/widget-tests/main.swift -o /tmp/crosspoint-widget-tests
/tmp/crosspoint-widget-tests
```

Before release, check the widget gallery and destination links on a signed device,
including iPad extra-large, Mac Continuity, Android resizing, offline reads, and logout.

## iOS Shortcuts (iOS 16+)

The iOS build provides three read-only actions in Shortcuts under **CrossPoint Sync**:

- **Find Books**: optional reading-status and title/author filters. Returns books newest sync first.
- **Get Book**: select a book, or pass one from Find Books, to get its current saved details.
- **Find Clippings**: optional book, text (passage/note/chapter), and creation-date filters. Returns newest first.

Book results expose Title, Author, Reading Status, Progress (%) (0–100), Last Sync,
and Cached At. Clippings expose Text, Note, Chapter, Created At, Book, and Cached At.
For example: Find Books with Reading Status = Reading → Repeat with Each → get
Title, Progress (%) and Last Sync → append to a note. Use status Finished for a
finished-book list. Find Clippings → get Text can feed a quote collection.

Actions read the app's existing offline data through a credential-free snapshot in
the main app’s private Application Support storage. They do not contact the server
or require the app's UI to be open. Open the Library to save books; open Clippings to save the all-book list,
or an individual book to save its clippings. Only data the app has loaded is
available. The all-book clippings endpoint currently returns at most 5,000 items;
opening a book also saves its complete paginated clipping list. Unsynced reader
data cannot appear until the reader uploads it and the app refreshes.

**Last Sync** is the server's latest recorded progress update. **Cached At** is when
the app fetched the data; offline reads and restarts preserve it. Older caches may
have an unknown Cached At until refreshed online. Clippings can have different
cache times because books can refresh separately. Signing out clears the shared
snapshot; saved Shortcuts book selections are scoped to their server and account.
An uncached collection gives instructions to open the relevant app screen, while a
cached empty collection returns an empty list.

Native store checks (no simulator needed):

```sh
swiftc -module-cache-path /tmp/crosspoint-swift-cache \
  src-tauri/gen/apple/Sources/crosspoint-sync-app/ShortcutsStore.swift \
  scripts/shortcuts-tests/main.swift -o /tmp/crosspoint-shortcuts-tests
/tmp/crosspoint-shortcuts-tests
```

Before release, build/install using Xcode and verify all three actions appear in
Shortcuts. Load the Library and Clippings online, turn on airplane mode, close the
app and run each action; check the returned fields and unchanged Cached At. Sign
out and confirm actions no longer return the previous account's data. Sign into a
different account and verify a previously selected book cannot resolve to it.
