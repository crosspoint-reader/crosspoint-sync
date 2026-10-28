# Offline iOS Shortcuts

Approved scope: read-only actions for finding books and clippings, backed by the app's existing offline data. Books expose title, author, status, progress, last sync and cache freshness; clippings expose text, note, chapter, creation date, book and cache freshness. Signing out clears shared data.

## Approach

Mirror the existing WebView cache into the main app’s private Application Support directory through a Tauri command. Native Swift App Intents read that snapshot without network calls or WebView execution. Preserve server fetch timestamps on offline reads and app restarts. Publish complete book lists and update clippings when fetched by the app, including individual book fetches. Never export credentials. Partition entity identifiers by server/account and reject stale account results.

Alternatives considered: native queries fetching the server each time (poor offline behavior); a separate native sync process (duplicates the app's data flow). The user selected reusing the app's offline data.

## Boundaries

Keep iOS 16 support. Find Books filters status and text; Find Clippings filters book, text and creation date. Get Book resolves a selected book. Return structured entities, not formatted summaries. Uncached data produces an actionable error; a cached empty collection returns no results. No write actions or automatic background fetching. Clippings availability follows what the app has loaded; document the server's all-clippings limit.

## Validation

Exercise publication, offline freshness, complete pagination, per-book replacement, sign-out and in-flight account isolation. Test native decoding, filtering and entity account isolation. Compile Swift App Intents for iOS if an SDK is available; otherwise report that limitation explicitly and provide device verification steps.

App Intents run in the main app target and read private Application Support storage. Widget sharing and signing settings are unaffected.
