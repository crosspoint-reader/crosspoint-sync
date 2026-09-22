# Design: Sync Hub & Connector Framework

Status: **draft / not implemented** — architectural direction, not a commitment to ship every
connector below. Read the feasibility tiers before scoping anything.

## Idea

A crosspoint-sync account becomes a **master sync identity**. Reading state (progress, finished
status, and later ratings/clippings) is captured once — from any device over kosync — and
fanned out to whichever external services the user has *paired*: Hardcover, Goodreads,
StoryGraph, etc. All pairing and forwarding happens server-side, so there are
**no firmware changes** for any of it.

[hardcover-sync.md](hardcover-sync.md) is the reference connector; this doc generalizes that
pattern to N connectors and defines what's actually buildable.

## The hub, conceptually

```
                         crosspoint-sync account (master identity)
                                        |
        +------------------+------------+------------+------------------+
        |                  |                         |                  |
   device sync        Hardcover                 Goodreads          StoryGraph / ...
   (kosync, canonical)  connector                connector          connector
        |                  |                         |                  |
   progress/stats  <--- sync graph: canonical store + per-connector adapters --->
```

- **Canonical store** = the tables we already have (`progress`, `documents`, stats, bookmarks,
  clippings). This is the source of truth and the lowest common denominator.
- **Connectors** are adapters. Each declares: which credential type it needs, whether it's
  read/write/bidirectional, how it matches our document hash to its own book identity, and how it
  maps our state to its state.
- **Fan-out** is triggered by a change to the canonical store (a progress PUT). **Fan-in**
  (bidirectional connectors pushing external changes back into the canonical store) is a poll or
  webhook per connector — only some connectors can do it.

## Connector interface (shared shape)

Every connector, regardless of service, is one module implementing:

```ts
interface Connector {
  id: string;                                   // 'hardcover' | 'goodreads' | ...
  capabilities: { read: boolean; write: boolean };   // fan-in / fan-out support
  credentialKind: 'oauth' | 'token' | 'cookies';     // never 'password' — see auth models
  validate(cred): Promise<{ ok: boolean; account?: string }>;
  match(doc: DocumentMeta): Promise<Match | null>;    // hash -> external book id
  pushProgress(cred, match, ev): Promise<void>;       // fan-out (write connectors)
  pullChanges?(cred, since): Promise<CanonicalEvent[]>; // fan-in (read connectors)
}
```

This reuses the Hardcover design's three-part structure (token vault, match table, retry queue)
for all connectors. Adding a service = adding one module + one row in a connector registry; the
hub, queue, matcher-runner, and web UI are written once. Matching is **always server-side**, using
the title/author/filename metadata the devices already send (see hardcover-sync.md — the same
"why server-side" reasoning applies universally).

Shared tables generalize the Hardcover ones: `connector_accounts(user_id, connector_id,
cred_enc, enabled, ...)`, `connector_matches(user_id, connector_id, document, external_id,
confidence, source, ...)`, `connector_queue(...)`. One schema, keyed by `connector_id`.

## Auth models — the key insight: cookie-replay ≠ storing passwords

The connector landscape is uneven, but the dividing line is **auth mechanism**, not "has an API."
Three models, best to worst posture:

1. **Scoped token / OAuth (Tier 1).** Service issues a per-user token with the user's consent.
   Revocable, sometimes scopeable. Best case. (Hardcover.)
2. **Cookie-replay (Tier 2).** User is already logged in on the service in their browser; they
   paste their session cookies (or a browser extension harvests just those cookies). The connector
   replays them against the service's own **web endpoints**. **The server never sees the
   password.** Because the cookie is captured *post-login*, this also sidesteps 2FA/CAPTCHA
   entirely. This is the standard modern pattern — it's how Readwise's Amazon sync works
   ("Readwise couldn't access your Amazon password even if we wanted to"). The tradeoff isn't
   credential exposure — it's that session cookies are unscopeable full-session secrets, expire and
   need re-pasting, and depend on undocumented web endpoints that can change.
3. **Stored password / headless login (avoid).** Server holds the actual username+password and
   drives a login. Highest risk; breaks on 2FA. **We do not build this for any connector.**

Cookie-replay is what makes Goodreads/StoryGraph viable at all now — and viable *without*
holding anyone's password. It's still ToS-gray and brittle, so those connectors ship behind an
explicit "experimental, may break, unofficial" opt-in — but "we store your password" was never
the actual requirement, and I was wrong to frame it that way earlier.

### Prefer the aggregator hop over direct scraping

