# crosspoint-sync

A lightweight, self-hostable sync server for [CrossPoint / CrossInk](https://github.com) e-readers —
and any KOReader device.

- **100% KOSync-compatible.** Point stock KOReader or current CrossPoint firmware at it by changing
  only the sync-server URL. Same accounts, same auth, same endpoints as `sync.koreader.rocks`.
- **Better multi-device sync.** Progress is stored per device and the newest position wins, fixing
  the ping-pong you get with stock kosync servers.
- **Server-side service connectors.** Link services such as Hardcover, Micro.blog, Audiobookshelf, BookOrbit, and Readwise Reader once; readers continue speaking standard KOSync while the server updates external reading state.
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
};
```

### Bare Node (≥ 22.13)

```sh
npm ci && npm run build
DATABASE_PATH=./data/crosspoint.db PORT=8080 node dist/index.js
```

## Configuration

| Env var | Default | Meaning |
|---------|---------|---------|
| `PORT` | `8080` | Listen port |
| `LISTEN_ADDRESS` | `localhost` (`::` in the Docker image) | Interface to listen on. `::` listens on all of them, which a container needs to be reachable. |
| `DATABASE_PATH` | `/data/crosspoint.db` | SQLite file (parent dirs auto-created) |
| `REGISTRATION_DISABLED` | `false` | Set `true` to lock down a private instance |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `30` | Per-IP limit on registration (0 disables) |
| `TOKEN_ENC_KEY` | _(unset)_ | Enables external-service connectors. 64 hex chars, a base64 32-byte key, or a ≥32-char passphrase. Encrypts stored connector credentials at rest; unset = connectors disabled. |
| `TRUST_PROXY` | `false` (`true` on Railway) | Set `true` only when direct access is blocked and a trusted reverse proxy overwrites any client-supplied `X-Forwarded-Proto`; permits connector linking through an HTTPS-terminating proxy. Defaults to `true` when `RAILWAY_ENVIRONMENT` is present, since Railway always fronts the service with its TLS-terminating edge; set `TRUST_PROXY=false` to override. |
| `GOOGLE_BOOKS_API_KEY` | _(unset)_ | Optional. Fallback source for print page counts when Open Library has none (keyless Google Books has no quota). |
| `HARDCOVER_API_KEY` | _(unset)_ | Optional. A Hardcover API key (`read:catalog` is enough) for book details from Hardcover's catalog: moods, genres, content warnings, rating, series, release year, and page counts/covers where other sources miss. One lookup per distinct book, cached for all users, throttled under Hardcover's free-plan limits. |
| `LEGACY_WEB` | _(unset)_ | The website is the CrossPoint Sync app at `/app/` (the old account pages redirect there; Kindle setup keeps its pages). Set `1` to keep the old server-rendered website instead. |
| `HARDCOVER_CLIENT_ID` | CrossPoint Sync's app | Optional. Hardcover OAuth client id for "Connect Hardcover" sign-in. The built-in id is CrossPoint Sync's public Hardcover app and works for self-hosted servers too; set this only to use your own Hardcover developer app. |
| `SEARCHAPI_KEY` | _(unset)_ | Optional, paid ([searchapi.io](https://www.searchapi.io)). Last fallback for print page counts: Amazon search + product "Print length", 2 requests per book, only for books the free sources miss. Cached forever. |
| `CORS_ORIGINS` | `*` | Origins allowed to call the sync API from browsers (comma-separated). The default wildcard is safe: the API authenticates with headers, not cookies, and the web UI's cookie routes never get CORS headers. |

### Link Micro.blog

1. Sign in to [Micro.blog](https://micro.blog/).
2. Open [Account → App tokens](https://micro.blog/account/apps).
3. Create a separate app token for **CrossPoint Sync**.
4. In CrossPoint Sync, open your account, choose **Micro.blog**, and paste the new token.

Treat the token like a password: Micro.blog app tokens have full account access. CrossPoint Sync
encrypts the token at rest using `TOKEN_ENC_KEY`.

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
