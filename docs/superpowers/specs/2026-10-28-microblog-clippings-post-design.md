# Micro.blog clippings posts

## Intent and scope

Let readers publish selected clippings to Micro.blog, or opt into automatic
publication, with one collected post per book. Each post links to the matched
book's Micro.blog page. This replaces the original bookmark-highlights proposal.
Existing reading-progress and bookshelf behavior continues independently.

## Approaches

- Bookmark highlights: originally requested, but requires offsets into archived
  bookmark content and does not fit clippings from an ebook.
- A separate post per clipping: straightforward, but automatic sync would create
  many posts for the same book.
- One post per book, updated as clippings arrive: selected by the user. Retains
  a single shareable collection and avoids repeated publication per clipping.

## Behavior

- When Micro.blog is configured, each clipping on the clippings page offers
  **Add highlight to Micro.blog**. It selects only that clipping for publication
  and schedules creation or updating of the book's collected post.
- The plugin offers **Automatically sync highlights**, disabled by default.
  Enabling it makes existing and future live clippings eligible for publication.
- A missing book match never blocks reader sync or creates a book solely to
  publish clippings. Persist publication intent even while unmatched. Once a
  match is available, the next device sync or plugin **Sync now** includes
  eligible existing clippings, even when they were not changed on that sync.
- Manual selection works with automatic publication disabled. Disabling the
  automatic option stops automatic additions; explicitly selected clippings
  remain eligible. Already published content is retained.
- Successful unchanged syncs do not create posts or rewrite existing posts.
  Normal transient failures are retried using the connector queue.

## Implementation choices

These details are proposed defaults for implementation:

- Publish a normal blog post through Micro.blog's Micropub endpoint, using the
  existing plugin credential. Save its returned URL and update that same URL.
- Title the post **Highlights from {book title}**. Include a book link, followed
  by eligible passages as quotations with their notes and chapter labels.
  Use a stable reading order so unchanged content has a stable fingerprint.
- Persist per-clipping publication intent separately from queue attempts, and
  persist the post URL and last successful content fingerprint per user/book.
  Resolve document aliases using the existing merge model.
- Use a per-book queue key so multiple new clippings coalesce into one update.
  Read current eligible clippings when processing the job rather than publishing
  an obsolete snapshot. Preserve selected content when automatic sync is disabled.
- Treat the collected post as managed by crosspoint-sync: later syncs replace its
  generated body. Do not delete remote posts on unlink or local clipping deletion.
- Do not blindly retry a creation with an ambiguous outcome: recover the existing
  post through Micropub source lookup before allowing another creation. If a saved
  post is missing or cannot be recovered, surface an actionable error instead of
  silently creating a duplicate.

## Verification

Cover default-off behavior, manual selection, automatic backfill, unmatched books,
manual matching followed by an otherwise unchanged sync, one post per book,
unchanged-content deduplication, updates, retry/recovery, per-user isolation, and
canonical document aliases. Run relevant backend tests, the backend build, and
frontend checks available in this repository.

## References

- [Micro.blog Micropub creation and updates](https://microblog.dev/api/posting/)
- [Micro.blog Micropub guide](https://book.micro.blog/micropub/)