When a **sanctioned aggregator already ingests a hard target**, route through it instead of
scraping the target ourselves. The prime example: **Readwise** already pulls e-reader highlights
via its own browser extension (the ToS-gray work is *their* responsibility, done with the user's
explicit install), and exposes them through an official token API. A Readwise connector (Tier 1,
no scraping) beats a direct cookie-replay connector (Tier 3, TLS-fingerprint fight). Always ask
"is there a legit API that already has this data?" before building a scraper.

## Feasibility tiers — READ THIS BEFORE SCOPING

### Tier 1 — Sanctioned public API. Buildable, durable.

- **Hardcover** — public GraphQL API (beta), per-user bearer tokens. Write + partial read.
  Carries *progress + shelves + rating*. See hardcover-sync.md. **Ship first.**
- **Readwise** — official REST API, per-user access token (`Authorization: Token <t>`, issued at
  readwise.io/access_token). Carries *highlights/notes only* — no reading progress or shelves.
  **Bidirectional and the safest connector we have**, because it's a fully sanctioned token API
  (no cookies, no scraping, user-revocable). Two high-value uses:
  - **Fan-out:** push CrossInk clippings into Readwise (`POST /api/v2/highlights/`, batched) — from
    there they flow to the user's whole highlight ecosystem (Notion, Obsidian, Readwise reviews).
    This is the cleanest way to make on-device highlights useful anywhere.
  - **Fan-in / "Readwise as the hop":** pull highlights *out* of Readwise
    (`GET /api/v2/export/?updatedAfter=`) into our canonical clippings store. Since Readwise's own
    browser extension already ingests e-reader (and Apple Books, Instapaper, …) highlights the
    sanctioned way, this gets us those highlights **without us ever scraping the sources** — we
    let Readwise do that work and read from their clean API.

  Caveats: highlights-only, requires a paid Readwise subscription, and create/export endpoints are
  rate-limited (~20 req/min — batch accordingly). Book identity in Readwise is title/author, which
  matches our metadata model. Verify the exact v2 schema at implementation (same gate as Hardcover).

### Tier 2 — No official API, but cookie-replay works. Experimental, no passwords stored.

- **Goodreads** — API keys dead since **Dec 2020**. The well-known Calibre "Goodreads Sync" plugin
  still works only because it ships the author's own *grandfathered* OAuth key, shared across its
  whole userbase — **we can't and shouldn't reuse that** (a new app can't register a key; borrowing
  theirs invites revocation + ToS violation). The viable path for us is **cookie-replay against the
  Goodreads web endpoints** (`_session_id2` session cookie + Rails `authenticity_token` CSRF
  scraped from page HTML). This can *write*: shelve, rate, set read date, and update reading
  progress. See "Goodreads write-path" below.
- **StoryGraph** — no public API, but cookie-replay is proven: the `storygraph.koplugin` KOReader
  plugin already writes progress %, status, and auto-marks Read using two cookies
  (`_story_graph_session` + `remember_user_token`) + CSRF. **Note the competitive context: Kobo
  shipped *native* StoryGraph sync in June 2026** — so StoryGraph is where the e-reader crowd is
  heading, which raises the value of us having it and lowers the novelty of Goodreads.

  Verdict: both buildable via cookie-replay with no password storage. Gate behind an explicit
  experimental opt-in; expect breakage on site changes and cookie expiry. Prefer official APIs if
  they ever appear (StoryGraph has discussed one).

### Tier 3 — Cookie-replay possible, but higher blast radius / harder. Spike, don't commit.

No current targets.

## What this means for the build

1. **Build the hub + connector framework** (generalized tables, registry, queue worker, matcher
   runner, web-UI pairing screen). Durable regardless of which connectors follow.
2. **Ship Hardcover + Readwise** as the first Tier-1 connectors (token APIs, no extension needed).
3. **Build the browser extension** — the decided, shared credential-capture path for every
   cookie-based connector; generalize `extension/` for Tier 2 connectors.
4. **Gate Tier 2** (Goodreads/StoryGraph, via the extension) behind an explicit experimental opt-in
   if there's demand; expect maintenance cost and breakage. Revisit if official APIs appear.

## Cookie-replay mechanics (Tier 2/3)

Shared shape for every cookie-replay connector:

