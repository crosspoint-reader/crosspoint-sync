# Offline iOS Shortcuts Implementation Plan

**Goal:** Read-only iOS Shortcuts actions backed by the app's existing offline data.
**Architecture:** API cache writes publish a credential-free native snapshot in private Application Support storage. Swift App Intents in the main app read structured books and clippings without network requests.
**Spec:** docs/superpowers/specs/2026-10-28-ios-shortcuts-design.md

## Completed work

- [x] Publish complete cached books and clippings through a Tauri command; restore on launch and clear on logout.
- [x] Preserve fetch timestamps on offline reads, reject late account responses, and retain per-book passages omitted by the capped global clipping response.
- [x] Atomically replace the native snapshot and expose Find Books, Get Book and Find Clippings as structured App Intents.
- [x] Register Swift sources and AppIntents framework in the existing iOS build.
- [x] Document fields, cache population, clipping limits and device verification.

## Validation

- App suite: 239 tests across 21 files, including 11 Shortcuts cache tests.
- Swift store: 12 checks covering filters, dates, account identity and private cache loading.
- Rust: 2 standalone persistence/path tests.
- iOS 16 device-target Swift typecheck and isolated iOS Simulator compilation/metadata extraction.
- App production build and Xcode project plist validation.

Scope excludes changes to signing, widgets, build tooling and developer-team setup.
