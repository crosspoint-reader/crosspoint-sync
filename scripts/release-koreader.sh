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
Install by extracting crosspoint-koreader.zip into KOReader's plugins folder and restarting KOReader.

After one-time setup, stats upload automatically after successful Progress sync to the same CrossPoint server and account. Manual full-history sync is also available.

[Setup and usage instructions](https://github.com/$repo/blob/$tag/koreader/crosspoint.koplugin/README.md)

Requires a CrossPoint Sync server with the /api/v1/stats/koreader endpoint. Plugin installation alone does not update the server.
NOTES
# Keep plugin releases separate from the server's v* releases and Latest pointer.
gh release create "$tag" dist/crosspoint-koreader.zip \
  --repo "$repo" --target "$commit" --latest=false \
  --title "KOReader plugin ${tag#koreader-v}" --notes-file "$notes"
