# Micro.blog Destinations and Recreation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select the blog for new clipping collections, keep existing collections on their original blogs, and explicitly recreate deleted posts.

**Architecture:** A focused destination module reads and validates the token's available blogs. Persist each collection's destination independently of the plugin-wide choice, and route every Micropub request explicitly. Extend the existing clippings publication state with confirmed deletion and a guarded recreation operation; reuse the settings and action-sheet patterns.

**Tech Stack:** Existing TypeScript/Hono/SQLite backend, React frontend, Vitest, injected HTTP transport.

**Spec:** `docs/superpowers/specs/2026-10-28-microblog-destinations-design.md`

## Global Constraints

- **Post clippings to** chooses the destination only for new collections.
- Existing collections stay on their original blog, including subsequent clippings and explicit recreation.
- Title collection posts **📚 Clippings from {book title}** on creation, recreation, and next update.
- Require a selection when multiple blogs are available; automatically use the sole available blog.
- Do not move, copy, or delete existing collections when changing the selected blog.
- Never automatically recreate a deleted post or treat a network/authorization failure as confirmed deletion.
- Preserve manual/automatic eligibility, same-account token rotation, merged-book resolution, and per-user isolation.
- Continue in the existing `codex/microblog-clippings` worktree; retain Docker localhost support.

## Review Focus

- Micro.blog silently falls back when an invalid destination is supplied: validate availability before every publication/recreation (Task 1/2).
- Selection changes while a creation request is in flight must not retarget recovery or updates (Task 2).
- Legacy posts may use a custom domain or a blog URL prefix: identify a unique available destination or pause (Task 2).
- Repeated recreation requests must not duplicate a replacement after an uncertain creation response (Task 2).
- A token rotation/default-blog change must preserve collections whose original blog is still accessible (Task 1/2).

### Task 1: Available blogs and validated selection

**Files:** Create `src/connectors/microblog-destinations.ts` and `test/microblog-destinations.test.ts`; modify `src/connectors/microblog.ts`, `src/connectors/store.ts`, `src/routes/v1/connectors.ts`, and relevant Micro.blog transport helpers.

**Interfaces:** Export `type MicroblogDestination = { uid: string; name: string; isDefault: boolean }`, `listMicroblogDestinations(cred: Credential, http: HttpTransport): Promise<MicroblogDestination[]>`, and `selectedMicroblogDestination(db: DB, userId: number): string | null`. Store the plugin choice as `highlight_blog` in account options. Add `GET /api/v1/connectors/microblog/destinations` returning `{ items, selected }` and `PUT /api/v1/connectors/microblog/destination` accepting `{ destination: string }`.

- [ ] Write failing tests for several available blogs with no implicit selection, one available blog automatically chosen, duplicates/malformed configuration, saving an available UID, rejecting an unavailable UID, unlinked accounts, and another user's isolation. Assert selection changes leave existing post rows and snapshots unchanged.
- [ ] Add a failing token-rotation test where the default changes but the original blog remains available: preserve existing publication identity and selections. Validate that client-supplied destination metadata cannot be trusted.
- [ ] Run `npm test -- test/microblog-destinations.test.ts test/microblog.test.ts test/microblog-clippings-api.test.ts`; verify the new behavior fails first.
- [ ] Implement discovery using authenticated `/micropub?q=config`, HTTPS destination UIDs, and server-returned names. Select a sole blog without requiring a settings write. Persist only an explicitly validated choice; expose no token fields. Use the existing credential-entry transport guard for the new settings write.
- [ ] Extend validated credentials with server-discovered available destinations. Update relinking logic so a different default among still-accessible blogs does not wipe original collections. Retain conservative ownership recovery when destination discovery is unavailable; truly different accounts must not inherit another account's URLs.
- [ ] Re-run these tests plus existing connector-link tests; commit the tested task.

### Task 2: Pinned publication destinations, deletion, and recreation

**Files:** Create the next migration after the current sequence; modify `src/connectors/microblog-clippings.ts`, `src/routes/v1/connectors.ts`, and `src/connectors/runner.ts` as needed; extend `test/microblog-clippings-post.test.ts`, `test/microblog-clippings.test.ts`, and `test/microblog-clippings-api.test.ts`.

**Interfaces:** Consume Task 1 discovery and choice functions. Extend `ClippingsPost` with `destination: string | null` and `missing: number`. Export `recreateMicroblogClippings(db: DB, userId: number, document: string, http: HttpTransport): Promise<{ queued: boolean }>`; add `GET /api/v1/connectors/microblog/clipping-posts` returning this user's post status by canonical document, and `POST /api/v1/connectors/microblog/clipping-posts/:document/recreate`.

