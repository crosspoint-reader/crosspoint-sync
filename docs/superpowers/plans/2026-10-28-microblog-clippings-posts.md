# Micro.blog Clippings Posts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish eligible clippings as one maintained Micro.blog post per book, with reliable catch-up after matching.

**Architecture:** Keep publication intent and remote post state in dedicated tables, independent of queue attempts. A Micro.blog-specific module selects canonical clippings and schedules one coalesced job per book; the connector publishes the latest selected content via Micropub. Extend the current settings UI and clippings hub without changing other connectors' highlight behavior.

**Tech Stack:** TypeScript, Hono, SQLite, Vitest, React, existing HTTP transport.

**Spec:** `docs/superpowers/specs/2026-10-28-microblog-clippings-post-design.md`

## Global Constraints

- **Automatically sync highlights**, disabled by default.
- A missing book match never blocks reader sync or creates a book solely to publish clippings.
- Manual selection works with automatic publication disabled.
- Do not delete remote posts on unlink or local clipping deletion.
- Do not blindly retry a creation with an ambiguous outcome.
- Leave unrelated work untouched; use an isolated worktree for implementation.

## Review Focus

- Failed creation after remote acceptance must recover the original post rather than duplicate it (Task 2).
- Disabling automatic publication must preserve already published content and manual selections (Tasks 1–2).
- Alias merges must preserve selections and avoid a second post (Tasks 1–2).
- An unchanged device sync after a manual match must publish earlier eligible clippings (Task 3).
- Unlinked, disabled, or another user's account must never publish a requested clipping (Task 3).

### Task 1: Durable selection and post state

**Files:** New migration after the current migration sequence; new `src/connectors/microblog-clippings.ts`; modify `src/models/merge.ts`; new `test/microblog-clippings.test.ts`.

**Interfaces:** Produce `selectMicroblogClipping(db: DB, userId: number, document: string, clippingId: string): void`, `scheduleMicroblogClippings(db: DB, userId: number, document?: string): number`, and `microblogClippingsContent(db: DB, userId: number, document: string, bookUrl: string): { title: string; content: string; fingerprint: string } | null`.

- [ ] Write failing tests: manual selection includes only the requested live clipping; automatic selection includes all existing live clippings; stable reading order produces an unchanged fingerprint; disabling automatic publication retains previously published passages; alias selection resolves to the canonical book; users cannot share state.
- [ ] Run `npm test -- test/microblog-clippings.test.ts`; confirm failures are missing behavior.
- [ ] Add selection rows with manual/automatic intent and published content snapshots; add per-book remote URL, fingerprint, and creation-attempt/recovery state. Use existing database migration and transaction patterns. Schedule only enabled accounts, eligible content, and usable existing matches; coalesce with `microblog:clippings` as the queue key and `highlight` as the event kind.
- [ ] Implement the interfaces above using the merged clipping view. Render **Highlights from {book title}**, the matched book link, quoted passages, notes, and chapters; escape user text appropriately. Carry selections/state through document merges. If both merged documents already have remote posts, retain one authoritative URL and surface the conflict without deleting either post.
- [ ] Re-run the new tests plus existing merge tests; commit the tested deliverable.

### Task 2: Micropub creation, updates, and recovery

**Files:** Modify `src/connectors/microblog.ts`, `src/connectors/runner.ts`; add publication functions to `src/connectors/microblog-clippings.ts`; extend `test/microblog-helpers.ts`; add `test/microblog-clippings-post.test.ts`.

**Interfaces:** Consume Task 1's content function. Produce `publishMicroblogClippings(cred: Credential, match: Match, event: OutboundEvent, http: HttpTransport, ctx: ConnectorContext): Promise<PushResult>`; dispatch Micro.blog highlight jobs to it before shelf reconciliation.

