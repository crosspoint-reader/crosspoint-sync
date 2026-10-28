# Micro.blog destination selection and post recreation

## Intent

A Micro.blog token may access several blogs. Let the user choose the blog for
new clipping collections, preserve existing collections where they were first
published, and provide an explicit way to resume publication after deleting a
remote collection post.

## Approaches

- Continue using the account's implicit default blog: rejected because a token
  can access multiple blogs and the user needs to choose a destination.
- Choose a blog per clipping or per book: unnecessary complexity for this request.
- One plugin-wide choice for new collections, with existing collections pinned
  to their original blog: the selected approach. The user also approved an
  explicit **Recreate clipping post** action after remote deletion.

## Agreed behavior

- Title collected clipping posts **📚 Clippings from {book title}**, as requested
  for Micro.blog discovery. Apply this to new and recreated posts and to existing
  collection posts when they are next updated.
- Show **Post clippings to** under the linked Micro.blog plugin. Populate it
  from the token's authenticated Micropub `q=config` destination list.
- Automatically select the sole available blog. When multiple blogs are
  available, require a selection before creating a new collection post.
- Use the selected destination for both manually selected and automatically
  included clippings. Bookshelves and book matching remain account-level.
- Once a book's collection post has been created, persist its destination.
  Additional clippings continue updating that post on its original blog,
  regardless of subsequent changes to the plugin-wide selection.
- Changing the selection never moves, copies, or deletes existing collections.
- If a collection post is deleted on Micro.blog, keep its clippings locally,
  report the missing post, and pause publication for that book. Reader sync and
  other books continue normally. Do not automatically recreate it.
- Offer **Recreate clippings post** for an affected book. Explicit recreation
  offers its previous blog (default) or the current clippings blog. Create one
  replacement collection and pin later updates to the chosen blog. Include its
  eligible saved clippings and any new clippings. This destination choice was
  requested after local testing on October 28.

## Implementation choices

- Send `mp-destination` explicitly on all creation, source lookup, recovery, and
  update requests. Validate it against destinations returned for the token;
  do not rely on Micro.blog's fallback to its default when a destination is invalid.
- Store the original blog alongside each collection's identity and post URL.
  For previously created posts, infer the original destination only from a
  matching available blog URL. If it cannot be identified uniquely, pause that
  collection with an actionable error rather than choose a different blog.
- Pin the destination before the first creation attempt so retries and uncertain
  creation recovery cannot be redirected by a concurrent settings change.
- Recreation requires a confirmed missing post and a currently accessible target
  blog. When the previous blog is accessible, recheck its post; if restored, only
  resume updates there rather than create a duplicate elsewhere. With an existing
  confirmed deletion, allow explicit recreation on the current blog after access
  to the previous blog is revoked. Network and authorization failures during a
  source recheck still stop recreation.
- Keep ordinary **Sync now** and **Add clipping to Micro.blog** from silently
  clearing a missing-post pause. Use the existing action-sheet pattern to explain
  that recreation republishes the collected clippings to the chosen blog. Show
  addresses for both choices; disable the current choice if no available blog is
  selected and show only the previous choice when both destinations are the same.
- Refresh destination choices from the linked token without exposing credentials;
  preserve the saved choice across same-account token rotation when accessible.

## Verification

Test the 📚 title prefix on creation, recreation, and updates. Test selection
among several blogs, sole-blog selection, invalid/revoked
destinations, manual and automatic posting, explicit destination on every request,
changing the choice while creation is in flight, existing collections staying on
their original blog, legacy post identification, same-account token rotation,
remote deletion, explicit recreation, duplicate prevention, and per-user access.
Verify the settings selector and recreation action in frontend tests. Run the
backend and frontend suites and builds before reporting completion.

## Reference

[Micro.blog Micropub destinations and source queries](https://microblog.dev/api/posting/)