- [ ] Write failing publication tests for the **📚 Clippings from Test book** title, selected non-default blog on every Micropub request, sole-blog fallback, no creation without a multi-blog choice, changed selection leaving existing posts pinned, an in-flight selection change, and revoked access refusing to publish rather than falling back.
- [ ] Add failing legacy tests using an existing post URL: infer the unique matching available destination, prefer the longest valid blog URL prefix, and pause when no unique destination is provable. Test credential rotation with multiple accessible original destinations.
- [ ] Add failing deletion/recreation tests: a confirmed missing source pauses publication and retains clippings; 401/403/429/5xx do not set `missing`; explicit recreation verifies absence, stays on the original blog, includes saved and new eligible passages, and preserves normal uncertain-creation recovery. Repeated/concurrent requests create at most one replacement; an existing original post resumes updates without creating another.
- [ ] Run `npm test -- test/microblog-clippings-post.test.ts test/microblog-clippings-api.test.ts test/microblog-clippings.test.ts`; confirm new tests fail before implementation.
- [ ] Add destination/deletion state through a new migration. Pin the selected validated UID before the first creation attempt; preserve it through retries, merges, same-account relinks, and recreation. Infer legacy destinations only against the authenticated available list, using URL origin/path boundaries. Read the current state after asynchronous operations and retain account/identity race guards.
- [ ] Route every Micropub request with an explicit URL-encoded `mp-destination` query parameter, including source pagination, single-post lookup, creation, and updates. Revalidate that the pinned blog remains available before requests that could publish. Changing the plugin choice does not change a pinned UID.
- [ ] Distinguish a confirmed deleted post from permission/network errors using the documented source lookup response. Set `missing` only on confirmed absence, retain its old URL and destination, and expose the pause in status. Ordinary sync/manual additions cannot clear it.
- [ ] Implement recreation with account/ownership checks and compare-and-set identity protection after remote verification. For a confirmed missing original, reset creation state to a fresh recovery identity while preserving the pinned blog, selections, and snapshots, then enqueue one collection job. If the old post exists, clear only its pause and resume updates. Block recreation when ownership or deletion cannot be established.
- [ ] Run publication, merge, account-cleanup, and queue tests; commit the tested task.

### Task 3: Settings selector, recreation action, and verification

**Files:** Create `app/src/MicroblogPosting.jsx` and its test; modify `app/src/Settings.jsx`, `app/src/Clippings.jsx`, `app/src/Clippings.test.jsx`, `app/src/api.js`, README, and the legacy Micro.blog settings page in `src/routes/web.ts` if it remains user-accessible.

**Interfaces:** Add `api.microblogDestinations(session)`, `api.setMicroblogDestination(session, uid)`, `api.microblogClippingPosts(session)`, and `api.recreateMicroblogPost(session, document)` for Task 1/2 endpoints. `MicroblogPosting({ session, onChange })` owns destination loading and saving.

- [ ] Write failing UI tests for **Post clippings to**, sole-blog selection, a required choice with multiple blogs, saved-choice restoration, loading/saving errors, unavailable selected blogs, and preventing overlapping saves. Keep **Automatically sync clippings** and its default unchanged.
- [ ] Write failing clipping tests for a per-book **Recreate clipping post** action shown only for missing collections, the confirmation explaining publication on the original blog, cancel without requests, success/refetch, failure feedback, and disabled repeated clicks.
- [ ] Run `npm --prefix app test -- src/MicroblogPosting.test.jsx src/Clippings.test.jsx`; verify the new behaviors fail first.
- [ ] Implement the plugin selector using the existing app form style. Explain that it affects new collections while existing posts stay on their original blog. Include an unavailable saved value rather than silently displaying a different blog; show load/save errors and allow retry.
- [ ] Show the recreation action once per affected book on the clippings hub, with an action sheet confirming that eligible collected clippings will be republished to the original blog. Refresh post status after the request and report queuing without claiming publication is already complete. Wire the API methods and update setup documentation, including the emoji title.
- [ ] Run `npm test`, `npm run build`, `npm --prefix app test`, and `npm --prefix app run build`. Use bundled Node entrypoints if the execution shell lacks npm; report failures by name. Request one independent review of the full change, reproduce important findings with failing tests, and complete one fix pass.
- [ ] Commit the tested result on `codex/microblog-clippings`. Keep the worktree available for local Docker testing and report the new settings/recreation behavior, verification, and material limitations. Do not create real Micro.blog posts or alter the user's running container during development.
