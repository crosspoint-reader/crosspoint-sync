import { useEffect, useState } from 'react'
import { ArrowLeft, BookOpen, ChevronRight, Download, Loader2, Pencil, Plus, Search, Send as SendIcon, Server, Trash2 } from 'lucide-react'
import { isApp } from './api.js'
import { loadDevicePrefs } from './device.js'
import { download, feed as fetchFeed, loadCatalogs, navRows, readable, saveCatalogs, search, sendDownload } from './catalogs.js'
import { progressLabel } from './Send.jsx'
import { Card, Eyebrow, Spinner } from './ui.jsx'

// Hash routes:
//   #/browse                         storefront: a block of rails per catalog
//   #/browse/search/<query>          search every catalog
//   #/browse/manage                  add / edit catalogs
//   #/browse/<catalog>               a catalog's root feed
//   #/browse/<catalog>/f/<feed url>  any feed in it
//   #/browse/<catalog>/s/<query>     search one catalog
//   #/browse/<catalog>/b/<entry id>  a book's publication page
const href = (cat, kind, value) => `#/browse/${cat.id}${kind ? `/${kind}/${encodeURIComponent(value)}` : ''}`
// Catalogs often list authors as "Last, First".
const person = (n) => (/^[^,]+, [^,]+$/.test(n) ? n.split(', ').reverse().join(' ') : n)
// Descriptions arrive as plain text, escaped HTML or tidied XHTML; keep paragraph breaks either way.
const text = (html) =>
  html
    ? new DOMParser()
        .parseFromString(html.replace(/<\/(p|div|li|h\d)>|<br\s*\/?>/gi, '$&\n\n'), 'text/html')
        .body.textContent.replace(/\n{3,}/g, '\n\n')
        .trim()
    : ''
// Facts the page already shows elsewhere (title, authors, tags, language).
const SHOWN = new Set(['Title', 'Author', 'Authors', 'Subject', 'Subjects', 'Language', 'EBook No.', 'Category', 'LoCC'])
// Split a description into prose and "Label: value" facts (Gutenberg-style metadata blocks).
function describe(raw) {
  const about = []
  const details = []
  let summary = null
  for (const p of text(raw).split(/\n{2,}/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^([A-Z][A-Za-z .]{1,24}):\s+([\s\S]+)$/.exec(p)
    if (!m) about.push(p)
    else if (m[1] === 'Summary' || m[1] === 'Description') summary = m[2]
    else if (!SHOWN.has(m[1])) details.push([m[1], m[2]])
  }
  // With a real summary, loose lines ("This edition had all images removed.") are notes.
  if (summary) return { about: [summary], details: [...about.map((a) => ['Note', a]), ...details] }
  return { about, details }
}
const input =
  'h-12 w-full rounded-xl bg-white px-4 text-base text-stone-900 ring-1 ring-stone-950/10 outline-none placeholder:text-stone-400 focus:ring-2 focus:ring-brand-500/60'
const MAX_RAILS = 6

// Entries opened from a list, by id, so the book page can render without refetching.
// ponytail: in-memory only; after an app restart a book URL falls back to "go back".
const opened = new Map()
const openBook = (cat) => (entry) => {
  const key = entry.id || entry.title
  opened.set(key, entry)
  location.hash = href(cat, 'b', key)
}

function TopBar({ back, label }) {
  // Same 44px row as the account avatar so they line up (see Book.jsx).
  return (
    <div className="flex h-11 items-center pr-12 md:pr-0">
      <a
        href={back}
        onClick={(e) => {
          if (back === 'history') {
            e.preventDefault()
            history.back()
          }
        }}
        className="-ml-2 flex h-11 items-center gap-1.5 rounded-full pr-4 pl-2 text-lg font-semibold text-brand-600 transition active:bg-stone-200/70 md:hover:bg-stone-100"
      >
        <ArrowLeft className="size-6" strokeWidth={2} /> {label}
      </a>
    </div>
  )
}

function Cover({ entry, large = false, className = '' }) {
  const [broken, setBroken] = useState(false)
  const src = large ? (entry.cover ?? entry.thumbnail) : (entry.thumbnail ?? entry.cover)
  const frame = `aspect-[2/3] overflow-hidden rounded-md shadow-sm ring-1 ring-stone-950/10 ${className}`
  if (src && !broken) return <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} className={`${frame} block h-auto max-w-full object-cover`} />
  return (
    <div className={`${frame} flex flex-col justify-between bg-[#f5f4ef] p-2`}>
      <p className="line-clamp-4 font-display text-xs/tight font-semibold text-stone-800">{entry.title}</p>
      <p className="line-clamp-2 text-[0.6rem]/tight text-stone-500">{entry.authors.map(person)[0]}</p>
    </div>
  )
}

