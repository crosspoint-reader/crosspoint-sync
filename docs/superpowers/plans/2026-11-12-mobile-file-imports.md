# Mobile File Imports Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Durable incoming file queue for Share and Open In on Android and iOS.
**Architecture:** Native producers atomically publish unique queue directories containing one named file. Rust exposes list/add/read/remove. The UI observes the queue and uses existing send conversion.
**Tech Stack:** Tauri/Rust, React, Kotlin, Swift, Xcode.
**Spec:** docs/superpowers/specs/2026-11-12-mobile-file-imports-design.md

## Global Constraints
- New branch from main; commit/push as jcapayne.
- EPUB, ACSM, MD and TXT persist until sent or removed.
- Both platforms; preserve unrelated local edits.

## Review Focus
- Cold and warm launches, temporary provider grants, and incoming files before login.
- Same names never overwrite another queued file.
- Failed send retains bytes; successful send removes only its own entry.
- Partial copies never appear and traversal is rejected.
- iOS extension saves without unsupported app-launch tricks.

### Task 1: Durable queue and Send UI
- [x] Add regression tests for restored files, failed/successful sends and explicit removal; observe failure.
- [x] Implement Rust queue and JS adapter; wire Send and app navigation.
- [x] Run React suite and Rust queue tests.

### Task 2: Android receiving
- [x] Register SEND/SEND_MULTIPLE/VIEW MIME filters.
- [x] Handle cold/warm intent streams off the UI thread; publish atomically and report failures.
- [x] Document Android compilation/device checks; SDK not installed on this host.

### Task 3: iOS receiving
- [x] Register document types and security-scoped Open In copying.
- [x] Add App Group Share extension with file-provider loading, progress and error feedback.
- [x] Update both Xcode source configuration and generated project; typecheck native code.

### Task 4: Verification and delivery
- [x] Run suite, production build and available native compilation; inspect diff.
- [x] Document platform/device checks and limitations.
- [ ] Commit and push feature branch to origin under jcapayne (SSH agent signing currently blocked).

## Verification and review notes

- Frontend: 424 tests passed, production build passed.
- Rust: 22 passed, 1 existing live-network test ignored; iOS target check passed.
- iOS Share extension: typecheck and unsigned Xcode target build passed.
- Independent review: Android restored activities skipped incomplete imports;
  fixed with stable delivery IDs and separate persisted completion receipts.
  Android device/process-death verification remains manual without an SDK.
- Additional regression tests cover remounts during sending and stale list
  responses after removal; both were observed failing before the fixes.
- Native iOS/Android end-to-end checks are documented in
  docs/mobile-file-imports-testing.md and remain unperformed on this host.
