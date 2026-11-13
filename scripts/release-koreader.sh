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

Fixes the checkpoint writer's use of an FFI constant not exposed by KOReader, which could cause uploads to report that the background worker stopped without a usable result. Uses KOReader's supported private temporary-file API and reports worker errors, cancellation and deadlines separately.

After one-time setup, reading statistics, highlights, notes and bookmarks upload automatically after successful Progress sync to the same CrossPoint server and account. Manual full-history sync is also available.

Annotations upload from the open book, including edits and deletions. Open each older book and push progress to backfill its annotations. Annotation sync is upload-only; downloading annotations into KOReader and firmware integration are not included.

Fixes the UI freeze in plugin 0.2.1: uploads now run in a separate background process with Turbo UI mode enabled or disabled. Slow requests no longer occupy the reading UI. Suspend cancels uploads, stuck jobs have a five-minute deadline, and acknowledged batches are checkpointed for retries. TLS certificate verification remains enabled.

Validated with Lua/LuaJIT sync checks and real-process responsiveness tests covering delayed work, cancellation, worker crashes, deadlines and checkpoint recovery. Full KOReader emulator and real-device testing are still needed.

[Setup and usage instructions](https://github.com/$repo/blob/$tag/koreader/crosspoint.koplugin/README.md)

Use CrossPoint Sync server v0.2.0 or newer for this release. Plugin installation alone does not update the server.
NOTES
# Keep plugin releases separate from the server's v* releases and Latest pointer.
gh release create "$tag" dist/crosspoint-koreader.zip \
  --repo "$repo" --target "$commit" --latest=false \
  --title "CrossPoint Sync for KOReader ${tag#koreader-v}" --notes-file "$notes"