// block + w-full: a button otherwise sizes to its content, and a wide cover image blows out its slot.
function Tile({ entry, onOpen }) {
  return (
    <button onClick={() => onOpen(entry)} className="group block w-full min-w-0 text-left">
      <Cover entry={entry} className="w-full transition group-active:scale-[0.98] md:group-hover:-translate-y-0.5 md:group-hover:shadow-md" />
      <p className="mt-2 line-clamp-2 text-sm/5 font-semibold text-stone-900">{entry.title}</p>
      <p className="truncate text-xs text-stone-500">{entry.authors.map(person).join(', ')}</p>
    </button>
  )
}

function Grid({ entries, onOpen }) {
  return (
    <div className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-4 md:gap-x-5 lg:grid-cols-5 xl:grid-cols-6">
      {entries.map((e, i) => (
        <Tile key={`${e.id}-${i}`} entry={e} onOpen={onOpen} />
      ))}
    </div>
  )
}

// Horizontal, swipeable row that snaps to items; bleeds to the screen edge.
function Rail({ title, more, children }) {
  return (
    <section className="mt-7">
      <div className="flex items-baseline justify-between gap-4">
        <h3 className="min-w-0 truncate font-display text-xl font-semibold text-stone-900">{title}</h3>
        {more && (
          <a href={more} className="shrink-0 text-sm font-semibold text-brand-600">
            See all
          </a>
        )}
      </div>
      <div className="-mx-4 mt-3 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-2 [scrollbar-width:none] md:-mx-8 md:scroll-px-8 md:gap-4 md:px-8 lg:-mx-12 lg:scroll-px-12 lg:px-12">
        {children}
      </div>
    </section>
  )
}

const railItem = 'w-28 shrink-0 snap-start sm:w-32 md:w-36'

function CoverRail({ title, more, entries, onOpen }) {
  return (
    <Rail title={title} more={more}>
      {entries.map((e, i) => (
        <div key={`${e.id}-${i}`} className={railItem}>
          <Tile entry={e} onOpen={onOpen} />
        </div>
      ))}
    </Rail>
  )
}

function SkeletonRail({ title }) {
  return (
    <Rail title={title}>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className={railItem}>
          <div className="aspect-[2/3] animate-pulse rounded-md bg-stone-200" />
          <div className="mt-2 h-3 w-3/4 animate-pulse rounded bg-stone-200" />
        </div>
      ))}
    </Rail>
  )
}

// The catalog's own page for this book, when the list entry only summarises it:
// Gutenberg's per-book feed (no downloads in lists), an OPDS 1 "complete entry",
// or an OPDS 2 publication document.
function detailLink(entry) {
  return entry.navigation.find((l) => {
    const m = l.mime ?? ''
    if (l.rel === 'related') return false
    if (m.includes('type=entry') || m.includes('opds-publication')) return true
    return entry.acquisitions.length === 0 && (l.rel === 'subsection' || m.includes('opds-catalog'))
  })
}