- [ ] Write failing transport tests for first creation returning `Location`, subsequent JSON Micropub update to the saved URL, no request for an unchanged fingerprint, and no shelf operations for highlight jobs.
- [ ] Add failing tests for 401/403 reauthentication, retryable 429/5xx, malformed or absent creation responses, ambiguous network completion, paginated source recovery finding a unique owned post, ambiguous recovery requiring attention, and a missing saved post requiring attention rather than recreation. Verify automatic-off updates retain snapshots of published passages.
- [ ] Run `npm test -- test/microblog-clippings-post.test.ts`; verify expected failures.
- [ ] Implement JSON Micropub requests without the current form-only helper overriding content type. Persist the creation URL before marking success. Save a stable recovery identity before creation, query the account's Micropub source with pagination after uncertain outcomes, and adopt only one unambiguously identified result; otherwise fail with an actionable message and do not create again.
- [ ] Guard `shouldPush` so highlight events do not inherit percentage filtering. In the runner, Micro.blog highlights require an existing match and never invoke `createBook`; preserve other connectors' lifecycle behavior. Resolve ISBN/book-page identity from verified book metadata or the shelf inventory instead of assuming an internal shelf ID is an ISBN.
- [ ] Run new tests and existing Micro.blog unit/integration tests; commit the tested deliverable.

### Task 3: Settings, manual API, and catch-up triggers

**Files:** Modify `src/routes/v1/connectors.ts`, `src/routes/v1/clippings.ts`, `src/connectors/fanout.ts`, `src/connectors/microblog.ts`, and the shared progress refresh entry point `src/connectors/refresh.ts`; extend backend integration tests.

**Interfaces:** Add `POST /api/v1/connectors/microblog/clippings/:document/:clippingId`, returning `{ queued: boolean, waiting_for_match: boolean }`. Consume Task 1's selection and scheduling functions. Add connector toggle `sync_highlights`, label **Automatically sync highlights**, default `false`.

- [ ] Write failing endpoint tests for authenticated manual selection, missing/deleted clipping, cross-user requests, unlinked/disabled accounts, and idempotent repeated requests. Assert disabled automatic sync still allows manual publication intent.
- [ ] Write failing catch-up tests: select or automatically include clippings while unmatched, manually match the book, perform an unchanged device progress GET or clipping sync, drain the queue, and observe one collected post. Cover legacy and v1 progress paths, plugin **Sync now**, enabling/disabling the option, and zero shelf creation for unmatched highlights.
- [ ] Run the new integration tests and confirm expected failures.
- [ ] Register the default-off option; schedule automatic selection on clipping sync and option enable. Schedule eligible book jobs on shared progress refresh, clipping sync, and plugin backfill, even without changed clippings. Persist unmatched intent without dead-letter churn. Bypass generic per-clipping fanout/backfill for Micro.blog so the single per-book job is authoritative.
- [ ] Implement the manual endpoint with canonical resolution, ownership checks, configured/enabled-account checks, and durable selection before scheduling. On unlink, clear local publication credentials/state according to the existing unlink lifecycle while leaving remote posts intact; ensure a replacement account cannot inherit an old account's remote post URL.
- [ ] Run backend integration and existing connector/queue tests; commit the tested deliverable.

### Task 4: Clippings action and final verification

**Files:** Modify `app/src/Clippings.jsx`, `app/src/api.js`; add `app/src/Clippings.test.jsx`; update Micro.blog help copy where appropriate.

**Interfaces:** Add `api.addMicroblogHighlight(session, document, clippingId)` calling Task 3's endpoint. Use existing connector listing and settings rendering.

- [ ] Write failing UI tests for an action shown only with configured Micro.blog, selecting an individual clipping, waiting-for-match feedback, request failure feedback, and preventing repeated clicks while a request is pending.
- [ ] Run `npm --prefix app test -- src/Clippings.test.jsx`; confirm expected failures.
- [ ] Add **Add highlight to Micro.blog** to clipping cards, including the daily clipping. Explain successful scheduling or waiting for a book match without claiming the post was already published. Display that the optional sync publishes a managed post per book; preserve existing share/delete behavior.
- [ ] Run the UI tests, `npm test`, `npm run build`, `npm --prefix app test`, and `npm --prefix app run build`. Report any failures by name. Check the complete diff and obtain an independent code review; address verified findings with regression tests.
- [ ] Commit the tested implementation and report changed behavior, checks, and any remaining limitations. Do not publish real posts during development or deploy without a user request.
