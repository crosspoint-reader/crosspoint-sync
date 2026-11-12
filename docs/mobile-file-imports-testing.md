# Mobile file import verification

## Automated checks

- In `app`: `npm test -- --exclude '**/.ios-personal/**'` and `npm run build`.
  The exclusion skips the local personal iOS build directory, whose source is a
  symlink back to the app (otherwise every frontend test runs twice).
- `cargo test --manifest-path app/src-tauri/Cargo.toml --lib --offline`.
- `cargo check --manifest-path app/src-tauri/Cargo.toml --lib --target aarch64-apple-ios --offline`.
- Build the `CrossPointShare` target in the generated Xcode project. The main
  app embeds and signs that extension as a dependency. `project.yml` preserves
  its configuration when regenerating the project.
- With Android SDK 36 configured, run the normal Tauri Android development
  build; native Android compilation was unavailable on the implementation host.

Verified on the implementation host: frontend suite (424 tests), Rust library
suite (22 passed, 1 existing live-network test ignored), production frontend
build, iOS Rust target check, and unsigned iOS Share extension build. Native
end-to-end device checks below remain necessary on both platforms.

## Device checks

1. From Files/a document provider, share one file of each supported type. Repeat
   with CrossPoint Sync closed, already open on another tab, and signed out.
   Sign in if needed; confirm Send books lists each file with its original name.
   Importing must work without the reader connected.
2. Share multiple mixed formats, including two distinct files with the same
   name. Confirm both copies can be sent/removed independently. Unsupported
   files should produce a clear message and should not enter the queue.
3. Use Open In from Files and a browser's downloaded-file menu. Check iCloud
   Drive on iOS and a content-URI document provider on Android. Browser links
   alone are not files; first download the document.
4. Kill/relaunch the app and switch away from/back to Send books. Files remain
   until successfully sent or explicitly removed. Delete the source file after
   import; the queued copy must remain readable.
5. Disconnect the reader and attempt Send. Reconnect, relaunch, and retry. Only
   successful sends leave the queue. Remove a failed file and confirm it stays
   removed after relaunch. Verify optimization/renaming and ACSM errors continue
   through the existing transfer pipeline.
6. Navigate away and back during an upload. The same file must not be sent
   twice. Import another file during an upload; it remains queued for a later
   Send action.
7. On Android, rotate/recreate the activity while an incoming copy runs; also
   kill its background process mid-copy and restore the activity. The delivery
   ID is saved in activity state, incomplete staging is retried, and completed
   deliveries are recorded independently of queue removal, preventing replay.
8. On iOS Share, verify saving progress, per-file failures, and Done. It does
   not launch the containing app. Open CrossPoint Sync afterward; it discovers
   the App Group queue and navigates to Send books. Also test sharing before
   the app's first launch and after signing out.

## Storage contract

Each entry is `ImportQueue/<unique-id>/<original-name>`. Producers copy into
`ImportQueue/.<unique-id>` and rename the directory only on success. Rust ignores
staging directories and refuses path traversal/symlink entries. Android uses
Tauri's app data directory (`applicationInfo.dataDir`); iOS uses the shared App
Group container. No original/source file is deleted. Android delivery receipts
live in private preferences so restoring an activity cannot reimport a file
already sent or removed. Files and receipts are local to this app installation.