// Publication page: common-stacks' Book screen, in this app's layout.
function BookPage({ cat, entryKey }) {
  const [entry, setEntry] = useState(() => opened.get(entryKey))
  const [resolving, setResolving] = useState(false)
  const [format, setFormat] = useState(null)
  const [job, setJob] = useState(null) // { state, progress, error, sent }

  useEffect(() => {
    const listed = opened.get(entryKey)
    const detail = listed && detailLink(listed)
    if (!detail) return
    let live = true
    setResolving(true)
    fetchFeed(cat, detail.href)
      .then((f) => {
        if (!live || !f.entries.length) return
        // Gutenberg splits one book into variants (with / without images); offer all their formats.
        const [main, ...rest] = f.entries
        const acquisitions = [...listed.acquisitions, ...main.acquisitions, ...rest.flatMap((e) => e.acquisitions)].filter(
          (a, i, all) => all.findIndex((b) => b.href === a.href) === i
        )
        const longer = (a, b) => ((a ?? '').length >= (b ?? '').length ? a : b)
        setEntry({
          ...listed,
          ...main,
          acquisitions,
          summary: longer(main.summary, listed.summary),
          authors: main.authors.length ? main.authors : listed.authors,
          cover: main.cover ?? listed.cover,
          thumbnail: listed.thumbnail ?? main.thumbnail,
          navigation: [...main.navigation, ...listed.navigation],
        })
      })
      .catch(() => {})
      .finally(() => live && setResolving(false))
    return () => {
      live = false
    }
  }, [cat, entryKey])

  if (!entry) {
    return (
      <div className="px-4 pt-4 md:px-8 md:pt-6 lg:px-12">
        <TopBar back={href(cat)} label={cat.name} />
        <p className="py-16 text-center text-sm text-stone-500">Open this book again from the catalog.</p>
      </div>
    )
  }

  const formats = readable(entry)
  const chosen = formats.find((f) => f.href === format?.href) ?? formats[0]
  async function run(alsoSend) {
    setJob({ state: 'working', progress: null })
    try {
      const book = await download(cat, entry, chosen, (progress) => setJob((j) => ({ ...j, progress })))
      if (alsoSend) await sendDownload(book.name, loadDevicePrefs(), (progress) => setJob((j) => ({ ...j, progress })))
      setJob({ state: 'done', sent: alsoSend })
    } catch (e) {
      setJob({ state: 'error', error: String(e) })
    }
  }

  const { about, details } = describe(entry.summary)
  // "More like this": same author / subject feeds the catalog links from the entry.
  const related = entry.navigation.filter((l, i, all) => l.rel === 'related' && l.title && all.findIndex((x) => x.href === l.href) === i).slice(0, 8)
  const facts = [entry.published?.slice(0, 4), entry.language?.toUpperCase(), cat.name].filter(Boolean)

  return (
    <div className="px-4 pt-4 pb-8 md:px-8 md:pt-6 lg:px-12">
      <TopBar back="history" label="Back" />
      <div className="mt-3 md:grid md:grid-cols-[15rem_1fr] md:items-start md:gap-10 lg:grid-cols-[18rem_1fr] lg:gap-14">
        <aside className="md:sticky md:top-8">
          <Cover entry={entry} large className="mx-auto w-44 shadow-lg md:w-full" />
        </aside>

        <div className="@container mt-6 md:mt-0 md:max-w-2xl">
          <h1 className="text-center font-display text-3xl/tight font-semibold tracking-tight text-balance text-stone-900 md:text-left md:text-4xl/tight">{entry.title}</h1>
          <p className="mt-2 text-center text-base text-stone-600 md:text-left">{entry.authors.map(person).join(', ')}</p>
          {entry.series && <p className="mt-1 text-center text-sm text-stone-500 md:text-left">{entry.series}</p>}
          <p className="mt-3 text-center font-mono text-xs text-stone-400 md:text-left">{facts.join(' · ')}</p>

          {resolving && !formats.length ? (
            <Spinner />
          ) : formats.length === 0 ? (
            <Card className="mt-6 p-4 text-sm/6 text-stone-600">
              This catalog doesn&apos;t offer this book as EPUB, Markdown or text, which is what your reader opens.
            </Card>
          ) : (
            <div className="mt-6">
              {formats.length > 1 && (
                <div className="mb-4 flex flex-wrap justify-center gap-2 md:justify-start">
                  {formats.map((f) => (
                    <button
                      key={f.href}
                      onClick={() => setFormat(f)}
                      className={`rounded-full px-3 py-1.5 text-xs font-semibold ${f.href === chosen?.href ? 'bg-brand-500 text-white' : 'bg-white text-stone-600 ring-1 ring-stone-950/10'}`}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              )}
              {/* Side by side only when this column (not the screen) has room for both labels. */}
              <div className="grid gap-2 @lg:grid-cols-2">
                <button
                  disabled={job?.state === 'working'}
                  onClick={() => run(true)}
                  className="flex h-14 min-w-0 items-center justify-center gap-2 rounded-2xl bg-brand-500 px-4 text-base font-semibold whitespace-nowrap text-white shadow-sm active:scale-[0.98] disabled:opacity-60"
                >
                  {job?.state === 'working' ? <Loader2 className="size-5 animate-spin" /> : <SendIcon className="size-5" />} Send to CrossPoint
                </button>
                <button
                  disabled={job?.state === 'working'}
                  onClick={() => run(false)}
                  className="flex h-14 min-w-0 items-center justify-center gap-2 rounded-2xl bg-white px-4 text-base font-semibold whitespace-nowrap text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100 disabled:opacity-60"
                >
                  <Download className="size-5" /> Download
                </button>
              </div>
              {job && (
                <p className={`mt-3 text-center text-sm ${job.state === 'error' ? 'text-red-600' : 'text-stone-600'}`}>
                  {job.state === 'working'
                    ? progressLabel(job.progress)
                    : job.state === 'done'
                      ? job.sent
                        ? 'On your reader.'
                        : 'Downloaded. Send it any time from the Send tab.'
                      : job.error}
                </p>
              )}
            </div>
          )}

          {about.length > 0 && (
            <section className="mt-8">
              <h2 className="font-display text-xl font-semibold text-stone-900">About this book</h2>
              {about.map((p, i) => (
                <p key={i} className="mt-2 text-[0.95rem]/7 text-stone-700">
                  {p}
                </p>
              ))}
            </section>
          )}

          {entry.categories.length > 0 && (
            <div className="mt-6 flex flex-wrap gap-2">
              {entry.categories.slice(0, 12).map((c) => (
                <span key={c} className="rounded-full bg-stone-200/60 px-3 py-1 text-xs font-medium text-stone-600">
                  {c}
                </span>
              ))}
            </div>
          )}

          {details.length > 0 && (
            <section className="mt-8">
              <h2 className="font-display text-xl font-semibold text-stone-900">Details</h2>
              <Card className="mt-3 divide-y divide-stone-100">
                {details.map(([label, value], i) => (
                  <div key={i} className="px-4 py-3 sm:grid sm:grid-cols-[9rem_1fr] sm:gap-4">
                    <dt className="text-xs font-medium text-stone-500 sm:pt-0.5">{label}</dt>
                    <dd className="mt-0.5 text-sm/6 break-words text-stone-800 sm:mt-0">{value}</dd>
                  </div>
                ))}
              </Card>
            </section>
          )}


          {related.length > 0 && (
            <section className="mt-8">
              <h2 className="font-display text-xl font-semibold text-stone-900">More like this</h2>
              <Card className="mt-3 divide-y divide-stone-100">
                {related.map((l) => (
                  <a key={l.href} href={href(cat, 'f', l.href)} className="flex min-h-12 items-center gap-3 px-4 py-2.5 active:bg-stone-50">
                    <span className="min-w-0 flex-1 text-sm font-medium text-stone-800">{l.title.replace(/…$/, '')}</span>
                    <ChevronRight className="size-4 text-stone-300" />
                  </a>
                ))}
              </Card>
            </section>
          )}
        </div>
      </div>
    </div>
  )
}

// One rail on the storefront: a catalog section, loaded on its own.
function SectionRail({ cat, link }) {
  const [feed, setFeed] = useState(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let live = true
    fetchFeed(cat, link.href).then(
      (f) => live && setFeed(f),
      () => live && setFailed(true)
    )
    return () => {
      live = false
    }
  }, [cat, link.href])
  const title = link.title ?? 'Browse'
  const more = href(cat, 'f', link.href)
  if (failed) return null
  if (!feed) return <SkeletonRail title={title} />
  const books = feed.groups.length ? feed.groups.flatMap((g) => g.entries) : feed.entries
  if (books.length) return <CoverRail title={title} more={more} entries={books.slice(0, 24)} onOpen={openBook(cat)} />
  // A section of sub-sections (genres, authors...): swipeable category tiles.
  const subs = navRows(feed.navigation).slice(0, 24)
  if (!subs.length) return null
  return (
    <Rail title={title} more={more}>
      {subs.map((l, i) => (
        <a
          key={`${l.href}-${i}`}
          href={href(cat, 'f', l.href)}
          className="flex h-20 w-40 shrink-0 snap-start items-end rounded-xl bg-white p-3 ring-1 ring-stone-950/5 active:bg-stone-50"
        >
          <span className="line-clamp-2 text-sm/5 font-semibold text-stone-800">{l.title}</span>
        </a>
      ))}
    </Rail>
  )
}

// A catalog on the storefront: its root feed fanned out into rails (common-stacks' Library layout).
function CatalogBlock({ cat }) {
  const [root, setRoot] = useState(null)
  const [error, setError] = useState(null)
  useEffect(() => {
    let live = true
    fetchFeed(cat).then(
      (f) => live && setRoot(f),
      (e) => live && setError(String(e))
    )
    return () => {
      live = false
    }
  }, [cat])

  let body
  if (error) body = <p className="mt-3 text-sm text-red-600">{error}</p>
  else if (!root) body = <SkeletonRail title="Loading…" />
  else if (root.entries.length && !root.groups.length) {
    body = <CoverRail title={root.title} more={href(cat)} entries={root.entries.slice(0, 24)} onOpen={openBook(cat)} />
  } else {
    // OPDS 2 groups arrive with their books; nav sections load their own rails.
    const lanes = root.groups.filter((g) => g.entries.length)
    const sections = navRows(root.navigation).filter((l) => !lanes.some((g) => g.href === l.href))
    body = (
      <>
        {lanes.slice(0, MAX_RAILS).map((g, i) => (
          <CoverRail key={`g${i}`} title={g.title} more={g.href && href(cat, 'f', g.href)} entries={g.entries} onOpen={openBook(cat)} />
        ))}
        {sections.slice(0, Math.max(0, MAX_RAILS - lanes.length)).map((l) => (
          <SectionRail key={l.href} cat={cat} link={l} />
        ))}
      </>
    )
  }

  return (
    <section className="mt-10 first:mt-6">
      <a href={href(cat)} className="inline-flex items-center gap-2">
        <h2 className="font-display text-2xl font-semibold tracking-tight text-stone-900">{cat.name}</h2>
        <ChevronRight className="size-5 text-stone-400" />
      </a>
      {body}
    </section>
  )
}

function SearchBox({ value, onSubmit, placeholder }) {
  const [q, setQ] = useState(value ?? '')
  return (
    <form
      className="relative mt-4 md:max-w-md"
      onSubmit={(e) => {
        e.preventDefault()
        if (q.trim()) onSubmit(q.trim())
      }}
    >
      <Search className="pointer-events-none absolute top-3.5 left-4 size-5 text-stone-400" />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} enterKeyHint="search" className={`${input} pl-12`} />
    </form>
  )
}

const searchAll = (q) => (location.hash = `#/browse/search/${encodeURIComponent(q)}`)

function Storefront({ catalogs }) {
  return (
    <div className="px-4 pt-6 pb-4 md:px-8 md:pt-6 lg:px-12">
      <Eyebrow className="md:hidden">Find something to read</Eyebrow>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-stone-900 md:mt-0 md:flex md:h-11 md:items-center md:text-4xl">Browse</h1>
      <SearchBox placeholder="Search all catalogs" onSubmit={searchAll} />
      {catalogs.length === 0 && (
        <Card className="mt-6 p-4 text-sm/6 text-stone-600">
          No catalogs yet. <a href="#/browse/manage" className="font-semibold text-brand-600">Add one</a> to start browsing.
        </Card>
      )}
      {catalogs.map((c) => (
        <CatalogBlock key={c.id} cat={c} />
      ))}
    </div>
  )
}

// Search every catalog at once: a rail of results per catalog.
function SearchAll({ catalogs, query }) {
  const [results, setResults] = useState({})
  useEffect(() => {
    let live = true
    setResults({})
    for (const c of catalogs) {
      search(c, query).then(
        (f) => live && setResults((r) => ({ ...r, [c.id]: { entries: f.groups.length ? f.groups.flatMap((g) => g.entries) : f.entries } })),
        (e) => live && setResults((r) => ({ ...r, [c.id]: { error: String(e) } }))
      )
    }
    return () => {
      live = false
    }
  }, [catalogs, query])
  return (
    <div className="px-4 pt-4 pb-4 md:px-8 md:pt-6 lg:px-12">
      <TopBar back="#/browse" label="Browse" />
      <SearchBox value={query} placeholder="Search all catalogs" onSubmit={searchAll} />
      {catalogs.map((c) => {
        const r = results[c.id]
        if (!r) return <SkeletonRail key={c.id} title={c.name} />
        if (r.error || !r.entries.length)
          return (
            <section key={c.id} className="mt-7">
              <h3 className="font-display text-xl font-semibold text-stone-900">{c.name}</h3>
              <p className="mt-1 text-sm text-stone-500">{r.error ?? 'No matches.'}</p>
            </section>
          )
        return <CoverRail key={c.id} title={c.name} more={href(c, 's', query)} entries={r.entries} onOpen={openBook(c)} />
      })}
    </div>
  )
}

function FeedView({ cat, url, query }) {
  const [state, setState] = useState({ feed: null, error: null })
  const [more, setMore] = useState(false)

  useEffect(() => {
    let live = true
    setState({ feed: null, error: null })
    ;(query ? search(cat, query) : fetchFeed(cat, url)).then(
      (feed) => live && setState({ feed, error: null }),
      (error) => live && setState({ feed: null, error: String(error) })
    )
    return () => {
      live = false
    }
  }, [cat, url, query])

  async function loadMore() {
    setMore(true)
    try {
      const next = await fetchFeed(cat, state.feed.next)
      setState(({ feed }) => ({
        feed: { ...next, title: feed.title, entries: [...feed.entries, ...next.entries], navigation: [...feed.navigation, ...next.navigation] },
      }))
    } finally {
      setMore(false)
    }
  }

  const { feed, error } = state
  const rows = feed ? navRows(feed.navigation) : []
  // Grouped feeds (OPDS 2 lanes) also flatten their books into entries; show the lanes instead.
  const loose = feed?.groups.length ? [] : (feed?.entries ?? [])
  const open = openBook(cat)

  return (
    <div className="px-4 pt-4 pb-6 md:px-8 md:pt-6 lg:px-12">
      <TopBar back={url || query ? 'history' : '#/browse'} label={url || query ? 'Back' : 'Browse'} />
      <h1 className="mt-2 font-display text-3xl/tight font-semibold tracking-tight text-stone-900">
        {query ? `“${query}”` : (feed?.title ?? cat.name)}
      </h1>
      {(query || feed?.title !== cat.name) && <p className="mt-1 text-sm text-stone-500">{cat.name}</p>}
      <SearchBox value={query} placeholder={`Search ${cat.name}`} onSubmit={(q) => (location.hash = href(cat, 's', q))} />

      {error && <Card className="mt-6 p-4 text-sm/6 text-red-700">{error}</Card>}
      {!feed && !error && <Spinner />}

      {feed && (
        <>
          {feed.facets.map((g) => (
            <div key={g.title} className="-mx-4 mt-5 flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0">
              {g.title && <span className="shrink-0 self-center text-xs font-medium text-stone-500">{g.title}</span>}
              {g.facets.map((f) => (
                <a
                  key={f.href}
                  href={href(cat, 'f', f.href)}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-sm font-medium ${f.active ? 'bg-brand-500 text-white' : 'bg-white text-stone-600 ring-1 ring-stone-950/10'}`}
                >
                  {f.title}
                  {f.count != null && <span className="ml-1 font-mono text-xs opacity-70">{f.count}</span>}
                </a>
              ))}
            </div>
          ))}

          {rows.length > 0 && (
            <Card className="mt-5 divide-y divide-stone-100">
              {rows.map((l, i) => (
                <a key={`${l.href}-${i}`} href={href(cat, 'f', l.href)} className="flex min-h-14 items-center gap-3 px-4 py-3 active:bg-stone-50">
                  <BookOpen className="size-5 shrink-0 text-stone-400" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1 text-[0.95rem] font-medium text-stone-900">{l.title ?? l.href}</span>
                  <ChevronRight className="size-5 text-stone-300" />
                </a>
              ))}
            </Card>
          )}

          {feed.groups.map((g, gi) => (
            <CoverRail key={`${g.title}-${gi}`} title={g.title} more={g.href && href(cat, 'f', g.href)} entries={g.entries} onOpen={open} />
          ))}

          {loose.length > 0 && (
            <div className="mt-6">
              <Grid entries={loose} onOpen={open} />
            </div>
          )}

          {!rows.length && !loose.length && !feed.groups.length && <p className="py-16 text-center text-sm text-stone-500">Nothing here.</p>}

          {feed.next && (
            <button
              onClick={loadMore}
              disabled={more}
              className="mx-auto mt-6 flex h-12 items-center gap-2 rounded-full bg-white px-6 text-sm font-semibold text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100"
            >
              {more ? <Loader2 className="size-4 animate-spin" /> : 'Load more'}
            </button>
          )}
        </>
      )}
    </div>
  )
}

function CatalogForm({ initial, onSave, onCancel }) {
  const [c, setC] = useState(initial ?? { name: '', url: '', auth: { kind: 'none' } })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const auth = (patch) => setC({ ...c, auth: { ...c.auth, ...patch } })

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const url = /^https?:\/\//i.test(c.url.trim()) ? c.url.trim() : `https://${c.url.trim()}`
    try {
      const f = await fetchFeed({ ...c, url })
      onSave({ ...c, url, id: c.id ?? crypto.randomUUID(), name: c.name.trim() || f.title || new URL(url).host })
    } catch (err) {
      setError(String(err))
    }
    setBusy(false)
  }

  return (
    <form onSubmit={submit} className="mt-4 space-y-3">
      <input className={input} placeholder="Catalog address (OPDS)" value={c.url} onChange={(e) => setC({ ...c, url: e.target.value })} inputMode="url" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
      <input className={input} placeholder="Name (optional)" value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
      <div className="grid grid-cols-3 gap-1 rounded-2xl bg-stone-200/60 p-1">
        {[
          ['none', 'No login'],
          ['basic', 'Password'],
          ['bearer', 'Token'],
        ].map(([kind, label]) => (
          <button
            type="button"
            key={kind}
            onClick={() => setC({ ...c, auth: { kind } })}
            className={`h-10 rounded-xl text-sm font-semibold ${c.auth.kind === kind ? 'bg-white text-stone-900 shadow-sm' : 'text-stone-500'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {c.auth.kind === 'basic' && (
        <>
          <input className={input} placeholder="Username or email" value={c.auth.username ?? ''} onChange={(e) => auth({ username: e.target.value })} autoCapitalize="none" autoCorrect="off" />
          <input className={input} placeholder="Password (can be empty)" type="password" value={c.auth.password ?? ''} onChange={(e) => auth({ password: e.target.value })} />
        </>
      )}
      {c.auth.kind === 'bearer' && <input className={input} placeholder="Token" value={c.auth.token ?? ''} onChange={(e) => auth({ token: e.target.value })} autoCapitalize="none" autoCorrect="off" />}
      {error && <p className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button disabled={busy} className="flex h-12 flex-1 items-center justify-center rounded-2xl bg-brand-500 font-semibold text-white disabled:opacity-60">
          {busy ? <Loader2 className="size-5 animate-spin" /> : 'Check and save'}
        </button>
        <button type="button" onClick={onCancel} className="h-12 rounded-2xl px-5 font-semibold text-stone-600 active:bg-stone-200">
          Cancel
        </button>
      </div>
    </form>
  )
}

function Manage({ catalogs, setCatalogs }) {
  const [editing, setEditing] = useState(catalogs.length ? null : 'new') // catalog | 'new' | null
  const save = (cat) => {
    setCatalogs(catalogs.some((c) => c.id === cat.id) ? catalogs.map((c) => (c.id === cat.id ? cat : c)) : [...catalogs, cat])
    setEditing(null)
  }
  return (
    <div className="px-4 pt-4 pb-4 md:px-8 md:pt-6 lg:px-12">
      <TopBar back="history" label="Back" />
      <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-stone-900">Catalogs</h1>
      <p className="mt-2 max-w-xl text-sm/6 text-stone-500">OPDS catalogs: public libraries like Project Gutenberg, or your own Calibre, Kavita or Mayberry server.</p>

      <div className="mt-6 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {catalogs.map((c) =>
          editing?.id === c.id ? (
            <Card key={c.id} className="p-4 md:col-span-2 xl:col-span-3">
              <CatalogForm initial={c} onSave={save} onCancel={() => setEditing(null)} />
            </Card>
          ) : (
            <Card key={c.id} className="flex items-center gap-3 p-2 pl-4">
              <a href={href(c)} className="flex min-w-0 flex-1 items-center gap-3 py-2">
                <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-50 text-brand-600">
                  <Server className="size-5" />
                </div>
                <div className="min-w-0">
                  <p className="truncate font-semibold text-stone-900">{c.name}</p>
                  <p className="truncate font-mono text-xs text-stone-500">{new URL(c.url).host}</p>
                </div>
              </a>
              <button onClick={() => setEditing(c)} className="grid size-10 place-items-center rounded-full text-stone-400 active:bg-stone-100" aria-label={`Edit ${c.name}`}>
                <Pencil className="size-4" />
              </button>
              <button
                onClick={() => confirm(`Remove ${c.name}?`) && setCatalogs(catalogs.filter((x) => x.id !== c.id))}
                className="grid size-10 place-items-center rounded-full text-stone-400 active:bg-stone-100"
                aria-label={`Remove ${c.name}`}
              >
                <Trash2 className="size-4" />
              </button>
            </Card>
          )
        )}
      </div>

      {editing === 'new' ? (
        <Card className="mt-3 p-4 md:max-w-xl">
          <h2 className="font-semibold text-stone-900">Add a catalog</h2>
          <CatalogForm onSave={save} onCancel={() => setEditing(null)} />
        </Card>
      ) : (
        <button
          onClick={() => setEditing('new')}
          className="mt-3 flex h-14 w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-stone-300 font-semibold text-stone-600 active:bg-stone-100 md:max-w-xs"
        >
          <Plus className="size-5" /> Add catalog
        </button>
      )}
    </div>
  )
}

export default function Browse({ parts }) {
  const [catalogs, setState] = useState(loadCatalogs)
  const setCatalogs = (list) => {
    setState(list)
    saveCatalogs(list)
  }
  if (!isApp) {
    return (
      <div className="px-4 pt-6">
        <Eyebrow>Browse</Eyebrow>
        <Card className="mt-6 p-4 text-sm/6 text-stone-600">Browsing catalogs needs the CrossPoint Sync app.</Card>
      </div>
    )
  }
  const [, id, kind, value] = parts
  if (id === 'manage') return <Manage catalogs={catalogs} setCatalogs={setCatalogs} />
  if (id === 'search' && kind) return <SearchAll key={kind} catalogs={catalogs} query={decodeURIComponent(kind)} />
  const cat = catalogs.find((c) => c.id === id)
  if (!cat) return <Storefront catalogs={catalogs} />
  const decoded = value && decodeURIComponent(value)
  if (kind === 'b') return <BookPage key={decoded} cat={cat} entryKey={decoded} />
  return <FeedView key={parts.join('/')} cat={cat} url={kind === 'f' ? decoded : undefined} query={kind === 's' ? decoded : undefined} />
}
