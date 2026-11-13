# Font and sleep-screen imports

Goal: Extend the existing persistent mobile imports to main's font and sleep-screen flows.
Architecture: shared extension classification and tab routing; native producers retain the same atomic queue; category-specific actions reuse font conversion/upload and the image editor.
Spec: docs/superpowers/specs/2026-11-12-mobile-file-imports-design.md

- [x] Merge upstream main, preserving queue behavior and local Xcode edits.
- [x] Classify supported types and route category batches, including guest mode.
- [x] Add native Android/iOS file registration and queue validation.
- [x] Add shared-asset queue UI; font upload and image editor handoff retain originals until sent/removed.
- [x] Verify category filtering, correct endpoints, failed-send retention, edit retention and successful cleanup.
- [x] Run frontend/Rust tests, production build and available native checks.
- [ ] Review, commit and push as jcapayne.

Review fixes: explicitly activate CPFONT-only iOS providers (native predicate
RED→GREEN); group font faces and avoid synthesizing Regular for raw Bold/Italic
uploads (regression RED→GREEN); require Regular before whole-family conversion.
Duplicate copies of a style remain queued independently. An image preview is
detached when its original is explicitly removed.

Verification: 466 frontend tests, 1108 server tests and 22 Rust tests passed
(one pre-existing Rust live-network test ignored). Production frontend build,
iOS Rust check, Share extension build and native activation checks passed.
Android compilation/device testing remains unavailable without an SDK.
