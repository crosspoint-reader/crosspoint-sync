# CrossPoint Sync app

Companion app for a crosspoint-sync server: reading stats, currently reading, clippings per book,
and marking books reading / paused / finished / did not finish. It also browses OPDS catalogs
(Project Gutenberg built in; add Calibre, Kavita, Mayberry, or any OPDS 1.2/2.0 feed with no login,
a password, or a token), downloads books, and sends them to a CrossPoint over Wi-Fi via its File
Transfer server (`crosspoint.local`), optionally re-encoding EPUB images as JPEG first.

The OPDS client (`src-tauri/src/opds`) and EPUB optimizer (`src-tauri/src/optimizer.rs`) are ported
from common-stacks. Downloads live in `~/Books/CrossPoint Sync` on desktop and in app storage on
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
