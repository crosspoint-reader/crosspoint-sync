import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Hash, Image as ImageIcon, Loader2, Merge, Search, Share2, Star, X } from 'lucide-react'
import { api } from './api.js'
import { renderCard } from './shareCard.js'
import { isPace, moodEmoji } from './moods.js'
import ShareSheet from './ShareSheet.jsx'
import { STATUS, Card, Cover, ErrorNote, ProgressBar, Spinner, ago, duration, pct, useLoad } from './ui.jsx'

const date = (unix) =>
  unix ? new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : null

function StatusPicker({ session, book, onChange }) {
  const [busy, setBusy] = useState(null)
  async function pick(id) {
    setBusy(id)
    try {
      await api.setStatus(session, book.document, id)
      onChange()
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      {STATUS.map((s) => (
        <button
          key={s.id}
          disabled={busy !== null}
          onClick={() => pick(s.id)}
          className={`flex items-center justify-center gap-2 rounded-md px-3 py-2.5 text-sm font-semibold whitespace-nowrap transition disabled:opacity-60 ${
            book.status === s.id
              ? 'bg-brand-500 text-white shadow-sm'
              : 'bg-surface text-stone-700 shadow-sm ring-1 ring-stone-950/10 active:bg-stone-50'
          }`}
        >
          <s.icon className="size-4" strokeWidth={2} />
          {busy === s.id ? '…' : s.label}
        </button>
      ))}
    </div>
  )
}

// Device stats (CrossInk) when present, else what the sync history shows.
function Stats({ session, doc, activity: a }) {
  const [data] = useLoad(() => api.bookStats(session, doc), [session, doc], `bookstats:${doc}`)
  const c = data?.combined
  let cells
  if (c?.sessions) {
    cells = [
      ['Time read', duration(c.seconds)],
      ['Sessions', c.sessions],
      ['Pages turned', c.pages],
      ['Started', date(c.start_date)],
      ['Finished', date(c.finished_date)],
    ]
  } else if (a) {
    const days = Math.max(1, Math.round(((a.finished_at ?? Date.now() / 1000) - a.started_at) / 86400))
    cells = [
      ['Print pages', a.page_count ? `${a.pages_read} of ${a.page_count}` : 'Unknown'],
      [a.finished_at ? 'Took' : 'Reading for', `${days} ${days === 1 ? 'day' : 'days'}`],
      ['First synced', date(a.started_at)],
      ['Finished', date(a.finished_at)],
    ]
  } else return null
  cells = cells.filter(([, v]) => v)
  return (
    <Card className="mt-4 grid grid-cols-2 gap-px overflow-hidden bg-stone-100">
      {cells.map(([l, v]) => (
        <div key={l} className="bg-surface px-4 py-3">
          <p className="text-xs text-stone-500">{l}</p>
          <p className="mt-0.5 font-display text-lg font-semibold text-stone-900">{v}</p>
        </div>
      ))}
    </Card>
  )
}

// A clipping's share card: the quote with its book's cover, title and author.
export function ClipShare({ session, book, clip, onClose }) {
  const meta = { quote: clip.text, title: book.title || book.filename, author: book.author, chapter: clip.chapter }
  return (
    <ShareSheet
      heading="Share clipping"
      meta={meta}
      renderKey={clip.id}
      onClose={onClose}
      render={async () => {
        const coverUrl = book.cover_url ?? (await api.cover(session, book.document).then((r) => r.url, () => null))
        return renderCard({ ...meta, coverUrl })
      }}
    />
  )
}

function Clippings({ session, book }) {
  const [items, error] = useLoad(() => api.clippings(session, book.document), [session, book.document], `clips:${book.document}`)
  const [sharing, setSharing] = useState(null)
  if (error) return <ErrorNote error={error} />
  if (!items) return <Spinner />
  if (!items.length) return <p className="py-8 text-center text-sm text-stone-500">No clippings for this book yet.</p>
  let chapter = null
  return (
    <div className="space-y-3">
      {items.map((c) => {
        const heading = c.chapter && c.chapter !== chapter ? (chapter = c.chapter) : null
        return (
          <div key={c.id}>
            {heading && <p className="mt-5 mb-2 font-mono text-[0.65rem] font-medium tracking-wider text-stone-400 uppercase">{heading}</p>}
            <Card className="p-4">
              <blockquote className="border-l-2 border-brand-300 pl-3 font-display text-[0.95rem]/relaxed text-stone-800 italic">
                {c.text}
              </blockquote>
              {c.note && <p className="mt-3 font-hand text-lg/6 text-brand-700">{c.note}</p>}
              <div className="mt-2 flex items-center justify-between">
                <button
                  onClick={() => setSharing(c)}
                  className="-ml-2 flex h-9 items-center gap-1.5 rounded-full px-2 text-sm font-medium text-brand-600 active:bg-stone-100"
                  aria-label="Share clipping"
                >
                  <Share2 className="size-4" /> Share
                </button>
                <p className="font-mono text-[0.65rem] text-stone-400">{date(c.created_at)}</p>
              </div>
            </Card>
          </div>
        )
      })}
      {sharing && <ClipShare session={session} book={book} clip={sharing} onClose={() => setSharing(null)} />}
    </div>
  )
}

const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
// Same normalized title (and author when both have one): probably the same book synced twice.
export const looksLikeSame = (a, b) =>
  a.document !== b.document && norm(a.title) && norm(a.title) === norm(b.title) && (!a.author || !b.author || norm(a.author) === norm(b.author))

function Sheet({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center md:items-center">
      <div className="absolute inset-0 bg-stone-950/40" onClick={onClose} />
      <div className="relative max-h-[88dvh] w-full overflow-y-auto rounded-t-[28px] bg-stone-50 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:max-w-lg md:rounded-[28px] md:p-6">
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-stone-300 md:hidden" />
        <button onClick={onClose} className="absolute top-3 right-3 grid size-10 place-items-center rounded-full text-stone-500 active:bg-stone-200" aria-label="Close">
          <X className="size-5" />
        </button>
        <h2 className="pr-10 font-display text-xl font-semibold text-stone-900">{title}</h2>
        {children}
      </div>
    </div>
  )
}

const field =
  'h-11 w-full rounded-xl bg-surface px-3 text-base text-stone-900 ring-1 ring-stone-950/10 outline-none placeholder:text-stone-400 focus:ring-2 focus:ring-brand-500/60'

function CoverPicker({ session, book, onDone, onClose }) {
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [url, setUrl] = useState('')
  const [items, error] = useLoad(() => api.coverCandidates(session, book.document, search), [session, book.document, search])
  const [busy, setBusy] = useState(false)
  async function choose(patch) {
    setBusy(true)
    try {
      await api.setInfo(session, book.document, patch)
      onDone()
    } finally {
      setBusy(false)
    }
  }
  return (
    <Sheet title="Choose a cover" onClose={onClose}>
      <form
        className="mt-4 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          setSearch(q.trim())
        }}
      >
        <input className={field} value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search a different title (${book.title})`} enterKeyHint="search" />
      </form>
      {error ? (
        <p className="mt-4 text-sm text-red-600">{error.message}</p>
      ) : !items ? (
        <Spinner />
      ) : items.length === 0 ? (
        <p className="mt-6 text-center text-sm text-stone-500">No covers found. Try another search or paste an image link.</p>
      ) : (
        <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4">
          {items.map((c) => (
            <button key={c.url} disabled={busy} onClick={() => choose({ cover_url: c.url })} className="group text-left">
              <img src={c.url} alt="" loading="lazy" className="aspect-[2/3] w-full rounded-md object-cover shadow-sm ring-1 ring-stone-950/10 group-active:scale-[0.98]" />
              <p className="mt-1 truncate text-[0.7rem] text-stone-500">{c.source}</p>
            </button>
          ))}
        </div>
      )}
      <form
        className="mt-5 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (/^https?:\/\//.test(url.trim())) choose({ cover_url: url.trim() })
        }}
      >
        <input className={field} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Or paste an image link" inputMode="url" autoCapitalize="none" />
        <button disabled={busy} className="h-11 shrink-0 rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white disabled:opacity-60">
          Use
        </button>
      </form>
      <button disabled={busy} onClick={() => choose({ cover_url: null })} className="mt-3 w-full py-2 text-sm font-medium text-stone-500 active:text-stone-800">
        Use automatic cover
      </button>
    </Sheet>
  )
}

function MergePicker({ session, book, books, onDone, onClose }) {
  const [busy, setBusy] = useState(null)
  const [err, setErr] = useState(null)
  const others = books
    .filter((b) => b.document !== book.document)
    .sort((a, b) => Number(looksLikeSame(book, b)) - Number(looksLikeSame(book, a)) || (a.title ?? '').localeCompare(b.title ?? ''))
  async function merge(other) {
    if (!confirm(`Merge "${other.title || other.filename}" into this book? Its progress, clippings and stats move here, and future syncs of it land here too.`)) return
    setBusy(other.document)
    setErr(null)
    try {
      await api.merge(session, other.document, book.document)
      onDone()
    } catch (e) {
      setErr(e.message)
      setBusy(null)
    }
  }
  return (
    <Sheet title="Merge a duplicate into this book" onClose={onClose}>
      <p className="mt-2 text-sm/6 text-stone-500">
        When two readers identify the same book differently, it shows up twice. Pick the copy to fold into this one.
      </p>
      {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
      <Card className="mt-4 divide-y divide-stone-100">
        {others.map((b) => (
          <button key={b.document} disabled={busy !== null} onClick={() => merge(b)} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-stone-50">
            <Cover session={session} book={b} small className="w-9" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-stone-900">{b.title || b.filename}</p>
              <p className="truncate text-xs text-stone-500">
                {[b.author, pct(b.percentage), b.device].filter(Boolean).join(' · ')}
              </p>
            </div>
            {busy === b.document ? (
              <Loader2 className="size-4 animate-spin text-brand-500" />
            ) : (
              looksLikeSame(book, b) && <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-[0.65rem] font-semibold text-brand-700">Likely duplicate</span>
            )}
          </button>
        ))}
      </Card>
    </Sheet>
  )
}

// Fix what the automatic lookups got wrong, and fold duplicates together.
function BookTools({ session, book, books, onChange }) {
  const [open, setOpen] = useState(null) // 'cover' | 'merge'
  const [pages, setPages] = useState(book.page_count ?? '')
  const [saving, setSaving] = useState(false)
  const dupes = books.filter((b) => looksLikeSame(book, b)).length
  async function savePages(value) {
    setSaving(true)
    try {
      await api.setInfo(session, book.document, { page_count: value })
      onChange()
    } finally {
      setSaving(false)
    }
  }
  const done = () => {
    setOpen(null)
    onChange()
  }
  return (
    <Card className="mt-4 divide-y divide-stone-100">
      <button onClick={() => setOpen('cover')} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium text-stone-800 active:bg-stone-50">
        <ImageIcon className="size-4 text-stone-400" /> Change cover
      </button>
      <form
        className="flex items-center gap-3 px-4 py-2"
        onSubmit={(e) => {
          e.preventDefault()
          const n = parseInt(pages, 10)
          if (n > 0) savePages(n)
        }}
      >
        <Hash className="size-4 shrink-0 text-stone-400" />
        <label className="min-w-0 flex-1 text-sm font-medium text-stone-800" htmlFor="print-pages">
          Print pages
        </label>
        <input id="print-pages" value={pages} onChange={(e) => setPages(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="?" className="h-9 w-20 rounded-lg bg-stone-50 px-2 text-right text-sm text-stone-900 ring-1 ring-stone-950/10 outline-none focus:ring-2 focus:ring-brand-500/60" />
        {String(pages) !== String(book.page_count ?? '') && (
          <button disabled={saving} className="h-9 rounded-lg bg-brand-500 px-3 text-xs font-semibold text-white disabled:opacity-60">
            Save
          </button>
        )}
      </form>
      <button onClick={() => setOpen('merge')} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium text-stone-800 active:bg-stone-50">
        <Merge className="size-4 text-stone-400" /> Merge a duplicate
        {dupes > 0 && <span className="ml-auto rounded-full bg-brand-50 px-2 py-0.5 text-[0.65rem] font-semibold text-brand-700">{dupes} likely</span>}
      </button>
      {book.aliases?.length > 0 && (
        <div className="px-4 py-3 text-sm text-stone-600">
          Also synced as {book.aliases.length === 1 ? 'another copy' : `${book.aliases.length} other copies`}.{' '}
          <button
            className="font-semibold text-brand-600"
            onClick={async () => {
              if (!confirm('Separate the merged copies again? Future syncs from them will show as their own books.')) return
              for (const alias of book.aliases) await api.unmerge(session, alias)
              onChange()
            }}
          >
            Separate
          </button>
        </div>
      )}
      {open === 'cover' && <CoverPicker session={session} book={book} onDone={done} onClose={() => setOpen(null)} />}
      {open === 'merge' && <MergePicker session={session} book={book} books={books} onDone={done} onClose={() => setOpen(null)} />}
    </Card>
  )
}

// Moods, genres and content warnings from Hardcover's catalog (when the server has them).
function Details({ book }) {
  const moods = (book.moods ?? []).filter((m) => !isPace(m)).slice(0, 5)
  const pace = (book.moods ?? []).find(isPace)
  const genres = (book.genres ?? []).slice(0, 5)
  const warnings = book.content_warnings ?? []
  if (!moods.length && !genres.length && !warnings.length) return null
  return (
    <Card className="mt-4 space-y-4 p-4">
      {moods.length > 0 && (
        <div>
          <p className="text-xs font-medium text-stone-500">Moods{pace ? ` · ${pace.toLowerCase()} ${moodEmoji(pace)}` : ''}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {moods.map((m) => (
              <span
                key={m}
                className="inline-flex items-center gap-1 rounded-full border-[1.5px] border-stone-900 bg-surface px-2.5 py-1 text-xs font-semibold text-stone-900 shadow-[2px_2px_0_var(--color-stone-900)]"
              >
                <span aria-hidden="true">{moodEmoji(m)}</span>
                {m}
              </span>
            ))}
          </div>
        </div>
      )}
      {genres.length > 0 && (
        <div>
          <p className="text-xs font-medium text-stone-500">Genres</p>
          <p className="mt-1 font-display text-base text-stone-800">{genres.join(' · ')}</p>
        </div>
      )}
      {warnings.length > 0 && (
        <details className="text-xs text-stone-500">
          <summary className="cursor-pointer font-medium">Content warnings ({warnings.length})</summary>
          <p className="mt-1.5 text-stone-600">{warnings.join(', ')}</p>
        </details>
      )}
      {book.hardcover_slug && (
        <a href={`https://hardcover.app/books/${book.hardcover_slug}`} target="_blank" rel="noreferrer" className="block text-xs text-stone-400">
          From Hardcover
        </a>
      )}
    </Card>
  )
}

