# CrossPoint EPUB optimizer

`optimizer.js` contains the conversion functions from CrossPoint Reader's
`src/network/html/FilesPage.html`, pinned to
[`facaa87e379a499855e5980edd47beba4d01c884`](https://github.com/crosspoint-reader/crosspoint-reader/blob/facaa87e379a499855e5980edd47beba4d01c884/src/network/html/FilesPage.html).
The original MIT license is in `LICENSE` and the generated module's retained license comment.
JSZip is pinned to 3.10.1, the reader's bundled version.

The app runs this code locally in its WebView. It does not download or execute code
from the connected reader. It matches the pinned reader's normal optimization mode:
grayscale JPEG images fitted to X3 (528 × 792) or X4 (480 × 800), SVG image/cover
unwrapping, font removal, and the same XHTML, CSS, OPF, and NCX transformations.
Quality defaults to 85; existing saved quality choices remain in effect. Device
selection comes from `/api/status`, with X4 as the fallback, like the reader page.
Crop, image splitting, and rotation are disabled. The app does not expose the
reader page's advanced image picker.

The extraction script keeps the conversion routines and their log call sites,
replacing page logging with plain-text events for the app's expandable conversion log.
The log shows image dimensions and sizes, repairs, removed fonts, errors, and a
final size/time summary. Logs remain visible in Send and Browse after completion
or failure, until that screen is closed or the book is retried. Log export is not
implemented. Settings and cancellation are local to each invocation. The host
queues conversions to limit simultaneous ZIP/canvas allocations and leaves saved
downloads unchanged. Rust handles metadata filenames and HTTP uploads.

Three error cases deliberately differ from the pinned reader:

- Undecodable images fail conversion instead of being stored with a wrong `.jpg` extension.
- EPUBs with zero or multiple OPF files, or colliding output image names, fail before image processing.
- Errors inside the async image-load callback reject conversion instead of leaving it pending.

A failed conversion stops the send. The user can turn off Optimize EPUB to send
the original. Cancellation is available to callers through `AbortSignal`, checked
between entries and after conversion; there is no cancel control in the send UI.
Canvas/ZIP work still runs in the foreground WebView. Phone memory use and native
background behavior require device testing. Different browser engines can produce
different JPEG bytes even with identical settings.

## Updating the pinned code

From `app/`, with a reader checkout containing the pinned commit:

```sh
python3 scripts/vendor-epub-optimizer.py /path/to/crosspoint-reader
npm test
npm run build
npx playwright install chromium webkit
CROSSPOINT_READER_REPO=/path/to/crosspoint-reader npm run test:optimizer
```

To update, change `REVISION` in the script and the reference revision in
`tests/optimizer.browser.js`, review the source changes and extraction adaptations,
regenerate, and update this document. Do not edit `optimizer.js` directly.

Browser tests exercise real Canvas/JPEG conversion in Chromium and WebKit. With
`CROSSPOINT_READER_REPO` set, they also load the unmodified pinned reader page and
compare every output EPUB entry against the app's output in the same browser,
including JPEG bytes. Without the checkout, only that comparison is skipped.
