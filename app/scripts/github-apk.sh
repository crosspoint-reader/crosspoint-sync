#!/bin/sh
# Attach Google Play's universal APK for the current versionCode to a GitHub
# Release, for people who sideload. It's Play-signed, so it updates with (and
# from) the store copy. Run after the Play upload has processed.
# Commits and pushes any uncommitted changes first, so the tag matches the APK.
# Usage: sh scripts/github-apk.sh
set -e
cd "$(dirname "$0")/.."
conf=src-tauri/tauri.conf.json
version=$(sed -n -E 's/^  "version": "(.*)",/\1/p' "$conf")
code=$(sed -n -E 's/.*"versionCode": ([0-9]+).*/\1/p' "$conf")
tag="app-v$version-$code"
out="$HOME/Desktop/play-store/crosspoint-sync-$version-$code.apk"

node scripts/play.mjs apk "$code" "$out"
# The tag has to point at the code in the APK: commit what's left, then push.
if [ -n "$(git status --porcelain)" ]; then
  git add -A
  git commit -m "Release app $version ($code)"
fi
git push
gh release create "$tag" "$out" --target "$(git rev-parse HEAD)" --title "CrossPoint Sync app $version ($code)" --latest=false --notes "Android app $version, build $code, signed by Google Play.

Download \`crosspoint-sync-$version-$code.apk\` and open it on your phone to install. Android will ask you to allow installs from your browser or file manager. It updates the Google Play copy and the other way round, so you can switch between them anytime."
echo "Released $tag"
