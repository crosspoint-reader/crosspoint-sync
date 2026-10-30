# Store assets

Makes the Google Play and App Store images from the real app UI:

```sh
cd app/store
npm install
node make-assets.mjs [out-dir]   # default: app/store/out
```

Output:

| Files | Size | For |
|---|---|---|
| `phone-*.png` | 1080x1920 | Play phone screenshots |
| `tablet-7in-*.png` | 1080x1920 | Play 7-inch tablet |
| `tablet-10in-*.png` | 2560x1440 | Play 10-inch tablet |
| `iphone-6.9in-*.png` | 1320x2868 | App Store iPhone 6.9" |
| `ipad-13in-*.png` | 2064x2752 | App Store iPad 13" |
| `iphone-duo-*.png` | 1398x2034 | App Store iPhone Duo (outer display), only with `DUO_SHOTS` |
| `feature-graphic.jpg` | 1024x500 | Play feature graphic |
| `appstore-header.png` | 3840x1646 | App Store product page header (iOS 27+) |
| `appstore-search.png` | 3840x2560 | App Store search result card (iOS 27+) |
| `appstore-*-logos.png` | same | The same two placements with the services it syncs to |
| `icon-512.png` | 512x512 | Play app icon |

It needs Google Chrome, ImageMagick (`magick`), `npm install` already run in the repo root and in `app/`, and ports 1430, 8798 and 8799 free. A run takes about two minutes.

## How it works

1. It starts a throwaway sync server on an empty database and seeds it with ten public-domain books: progress, statuses, reading dates, highlights, a device stats snapshot, a few weeks of reading history, and Hardcover and Readwise Reader links. Covers are Project Gutenberg's scans, fetched and upscaled on each run.
2. It starts a stand-in for a CrossPoint X3's Wi-Fi file server, so the Send screen shows a connected reader.
3. It serves `app/` with Vite and opens it in Chrome as the native app would look. Requests to sync.crosspointreader.com and crosspoint.local are rerouted to the stand-ins, so the screens show the hosted server name.
4. It captures each screen at phone and tablet sizes, then frames the captures with `frame.html`: a caption, a device bezel, and sometimes an enlarged callout cropped from the same capture.

Everything shown is the real UI with sample data. Spotify is filtered out of the connectors list, since it's in beta and kept out of store materials.

## iPhone Duo

The Duo set is framed from screenshots of the real app in the iPhone Duo simulator, folded, saved from Simulator with the device frame on (1574x2194, transparent around the frame). `DUO_SHOTS=<dir> node make-assets.mjs` places `duo-library.png`, `duo-book.png`, `duo-stats.png`, `duo-clippings.png`, `duo-send.png` and `duo-settings.png` (scrolled to a service) from that folder as they are, with the same captions and callouts as the other sets. Without `DUO_SHOTS` the set is skipped.

The last set is in `~/Desktop/app-store/iphone-duo/framed/`. Callout crops for them are `CROPS.duo`, in those images' pixels (the screen starts at 88, 80).

## Changing things

- Captions and which screen uses which layout: `CAPTIONS` and `SETS` in `make-assets.mjs`.
- Layouts: `layouts` in `frame.html`.
- Callout crops are pixel rectangles in the captures (`CROPS`), and so are the App Store header and search cards (`CARDS`). If the app's layout moves, run with `KEEP_RAW=1` to keep the raw captures and re-measure the crops against them.
- Sample data: `BOOKS` and `CLIPPINGS`.
