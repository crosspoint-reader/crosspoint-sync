#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ $# != 1 || ! $1 =~ ^koreader-v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo 'Usage: npm run release:koreader -- koreader-v0.1.0' >&2
  exit 1
fi
tag=$1
if [[ -n $(git status --porcelain) ]]; then
  echo 'Commit or stash working-tree changes before releasing a reproducible plugin ZIP.' >&2
  exit 1
fi
if git show-ref --verify --quiet "refs/tags/$tag"; then
  echo "Tag already exists locally: $tag. Use a new version." >&2
  exit 1
fi
repo=$(gh repo view --json nameWithOwner --jq '.nameWithOwner')
commit=$(git rev-parse HEAD)
# Verify the exact build commit is on GitHub before creating a tag/release.
gh api "repos/$repo/commits/$commit" --silent
remote_tag=$(git ls-remote --tags "https://github.com/$repo.git" "refs/tags/$tag")
if [[ -n $remote_tag ]]; then
  echo "Tag already exists on GitHub: $tag. Use a new version." >&2
  exit 1
fi
npm run test:koreader
npm run build:koreader

notes=$(mktemp)
trap 'rm -f "$notes"' EXIT
cat > "$notes" <<NOTES
Install by extracting crosspoint-koreader.zip into KOReader's plugins folder and restarting KOReader. The plugin is now named **CrossPoint Sync**, with **Last sync result** in its menu. Existing account settings are preserved.

Fixes "Could not create a sync result file" on some Android devices (#125), where Setup and Sync now failed before any network request. If the private result file cannot be reserved in KOReader's settings directory, the plugin now falls back to a plain file create there, then to KOReader's data directory. If every attempt fails, the message now includes the error number and reason for each directory. The cause of the original failure on the reporting Xiaomi/MIUI device is not yet known; the reporter confirmed an equivalent fallback let a full sync complete, and this exact build has not been verified on that device.

Adds **Sync all highlights and bookmarks**: background upload of saved annotations from books in KOReader's retained reading history, without opening each document or requiring Reading statistics. Uses live annotations for the open book and saved page numbers for other books. Missing, unreadable, legacy or incomplete metadata is skipped and reported. Saved files are read-only; the backfill never infers deletions, and acknowledged unchanged annotations are not resent on retry.

Sync results now show annotation books checked and acknowledged changes instead of claiming available annotations synced when none were inspected. Books removed from KOReader's reading history are outside the scan. Legacy annotation files require opening once in a current KOReader version to migrate.

Fixes missing TLS Server Name Indication (SNI) in Turbo's LuaSocket backend. The plugin now supplies the hostname before the TLS handshake, allowing reverse proxies to select the correct certificate. Reproduced the previous code -5 / 10-second connect timeout against an SNI-required local TLS server; the patched transport reached HTTP authentication with 100-byte, 100 KB and 500 KB requests. Certificate-chain verification stays enabled, and private CAs must still be added to cacert.pem. This addresses a possible cause of discussion #102; the reporter's device and network have not been verified.

Skips books with existing history-import conflicts (HTTP 409) and continues syncing the rest of the library. Last sync result lists skipped books. Automatic sync does not show a failure popup for these conflicts. Existing history is preserved; skipped books are not marked uploaded and can retry later. No re-import is required to sync other books. Progress and available annotations continue independently.

Retains the 0.2.6 transport fix. Fixes the HTTP 400 caused by Turbo appending four extra CRLF bytes beyond the declared Content-Length. The plugin now sends exactly the declared body length, preserving the payload and its own trailing newlines.

Reproduced with the real Turbo 2.1.5 / LuaSocket / LuaSec stack: 100 KB and 500 KB requests returned a proxy-level 400 before the framing fix. With the fix, 100-byte, 100 KB and 500 KB synthetic unauthenticated requests all reached the application's JSON 401 response. No credentials or reader data were sent. This verifies hosted transport/framing. Separate authenticated imports of 100, 1,000 and 5,000 synthetic page records passed against an ephemeral local server. A full sync on a physical KOReader device still needs verification.

Retains the 0.2.5 partial-write retries and background-process uploads. TLS settings and server data are unchanged.

Connection error codes and messages remain available under **CrossPoint Sync → Last sync result**.

Includes the 0.2.3 checkpoint compatibility fix and the CrossPoint Sync rename.

After one-time setup, reading statistics, highlights, notes and bookmarks upload automatically after successful Progress sync to the same CrossPoint server and account. Manual full-history sync is also available.

Automatic annotations upload from the open book, including edits and deletions. Use the new backfill action for saved books. Annotation sync is upload-only; downloading annotations into KOReader and firmware integration are not included.

Fixes the UI freeze in plugin 0.2.1: uploads now run in a separate background process with Turbo UI mode enabled or disabled. Slow requests no longer occupy the reading UI. Suspend cancels uploads, stuck jobs have a five-minute deadline, and acknowledged batches are checkpointed for retries. TLS certificate verification remains enabled.

Validated with Lua/LuaJIT sync checks and real-process responsiveness tests covering delayed work, cancellation, worker crashes, deadlines and checkpoint recovery. Full KOReader emulator and real-device testing are still needed.

[Setup and usage instructions](https://github.com/$repo/blob/$tag/koreader/crosspoint.koplugin/README.md)

Use CrossPoint Sync server v0.2.0 or newer for this release. Plugin installation alone does not update the server.
NOTES
# Keep plugin releases separate from the server's v* releases and Latest pointer.
gh release create "$tag" dist/crosspoint-koreader.zip \
  --repo "$repo" --target "$commit" --latest=false \
  --title "CrossPoint Sync for KOReader ${tag#koreader-v}" --notes-file "$notes"