1. **Credential capture — via a first-party browser extension (decided).** The extension is the
   committed capture path for all cookie-based connectors: the user logs into the service in their
   own browser, and the extension harvests *only* the specific cookie names below and POSTs them to
   us. This is strictly better than paste-the-cookie (no DevTools spelunking, no accidental
   over-sharing, matches Readwise's proven UX) and never touches the login page or password.
   Manual cookie paste stays as a no-extension fallback only. We store the harvested bundle
   encrypted, treated as password-equivalent. Cookie sets per service:
    - Goodreads: `_session_id2` (+ `ccsid`)
    - StoryGraph: `_story_graph_session` + `remember_user_token`
2. **CSRF handshake (Rails sites: Goodreads, StoryGraph).** Before any write, GET an authenticated
   HTML page, scrape `<meta name="csrf-token">` (or the hidden `authenticity_token` input), and
   send it as `X-CSRF-Token` (AJAX) or an `authenticity_token` form field (form POST), alongside
   the session cookie.
3. **Write** to the service's web endpoint (below).
4. **Expiry handling.** On a redirect-to-login / 401 / signup-page-HTML response, mark the
   connector `needs_reauth` and surface it in the status endpoint — never retry-loop a dead
   session. Goodreads/StoryGraph session cookies are relatively short-lived.

### Goodreads write-path reference

We can't use the Goodreads API (dead keys), but the **field names** from the still-maintained
Calibre "Goodreads Sync" plugin (`kiwidude68/calibre_plugins → goodreads_sync/core.py`) are the
best-documented reference, because Goodreads' web forms and its old API share parameter naming.
Capture the *current* web/AJAX paths from DevTools while shelving/rating/updating on goodreads.com,
then map onto these known field shapes:

| Operation | Params (urlencoded) |
|---|---|
| Add/remove shelf | `name=<shelf>`, `book_id=<gr_id>` (+ `a=remove`) |
| Rating + read date | `review[rating]`, `review[read_at]=YYYY-MM-DD`, `review[review]` |
| Reading progress | `user_status[book_id]`, `user_status[percent]` (or `[page]`), `user_status[body]` |

Book matching is title/author search (server-side, as everywhere in this doc): Goodreads
`/search/search.xml`-style query, or ISBN if ever available. **Caveat:** the `user_status` progress
update is historically the flakiest Goodreads endpoint (intermittent 401s, "success but no visible
change") — treat progress as best-effort and rely on shelf + read-date as the durable signal.

StoryGraph writes follow the same GET-CSRF-then-POST shape; `storygraph.koplugin` is the reference
for the current status/progress endpoints.

## Bidirectional sync (fan-in) notes

Only connectors with a read capability can push external changes back. The merge rule extends the
existing kosync "newest wins across devices" to "newest wins across sources" — every canonical
event carries a source and timestamp; the hub applies the most recent and re-fans-out to the
others, with loop suppression (don't echo a change back to the source that produced it). This is
straightforward for Tier 1 and mostly irrelevant for Tier 2/3, which are write-mostly or
unavailable.

## Security posture (applies to all connectors)

- **We never store passwords.** Tier 2/3 use cookie-replay: the server holds session cookies, not
  credentials, and never sees the plaintext password (nor 2FA, since cookies are post-login).
- All external credentials (tokens and cookie bundles) encrypted at rest (`AES-256-GCM`, key from
  `TOKEN_ENC_KEY`); connector disabled if the key is unset (self-host default). Never logged,
  redacted in errors.
- **Cookie bundles are unscopeable full-session secrets** — treat them as sensitive as passwords
  even though they aren't passwords: minimal retention, encrypt, and lean on the user's natural
  revocation levers (password change / "log out everywhere" invalidates them). A leaked Amazon
  cookie is higher blast radius than a Goodreads one; that's the extra weight on Tier 3.
- **The browser extension is the decided capture model** for cookie connectors (harvest only the
  named cookies, like Readwise) — strictly better privacy than paste-the-cookie and than ever
  touching the login page. Paste-cookie is the no-extension fallback. The extension is a shared
  dependency of every Tier 2/3 connector, so it's the first thing to build before any of them ship.
- Outbound requests restricted to each connector's known hosts (no user-supplied URLs; no SSRF).

## Open questions

- Web UI is a hard prerequisite for pairing anything (OAuth redirects, token paste) — this is the
  forcing function that makes the web UI real. Sequence accordingly.
- Per-connector completion/rating mapping differs (star scales, half-stars, DNF states) — define a
  canonical rating model once, adapt per connector.
- Do we expose the master account as its own login (email/password/OAuth) distinct from the kosync
  credential, so a user can manage pairings without device credentials? Likely yes, once the web
  UI exists.
