# crosspoint-sync

A lightweight, self-hostable sync server for [CrossPoint / CrossInk](https://github.com) e-readers —
and any KOReader device.

- **100% KOSync-compatible.** Point stock KOReader or current CrossPoint firmware at it by changing
  only the sync-server URL. Same accounts, same auth, same endpoints as `sync.koreader.rocks`.
- **Better multi-device sync.** Progress is stored per device and the newest position wins, fixing
  the ping-pong you get with stock kosync servers.
- **Server-side service connectors.** Link services such as Hardcover, Micro.blog, Audiobookshelf, Jellyfin, BookOrbit, Readwise Reader, and Seekquel once; readers continue speaking standard KOSync while the server updates external reading state.
- **BookOrbit on demand.** Reader progress requests fetch the matched book’s latest progress and highlights. On a book’s page, **Connected services → BookOrbit → Sync now** pulls before queueing outbound updates and refreshes that book’s reading history. BookOrbit has no periodic polling; reading-session uploads trigger delivery directly.
- **Lossless CrossPoint sync.** An extended API carries the full CrossPoint position (spine,
  paragraph, anchor, page hints), not just a lossy xpath + percentage.
- **Bookmarks, clippings, and reading stats.** Delta sync with tombstones for bookmarks and
  clippings; per-device reading-stats snapshots with a server-side combined view (streaks included).
- **One codebase, one runtime.** A single Node + SQLite server in one Docker image — the hosted
  service and self-hosted installs run the exact same thing. No native dependencies (uses Node's
  built-in `node:sqlite`).

The full wire contract is in [docs/API.md](docs/API.md).

## Run it

### Docker

```sh
docker run -d --name crosspoint-sync \
  -p 8080:8080 \
  -v crosspoint-data:/data \
  ghcr.io/crosspoint-reader/crosspoint-sync:main
```

Or from a checkout: `docker compose up -d` uses the published image from
`docker-compose.yml`.

For local image builds from the checkout, use:

```sh
docker compose -f docker-compose.dev.yml up -d --build
```

For localhost testing with connector credentials, Docker can forward requests
from a bridge address instead of a loopback address. Put your persistent
`TOKEN_ENC_KEY` in `.env`, then run:

```sh
HOST_BIND=127.0.0.1 HOST_PORT=8081 ALLOW_HTTP_LOCALHOST=true \
  docker compose -f docker-compose.dev.yml up -d --build
```

Open `http://localhost:8081/app/`. This opt-in allows credential entry over HTTP
only for localhost URLs; keep the host port bound to `127.0.0.1`. For `docker run`,
use `-p 127.0.0.1:8081:8080 -e ALLOW_HTTP_LOCALHOST=true` and your existing encryption
key and data volume. Public/self-hosted network deployments should use HTTPS.

To serve under a subpath, pass `-e BASE_PATH=/crosspoint-sync` to `docker run`,
or run `BASE_PATH=/crosspoint-sync docker compose up -d`. The same image works
at any prefix; no frontend rebuild is needed.

### HTTPS reverse proxy (Caddy, nginx, etc.)

When the proxy handles HTTPS and forwards HTTP to Sync, set `TRUST_PROXY=true`
**on the Sync server**. Without it, linking BookOrbit or another connector fails
with "Connector credentials require HTTPS", even when the browser uses HTTPS.
This check concerns the connection to Sync, regardless of the BookOrbit server URL.

For Caddy running directly on the Docker host, replace the existing published port
in `docker-compose.yml` and add `TRUST_PROXY` to the service's existing environment:

```yaml
services:
  crosspoint-sync:
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      TRUST_PROXY: "true"
```

Keep the service's other settings, including `TOKEN_ENC_KEY` for connector storage.
Apply the changes with `docker compose up -d` so the container is recreated with
the new environment. Adding `TRUST_PROXY=true` to a Compose `.env` file alone
does not pass it into the container; it must appear in the service's `environment`.
For bare Node, set it in the server process's environment and restart the process.

A minimal Caddyfile for that host setup is:

```caddyfile
sync.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

[Caddy sets `X-Forwarded-Proto` automatically](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#defaults).
Other proxies must also overwrite it with the original request's scheme. Only enable
proxy trust when clients cannot bypass the proxy and reach Sync directly. If Caddy
runs in Docker, use a shared private Docker network and proxy to `crosspoint-sync:8080`
without publishing Sync's port, instead of using the host loopback example above.

### Railway (hosted-style deploy)

1. New project → Deploy from this repo (Railway detects the Dockerfile).
2. Attach a **volume** mounted at `/data`.
3. That's it — the server listens on Railway's `PORT` automatically.

### NixOS
Add this repository as a flake input and add the module to your configuration:
```nix
{
    crosspoint-sync.url = "github:rogierknoester/crosspoint-sync";
    crosspoint-sync.inputs.nixpkgs.follows = "nixpkgs";
    ...
}: {
  nixosConfigurations = {
    myServer = nixpkgs.lib.nixosSystem {
      ...
      modules = [
        ./configuration.nix
        crosspoint-sync.nixosModules.crosspoint-sync
      ];
    };
  };
}
```

Now you can enable it in your `configuration.nix`:
```nix
services.crosspoint-sync = {
  enable = true;
  port = 8080;
  registration = true;
  # Optional: serve at /crosspoint-sync/ instead of /.
  basePath = "/crosspoint-sync";
};
```

### Bare Node (≥ 22.13)

```sh
npm ci && npm run build && npm run build:frontend
DATABASE_PATH=./data/crosspoint.db PORT=8080 node dist/index.js
```

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `PORT` | `8080` | Listen port |
| `LISTEN_ADDRESS` | `localhost` (`::` in the Docker image) | Interface to listen on. `::` listens on all of them, which a container needs to be reachable. |
| `BASE_PATH` | _(empty)_ | URL prefix, e.g. `/crosspoint-sync`. Empty or `/` serves at the domain root; trailing slashes are normalized. Applies to the website, API, and health endpoint (`/crosspoint-sync/healthz` in this example). Set at runtime; no frontend rebuild needed. Reverse proxies must preserve the prefix, not strip it. |
| `DATABASE_PATH` | `/data/crosspoint.db` | SQLite file (parent dirs auto-created) |
| `REGISTRATION_DISABLED` | `false` | Set `true` to lock down a private instance |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `30` | Per-IP limit on registration (0 disables) |
| `TOKEN_ENC_KEY` | _(unset)_ | Enables external-service connectors. 64 hex chars, a base64 32-byte key, or a ≥32-char passphrase. Encrypts stored connector credentials at rest; unset = connectors disabled. |
| `ALLOW_HTTP_LOCALHOST` | `false` | Local Docker testing only: allow connector credentials over HTTP at `localhost`, `127.0.0.1`, or `[::1]` when Docker forwards from a bridge peer. Bind the published port to `127.0.0.1`; leave disabled on network-facing deployments. |
| `TRUST_PROXY` | `false` (`true` on Railway) | Set `true` only when direct access is blocked and a trusted reverse proxy overwrites any client-supplied `X-Forwarded-Proto`; permits connector linking through an HTTPS-terminating proxy. Defaults to `true` when `RAILWAY_ENVIRONMENT` is present, since Railway always fronts the service with its TLS-terminating edge; set `TRUST_PROXY=false` to override. |
| `GOOGLE_BOOKS_API_KEY` | _(unset)_ | Optional. Fallback source for print page counts when Open Library has none (keyless Google Books has no quota). |
| `HARDCOVER_API_KEY` | _(unset)_ | Optional. A Hardcover API key (`read:catalog` is enough) for book details from Hardcover's catalog: moods, genres, content warnings, rating, series, release year, and page counts/covers where other sources miss. One lookup per distinct book, cached for all users, throttled under Hardcover's free-plan limits. |
| `LEGACY_WEB` | _(unset)_ | The website is the CrossPoint Sync app at `/app/` (the old account pages redirect there; Kindle setup keeps its pages). Set `1` to keep the old server-rendered website instead. |
| `HARDCOVER_CLIENT_ID` | CrossPoint Sync's app | Optional. Hardcover OAuth client id for "Connect Hardcover" sign-in. The built-in id is CrossPoint Sync's public Hardcover app and works for self-hosted servers too; set this only to use your own Hardcover developer app. |
| `SEARCHAPI_KEY` | _(unset)_ | Optional, paid ([searchapi.io](https://www.searchapi.io)). Last fallback for print page counts: Amazon search + product "Print length", 2 requests per book, only for books the free sources miss. Cached forever. |
| `SEEKQUEL_URL` | `https://api.seekquel.app` | Optional. The Seekquel API the Seekquel connector links to and sends to. Only for testing against a local Seekquel. |
| `CORS_ORIGINS` | `*` | Origins allowed to call the sync API from browsers (comma-separated). The default wildcard is safe: the API authenticates with headers, not cookies, and the web UI's cookie routes never get CORS headers. |

With `BASE_PATH=/crosspoint-sync`, open `https://your-host/crosspoint-sync/`
and configure readers with `https://your-host/crosspoint-sync` as their server
URL. OAuth providers must allow the prefixed callback URL shown in Settings.
Native app association files, when enabled, remain at domain-root `/.well-known/`.

### Link Micro.blog

1. Sign in to [Micro.blog](https://micro.blog/).
2. Open [Account → App tokens](https://micro.blog/account/apps).
3. Create a separate app token for **CrossPoint Sync**.
4. In CrossPoint Sync, open your account, choose **Micro.blog**, and paste the new token.

Treat the token like a password: Micro.blog app tokens have full account access. CrossPoint Sync
encrypts the token at rest using `TOKEN_ENC_KEY`.

With Micro.blog linked, each clipping on the **Clippings** page has an
**Add clipping to Micro.blog** action. Selected clippings are collected into
one post per book, titled **📚 Clippings from {book title}**, with a link to the
matched Micro.blog book page. Later clippings update the same post. CrossPoint
Sync manages its generated content, so later updates replace edits made directly
to that content on Micro.blog.

Choose **Post clippings to** in Micro.blog settings when the token accesses
multiple blogs. A sole available blog is selected automatically. The choice
applies to new collections: existing posts and new clippings for those books stay
on the book's original blog. Revoked access pauses posting to that blog; selecting
a different one never moves existing collections automatically.

**Automatically sync clippings** is off by default. Enabling it includes existing
and future clippings. Unmatched books wait without interrupting reader sync;
after matching, eligible clippings are sent on the next reader sync or **Sync now**.
Turning automatic sync off stops automatic additions while retaining published
passages and manually selected clippings.

Deleting a post on Micro.blog pauses publication for that book while preserving
its clippings locally. After the missing post is detected on an update, the
**Micro.blog publishing paused** section on the Clippings page offers **Recreate
clippings post**, even if the book has no live local clippings. This explicitly
republishes the collected clippings to either the previous blog (the default) or
the current clippings blog selected in Settings. Future updates for this book
follow the replacement post. If the previous blog is accessible, Sync rechecks
that the old post is still missing; a restored post can be resumed on the previous
blog instead. A previously confirmed deletion can also be recreated on the current
blog after access to the previous blog is lost. Network or permission errors do
not trigger automatic recreation.

Merging books that both have Micro.blog publication history pauses their combined
collection. Settings shows the conflict as a sync error so you can review the
existing posts before publishing further clippings.

For local testing, use Node 22.13 or newer, build the frontend with
`npm run build:frontend`, and copy `.env.example` to `.env`. Set a separate
`DATABASE_PATH` (such as `./data/microblog-test.db`), `PORT=8081`, and a persistent
`TOKEN_ENC_KEY` generated with `openssl rand -hex 32`. Run `npm run dev` and open
[the local app](http://localhost:8081/app/). Create a local account, sync a book
and its clippings from a reader, link Micro.blog, and match the book before trying
the clipping action or automatic sync. These actions publish to the linked blog.

## Point your reader at it

- **KOReader:** Tools → Progress sync → Custom sync server → `http://your-host:8080`
- **CrossPoint / CrossInk:** Settings → KOReader Sync → Sync Server URL

Create an account from the device (register via the sync settings), or:

```sh
curl -X POST http://localhost:8080/users/create \
  -H 'content-type: application/json' \
  -d '{"username":"justin","password":"'"$(printf '%s' 'my-password' | md5sum | cut -d' ' -f1)"'"}'
```

(The `password` field is the MD5 of your password — that's the kosync protocol; the server stores
a salted PBKDF2 of it, never the raw value.)

## Development

```sh
npm ci
npm run dev        # tsx watch, http://localhost:8080 (set DATABASE_PATH=./data/dev.db)
npm test           # vitest: kosync compat suite + v1 API suite
scripts/curl-smoke.sh http://localhost:8080   # end-to-end smoke against a running server
```

## License

MIT

### Merged-book clipping compatibility

Clipping uploads to a merged book's old hash are stored under its canonical
hash, matching progress sync. Reads by either hash include clipping data left
under aliases by older server versions; no database rows are deleted or rewritten
during reads. Clipping IDs appear once, with any deletion marker taking precedence;
live duplicates use the newest revision and retain existing canonical annotations
when an old alias upload omitted them. The clipping hub returns canonical hashes.

Clients that cached separate alias clipping cursors should reread merged books
with `cursor=0` once after upgrading to recover older records they have not seen.
New delta reads use the family's highest revision for each clipping ID.

Per-book stats retain the existing selective merge policy: uploads remain under
the original document hash, and only aliases merged with stats contribute to the
canonical book's totals. Unmerging restores the original independent stats.


### Daily reading duration

`PUT /api/v1/stats/global` accepts an optional `daily` array (up to 20 unique
local dates per request), e.g. `[{"date":"2026-10-01","seconds":61}]`, alongside
the existing global snapshot. Seconds are whole cumulative **device-local**
reading seconds for that calendar date; minutes are derived as seconds / 60.
Valid dates are 2000–2099; durations are integers from 0 through 4294967295.
The response includes `accepted_daily`, including 0 for legacy payloads.

Migration `0014_daily_reading.sql` adds `stats_device_day` without modifying old
snapshots or generating historical days. Each `(user_id, device_id, date)` stores
the maximum received counter. Repeats, stale requests, and missing dates in partial
batches cannot add time twice or erase it. Devices must send only their own local
counters with a stable ID; copying a device's history to another identity would
count it twice. Concurrent reading on two devices counts each device's active
time. Counters are monotonic history, independent of resettable global totals.

`GET /api/v1/stats/global` includes `stats.daily` for each device.
`GET /api/v1/stats/summary` includes date-sorted `daily` rows with `date`, summed
`seconds`, and fractional `minutes`. The reader has already applied its timezone;
these dates are never converted using the server or browser timezone. Absent daily
history means unknown, not historical zero. Account data deletion removes the new
data; book merges/unmerges/deletion do not change device/day counters.


Regression checks: `npm test`, `npm run build`; after building the CrossInk
simulator, `node test/daily-firmware-smoke.mjs /absolute/path/to/crossink/.pio/build/simulator/program`
checks manual upload, shared sender/retries/increments, and an old server without
a daily acknowledgment using only disposable loopback fixtures.