// The book's description (from Hardcover), clamped with Read more when it's long.
function About({ session, book }) {
  const [data] = useLoad(() => api.about(session, book.document), [book.document], `about ${book.document}`)
  const [open, setOpen] = useState(false)
  const [long, setLong] = useState(false)
  const text = useRef(null)
  const description = data?.description
  useEffect(() => {
    const el = text.current
    if (el) setLong(el.scrollHeight > el.clientHeight + 2)
  }, [description])
  if (!description) return null
  return (
    <Card className="mt-4 p-4">
      <p className="text-xs font-medium text-stone-500">About this book</p>
      <p ref={text} className={`mt-1.5 text-sm/6 whitespace-pre-line text-stone-700 ${open ? '' : 'line-clamp-6'}`}>
        {description}
      </p>
      {(long || open) && (
        <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-sm font-semibold text-brand-600">
          {open ? 'Show less' : 'Read more'}
        </button>
      )}
    </Card>
  )
}

// Finished (or nearly) a book in a series: show what comes next, and search the
// Browse catalogs for it so it's a tap away from being on the reader.
function NextInSeries({ session, book }) {
  const done = book.status === 'finished' || book.percentage >= 0.9
  const [data] = useLoad(() => (book.series && done ? api.next(session, book.document) : Promise.resolve(null)), [book.document, done], `next ${book.document}`)
  const next = data?.next
  if (!next) return null
  // Title only: many OPDS catalogs (Mayberry included) match the whole query against
  // titles, so adding the author turns a hit into no results.
  const query = next.title
  return (
    <Card className="mt-4 p-4">
      <p className="text-xs font-medium text-stone-500">Next in {data.series ?? book.series}</p>
      <div className="mt-2 flex gap-3">
        {next.cover ? (
          <img src={next.cover} alt="" loading="lazy" className="aspect-[2/3] w-14 shrink-0 rounded-md object-cover shadow-sm ring-1 ring-stone-950/10" />
        ) : (
          <div className="aspect-[2/3] w-14 shrink-0 rounded-md bg-cover ring-1 ring-stone-950/10" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-display text-base/tight font-semibold text-stone-900">{next.title}</p>
          <p className="mt-0.5 text-xs text-stone-500">
            Book {Number.isInteger(next.position) ? next.position : next.position.toFixed(1)}
            {next.year ? ` · ${next.year}` : ''}
          </p>
          <a
            href={`#/browse/search/${encodeURIComponent(query)}`}
            className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-full bg-brand-500 px-3.5 text-xs font-semibold text-white transition active:scale-[0.98]"
          >
            <Search className="size-3.5" strokeWidth={2.25} /> Find it in your catalogs
          </a>
        </div>
      </div>
    </Card>
  )
}

const seriesLabel = (b) =>
  b.series ? `${b.series}${b.series_position ? ` · Book ${Number.isInteger(b.series_position) ? b.series_position : b.series_position.toFixed(1)}` : ''}` : null

export default function Book({ session, book, books, activity, onChange }) {
  if (!book) return <p className="py-16 text-center text-sm text-stone-500">Book not found.</p>
  return (
    <div className="px-4 pt-4 pb-6 md:px-8 md:pt-6 lg:px-12">
      {/* Top bar: same 44px row as the account avatar (top-4, size-11) so they line up. */}
      <div className="flex h-11 items-center pr-12 md:pr-0">
        <a
          href="#/"
          className="-ml-2 flex h-11 items-center gap-1.5 rounded-full pr-4 pl-2 text-lg font-semibold text-brand-600 transition active:bg-stone-200/70 md:hover:bg-stone-100"
        >
          <ArrowLeft className="size-6" strokeWidth={2} /> Library
        </a>
      </div>
      <div className="md:mt-4 md:grid md:grid-cols-[19rem_1fr] md:items-start md:gap-8 lg:grid-cols-[23rem_1fr] lg:gap-10">
        <aside className="md:sticky md:top-8">
          <div className="relative mt-3 flex gap-4 md:mt-0 md:flex-col md:gap-5">
            <Cover session={session} book={book} className="w-28 md:mx-auto md:w-full md:max-w-60" />
            <div className="min-w-0 flex-1 pt-1 md:pt-0">
              <h1 className="font-display text-2xl/tight font-semibold tracking-tight text-balance text-stone-900">
                {book.title || book.filename || 'Untitled book'}
              </h1>
              <p className="mt-1 text-sm text-stone-500">{book.author}</p>
              {seriesLabel(book) && <p className="mt-1 text-xs text-stone-500">{seriesLabel(book)}</p>}
              {book.rating && (
                <p className="mt-1 flex items-center gap-1 text-xs text-stone-500">
                  <Star className="size-3.5 fill-current text-amber-500" strokeWidth={0} />
                  <span className="font-medium text-stone-700">{book.rating.toFixed(1)}</span>
                  {book.release_year ? <span>· {book.release_year}</span> : null}
                </p>
              )}
              <p className="mt-3 font-mono text-xs text-stone-500">
                <span className="font-semibold text-brand-600">{pct(book.percentage)}</span> · {book.device || book.device_id} · {ago(book.timestamp)}
              </p>
              <ProgressBar value={book.percentage} className="mt-2" />
            </div>
          </div>
          <div className="mt-6">
            <StatusPicker session={session} book={book} onChange={onChange} />
          </div>
          <About session={session} book={book} />
          <NextInSeries session={session} book={book} />
          <Details book={book} />
          <Stats session={session} doc={book.document} activity={activity} />
          <BookTools key={`${book.document}-${book.page_count}`} session={session} book={book} books={books} onChange={onChange} />
        </aside>

        <section className="md:max-w-2xl">
          <h2 className="mt-8 mb-3 font-display text-xl font-semibold text-stone-900 md:mt-0 md:text-2xl">Clippings</h2>
          <Clippings session={session} book={book} />
        </section>
      </div>
    </div>
  )
}
