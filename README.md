# crosspoint-sync

A lightweight, self-hostable sync server for [CrossPoint / CrossInk](https://github.com) e-readers —
and any KOReader device.

- **100% KOSync-compatible.** Point stock KOReader or current CrossPoint firmware at it by changing
  only the sync-server URL. Same accounts, same auth, same endpoints as `sync.koreader.rocks`.
- **Better multi-device sync.** Progress is stored per device and the newest position wins, fixing
  the ping-pong you get with stock kosync servers.
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
  -v "$PWD/data:/data" \
  ghcr.io/OWNER/crosspoint-sync:latest
```

Or from a checkout: `docker compose up -d` (see `docker-compose.yml`).

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
| `DATABASE_PATH` | `/data/crosspoint.db` | SQLite file (parent dirs auto-created) |
| `REGISTRATION_DISABLED` | `false` | Set `true` to lock down a private instance |
| `AUTH_RATE_LIMIT_PER_MINUTE` | `30` | Per-IP limit on registration (0 disables) |
| `TOKEN_ENC_KEY` | _(unset)_ | Enables connectors (Hardcover/Readwise sync). 64 hex chars, a base64 32-byte key, or a ≥32-char passphrase. Encrypts stored connector credentials at rest; unset = connectors disabled. |

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
