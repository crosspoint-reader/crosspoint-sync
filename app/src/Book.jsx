import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, CalendarDays, Hash, MoreHorizontal, Split, Trash2, Image as ImageIcon, Loader2, Merge, Quote, Search, Share2, Star, X } from 'lucide-react'
import { api, isApp } from './api.js'
import { renderCard } from './shareCard.js'
import { isPace, moodEmoji } from './moods.js'
import ShareSheet from './ShareSheet.jsx'
import SpotifyCard from './SpotifyCard.jsx'
import { Picker } from './Settings.jsx'
import { STATUS, Card, Cover, EmptyState, ErrorNote, ProgressBar, Spinner, ViaHardcover, ago, duration, notify, pct, useLoad } from './ui.jsx'

const date = (unix, opts) =>
  unix ? new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', ...opts }) : null
// CrossInk stats dates are calendar dates sent as UTC midnight: show them in UTC so they don't slip a day.
const calendarDate = (unix) => date(unix, { timeZone: 'UTC' })

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
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
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
// Tablet/desktop layout? (Tailwind's md breakpoint.)
const wideQuery = window.matchMedia('(min-width: 48rem)')
function useWide() {
  const [wide, setWide] = useState(wideQuery.matches)
  useEffect(() => {
    const on = () => setWide(wideQuery.matches)
    wideQuery.addEventListener('change', on)
    return () => wideQuery.removeEventListener('change', on)
  }, [])
  return wide
}

function Stats({ session, doc, aliases, activity: a, wide = false }) {
  // Merging or separating copies changes which stats count, so refetch then.
  const [data] = useLoad(() => api.bookStats(session, doc), [session, doc, aliases?.join()], `bookstats:${doc}`)
  const c = data?.combined
  let cells
  if (c?.sessions) {
    cells = [
      ['Time read', duration(c.seconds)],
      ['Sessions', c.sessions],
      ['Pages turned', c.pages],
      // Dates set by hand win over the device's.
      ['Started', a?.start_manual ? date(a.started_at) : calendarDate(c.start_date)],
      ['Finished', a?.finish_manual ? date(a.finished_at) : calendarDate(c.finished_date)],
    ]
  } else if (a) {
    const days = a.days_to_finish ?? Math.max(1, Math.round(((a.finished_at ?? Date.now() / 1000) - a.started_at) / 86400))
    cells = [
      ['Print pages', a.page_count ? `${a.pages_read} of ${a.page_count}` : 'Unknown'],
      [a.finished_at ? 'Took' : 'Reading for', `${days} ${days === 1 ? 'day' : 'days'}`],
      [a.start_manual ? 'Started' : 'First synced', date(a.started_at)],
      ['Finished', date(a.finished_at)],
    ]
  } else return null
  cells = cells.filter(([, v]) => v)
  return (
    <Card className={`mt-4 gap-px overflow-hidden bg-stone-100 ${wide ? 'flex flex-wrap' : 'grid grid-cols-2'}`}>
      {cells.map(([l, v]) => (
        <div key={l} className={`bg-surface py-3 ${wide ? 'min-w-fit flex-1 px-3 whitespace-nowrap lg:px-4' : 'px-4'}`}>
          <p className="text-xs text-stone-500">{l}</p>
          <p className={`mt-0.5 font-display font-semibold text-stone-900 ${wide ? 'text-base lg:text-lg' : 'text-lg'}`}>{v}</p>
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

// Touch: press and hold a clipping to delete it (desktop uses ClipMenu). One press at a time, so one timer.
let holdTimer
export function hold(fn) {
  const stop = () => clearTimeout(holdTimer)
  return {
    onPointerDown: (e) => {
      stop()
      if (e.pointerType !== 'mouse') holdTimer = setTimeout(fn, 500)
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop, // fires when a touch turns into a scroll
  }
}

// Desktop: a ⋯ button on hover with the clip's actions.
export function ClipMenu({ onDelete }) {
  const [open, setOpen] = useState(false)
  return (
    <div className={`absolute top-2 right-2 hidden md:block ${open ? '' : 'opacity-0 group-hover:opacity-100 focus-within:opacity-100'}`}>
      <button
        type="button"
        aria-label="Clip actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="grid size-8 place-items-center rounded-full text-stone-500 hover:bg-stone-100"
      >
        <MoreHorizontal className="size-5" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div role="menu" className="absolute top-9 right-0 z-30 w-44 overflow-hidden rounded-xl bg-surface shadow-lg ring-1 ring-stone-950/10">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onDelete()
              }}
              className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium text-red-600 hover:bg-stone-50"
            >
              <Trash2 className="size-4" /> Delete clip
            </button>
          </div>
        </>
      )}
    </div>
  )
}

export function DeleteClip({ session, clip, document, onDone, onClose }) {
  const [busy, setBusy] = useState(false)
  async function remove() {
    setBusy(true)
    try {
      await api.deleteClipping(session, document, clip.id)
      onDone()
    } catch (e) {
      setBusy(false)
      notify({ error: true, title: "Couldn't delete the clip", detail: e.message })
    }
  }
  return (
    <Sheet title="Delete this clip?" onClose={onClose}>
      <blockquote className="mt-3 line-clamp-3 border-l-2 border-brand-300 pl-3 font-display text-[0.95rem]/relaxed text-stone-600 italic">{clip.text}</blockquote>
      <div className="mt-5 grid gap-2">
        <button disabled={busy} onClick={remove} className="h-12 rounded-xl bg-red-600 text-base font-semibold text-white active:bg-red-700 disabled:opacity-60">
          Delete
        </button>
        <button onClick={onClose} className="h-12 rounded-xl bg-surface text-base font-semibold text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100">
          Cancel
        </button>
      </div>
    </Sheet>
  )
}

function Clippings({ session, book }) {
  const [items, error, reload] = useLoad(() => api.clippings(session, book.document), [session, book.document], `clips:${book.document}`)
  const [sharing, setSharing] = useState(null)
  const [deleting, setDeleting] = useState(null)
  if (error) return <ErrorNote error={error} />
  if (!items) return <Spinner />
  if (!items.length) {
    return (
      <EmptyState compact icon={Quote} title="No clippings from this book yet">
        Highlight passages on your reader and they collect here.
      </EmptyState>
    )
  }
  let chapter = null
  return (
    <div className="space-y-3">
      {items.map((c) => {
        const heading = c.chapter && c.chapter !== chapter ? (chapter = c.chapter) : null
        return (
          <div key={c.id}>
            {heading && <p className="mt-5 mb-2 font-mono text-[0.65rem] font-medium tracking-wider text-stone-400 uppercase">{heading}</p>}
            <Card className="group relative p-4 select-none [-webkit-touch-callout:none] md:select-text" {...hold(() => setDeleting(c))}>
              <ClipMenu onDelete={() => setDeleting(c)} />
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
      {deleting && (
        <DeleteClip
          session={session}
          clip={deleting}
          document={book.document}
          onDone={() => {
            setDeleting(null)
            reload()
          }}
          onClose={() => setDeleting(null)}
        />
      )}
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
        <EmptyState compact icon={ImageIcon} title="No covers found">
          Try another search, or paste an image link.
        </EmptyState>
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
  const [stats, setStats] = useState(true)
  const others = books
    .filter((b) => b.document !== book.document)
    .sort((a, b) => Number(looksLikeSame(book, b)) - Number(looksLikeSame(book, a)) || (a.title ?? '').localeCompare(b.title ?? ''))
  async function merge(other) {
    const what = stats ? 'progress, clippings and reading stats' : 'progress and clippings'
    if (!confirm(`Merge "${other.title || other.filename}" into this book? Its ${what} move here, and future syncs of it land here too.`)) return
    setBusy(other.document)
    setErr(null)
    try {
      await api.merge(session, other.document, book.document, stats)
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
      <label className="mt-3 flex items-center gap-2 text-sm text-stone-600">
        <input type="checkbox" checked={stats} onChange={(e) => setStats(e.target.checked)} className="size-4 accent-brand-500" />
        Combine reading stats (time, pages, sessions)
      </label>
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

// The ⋯ menu: fix what the automatic lookups got wrong, fold duplicates together, or remove the book.
// A local calendar date as an <input type="date"> value. Activity dates are
// pinned to local noon, so the local date is the intended day.
const dateInput = (unix) => {
  if (!unix) return ''
  const d = new Date(unix * 1000)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function DatesSheet({ session, book, activity: a, onDone, onClose }) {
  const initial = { start_date: dateInput(a?.started_at), finished_date: dateInput(a?.finished_at) }
  const [form, setForm] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const today = dateInput(Date.now() / 1000)
  async function send(dates) {
    setSaving(true)
    setError(null)
    try {
      await api.setDates(session, book.document, dates)
      onDone()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }
  function save(e) {
    e.preventDefault()
    if (form.start_date && form.finished_date && form.start_date > form.finished_date) {
      return setError('The start date is after the finish date.')
    }
    // Only what changed: untouched dates keep following the reader.
    const changed = Object.fromEntries(Object.keys(form).filter((k) => form[k] !== initial[k]).map((k) => [k, form[k] || null]))
    if (!Object.keys(changed).length) return onClose()
    send(changed)
  }
  const input = (key, label) => (
    <label className="block">
      <span className="text-xs font-medium text-stone-500">{label}</span>
      <input
        type="date"
        value={form[key]}
        max={today}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        className={`${field} mt-1`}
      />
    </label>
  )
  return (
    <Sheet title="Reading dates" onClose={onClose}>
      <p className="mt-1 text-sm text-stone-500">
        Dates you set here win over your reader&apos;s. Setting a finish date marks the book finished.
      </p>
      <form onSubmit={save} className="mt-4 space-y-3">
        <div className="grid grid-cols-2 gap-3">
          {input('start_date', 'Started')}
          {input('finished_date', 'Finished')}
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="flex gap-2 pt-1">
          {(a?.start_manual || a?.finish_manual) && (
            <button
              type="button"
              disabled={saving}
              onClick={() => send({ start_date: null, finished_date: null })}
              className="h-11 rounded-xl px-4 text-sm font-semibold text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100 disabled:opacity-60"
            >
              Use reader&apos;s dates
            </button>
          )}
          <button disabled={saving} className="ml-auto h-11 shrink-0 rounded-xl bg-brand-500 px-5 text-sm font-semibold text-white disabled:opacity-60">
            Save
          </button>
        </div>
      </form>
    </Sheet>
  )
}

function BookMenu({ session, book, books, activity, onChange }) {
  const [menu, setMenu] = useState(false)
  const [open, setOpen] = useState(null) // 'cover' | 'pages' | 'dates' | 'merge'
  const [pages, setPages] = useState(book.page_count ?? '')
  const [saving, setSaving] = useState(false)
  const dupes = books.filter((b) => looksLikeSame(book, b)).length
  const done = () => {
    setOpen(null)
    onChange()
  }
  async function savePages(e) {
    e.preventDefault()
    const n = parseInt(pages, 10)
    if (!(n > 0)) return
    setSaving(true)
    try {
      await api.setInfo(session, book.document, { page_count: n })
      done()
    } finally {
      setSaving(false)
    }
  }
  async function separate() {
    if (!confirm('Separate the merged copies again? Future syncs from them will show as their own books.')) return
    for (const alias of book.aliases) await api.unmerge(session, alias)
    onChange()
  }
  async function remove() {
    if (!confirm(`Remove "${book.title || 'this book'}" from your library? Its progress, clippings and stats are deleted. A reader that still has it will sync it again.`)) return
    try {
      await api.removeBook(session, book.document)
      location.hash = '#/'
      onChange()
    } catch (e) {
      notify({ error: true, title: "Couldn't remove the book", detail: e.message })
    }
  }
  const item = (Icon, label, run, extra = null, danger = false) => (
    <button
      type="button"
      role="menuitem"
      onClick={() => {
        setMenu(false)
        run()
      }}
      className={`flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium active:bg-stone-50 md:hover:bg-stone-50 ${danger ? 'text-red-600' : 'text-stone-800'}`}
    >
      <Icon className={`size-4 ${danger ? '' : 'text-stone-400'}`} /> {label}
      {extra}
    </button>
  )

  return (
    <div className="relative ml-auto">
      <button
        type="button"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={menu}
        onClick={() => setMenu(!menu)}
        className="grid size-11 place-items-center rounded-full text-stone-600 transition active:bg-stone-200/70 md:hover:bg-stone-100"
      >
        <MoreHorizontal className="size-6" />
      </button>
      {menu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
          <div role="menu" className="absolute top-12 right-0 z-30 w-64 divide-y divide-stone-100 overflow-hidden rounded-xl bg-surface shadow-lg ring-1 ring-stone-950/10">
            {item(ImageIcon, 'Change cover', () => setOpen('cover'))}
            {item(CalendarDays, 'Reading dates', () => setOpen('dates'))}
            {item(Hash, 'Print pages', () => setOpen('pages'), <span className="ml-auto font-mono text-xs text-stone-500">{book.page_count ?? '?'}</span>)}
            {item(
              Merge,
              'Merge a duplicate',
              () => setOpen('merge'),
              dupes > 0 && <span className="ml-auto rounded-full bg-brand-50 px-2 py-0.5 text-[0.65rem] font-semibold text-brand-700">{dupes} likely</span>
            )}
            {book.aliases?.length > 0 &&
              item(Split, book.aliases.length === 1 ? 'Separate merged copy' : `Separate ${book.aliases.length} merged copies`, separate)}
            {item(Trash2, 'Remove from library', remove, null, true)}
          </div>
        </>
      )}
      {open === 'cover' && <CoverPicker session={session} book={book} onDone={done} onClose={() => setOpen(null)} />}
      {open === 'dates' && <DatesSheet session={session} book={book} activity={activity} onDone={done} onClose={() => setOpen(null)} />}
      {open === 'merge' && <MergePicker session={session} book={book} books={books} onDone={done} onClose={() => setOpen(null)} />}
      {open === 'pages' && (
        <Sheet title="Print pages" onClose={() => setOpen(null)}>
          <p className="mt-1 text-sm text-stone-500">The printed edition&apos;s page count, used for pages read and stats.</p>
          <form onSubmit={savePages} className="mt-4 flex gap-2">
            <input autoFocus value={pages} onChange={(e) => setPages(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="e.g. 384" className={field} />
            <button disabled={saving} className="h-11 shrink-0 rounded-xl bg-brand-500 px-5 text-sm font-semibold text-white disabled:opacity-60">
              Save
            </button>
          </form>
        </Sheet>
      )}
    </div>
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
    </Card>
  )
}

// The book's description (from Hardcover), clamped with Read more when it's long.
// Beyond this book: the next one in its series, and where this one syncs to
// (its match at each linked service, fixable in place).
function Services({ session, book }) {
  const done = book.status === 'finished' || book.percentage >= 0.9
  const [series] = useLoad(() => (book.series && done ? api.next(session, book.document) : Promise.resolve(null)), [book.document, done], `next ${book.document}`)
  const [data, , reload] = useLoad(() => api.bookMatches(session, book.document), [book.document], `matches ${book.document}`)
  const [picking, setPicking] = useState(null)
  if (!series?.next && !data?.length) return null
  return (
    <Card className="mt-4 divide-y divide-stone-100">
      {series?.next && <NextInSeries book={book} data={series} />}
      {data?.length > 0 && (
        <div className="py-2">
          <p className="px-4 pt-2 text-xs font-medium text-stone-500">Connected services</p>
          {data.map((m) => (
            <div key={m.id} className="px-4 py-2">
              <div className="flex items-center gap-3">
                <img src={`${session.server}/icons/${m.id}.png`} alt="" className="size-7 shrink-0 rounded-md" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-stone-900">{m.name}</p>
                  <p className={`truncate text-xs ${m.matched ? 'text-stone-500' : m.source === 'manual' ? 'text-stone-500' : 'text-amber-700'}`}>
                    {m.matched ? (m.source === 'manual' ? 'Matched by you' : 'Matched') : m.source === 'manual' ? 'Not syncing' : 'Not matched'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setPicking(picking === m.id ? null : m.id)}
                  className="h-8 shrink-0 rounded-full px-3 text-sm font-semibold text-brand-600 ring-1 ring-brand-200 active:bg-brand-50"
                >
                  {picking === m.id ? 'Cancel' : m.matched ? 'Change' : 'Match'}
                </button>
              </div>
              {m.push_note && <p className="mt-1 text-xs text-amber-700">{m.push_note}</p>}
              {picking === m.id && (
                <Picker
                  session={session}
                  id={m.id}
                  name={m.name}
                  book={book}
                  onDone={() => {
                    setPicking(null)
                    reload()
                  }}
                />
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  )
}

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
    <Card className="relative mt-4 p-4">
      <ViaHardcover slug={book.hardcover_slug} />
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
function NextInSeries({ book, data }) {
  const next = data.next
  // Title only: many OPDS catalogs (Mayberry included) match the whole query against
  // titles, so adding the author turns a hit into no results.
  const query = next.title
  return (
    <div className="px-4 py-3">
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
          {isApp && (
            <a
              href={`#/browse/search/${encodeURIComponent(query)}`}
              className="mt-2 inline-flex h-9 items-center gap-1.5 rounded-full bg-brand-500 px-3.5 text-xs font-semibold text-white transition active:scale-[0.98]"
            >
              <Search className="size-3.5" strokeWidth={2.25} /> Find it in your catalogs
            </a>
          )}
        </div>
      </div>
    </div>
  )
}

const seriesLabel = (b) =>
  b.series ? `${b.series}${b.series_position ? ` · Book ${Number.isInteger(b.series_position) ? b.series_position : b.series_position.toFixed(1)}` : ''}` : null

export default function Book({ session, book, books, activity, back = { href: '#/', label: 'Library' }, onChange }) {
  const wide = useWide()
  if (!book) return <p className="py-16 text-center text-sm text-stone-500">Book not found.</p>
  return (
    <div className="px-4 pt-4 pb-6 md:px-8 md:pt-6 lg:px-12">
      <div className="-mr-2 flex h-11 items-center">
        <a
          href={back.href}
          className="-ml-2 flex h-11 items-center gap-1.5 rounded-full pr-4 pl-2 text-lg font-semibold text-brand-600 transition active:bg-stone-200/70 md:hover:bg-stone-100"
        >
          <ArrowLeft className="size-6" strokeWidth={2} /> {back.label}
        </a>
        <BookMenu key={`${book.document}-${book.page_count}`} session={session} book={book} books={books} activity={activity} onChange={onChange} />
      </div>
      {/* One column at every size: the book up top, its cards two-up on wide screens, clippings below. */}
      <div className="md:mt-4">
        <div>
          {/* Phone: cover beside the title, status buttons full width below. Wider: status sits under the title, beside the cover. */}
          <div className="relative mt-3 grid grid-cols-[7rem_1fr] gap-x-4 md:mt-0 md:grid-cols-[11rem_1fr] md:grid-rows-[auto_1fr] md:gap-x-8 lg:grid-cols-[13rem_1fr]">
            <Cover session={session} book={book} className="w-full md:row-span-2" />
            <div className="min-w-0 pt-1 md:pt-0">
              <h1 className="font-display text-2xl/tight font-semibold md:text-3xl/tight tracking-tight text-balance text-stone-900">
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
              {wide && <Stats session={session} doc={book.document} aliases={book.aliases} activity={activity} wide />}
            </div>
            <div className="col-span-2 mt-6 md:col-span-1 md:col-start-2 md:self-end">
              <StatusPicker session={session} book={book} onChange={onChange} />
            </div>
          </div>
          <About session={session} book={book} />
          {/* Cards flow two-up; spacing moves to the bottom so a column break can't eat a top margin. */}
          <div className="md:mt-4 md:columns-2 md:gap-4 md:[&>*]:mt-0 md:[&>*]:mb-4 [&>*]:break-inside-avoid">
            <Details book={book} />
            {!wide && <Stats session={session} doc={book.document} aliases={book.aliases} activity={activity} />}
            <SpotifyCard session={session} book={book} />
            <Services session={session} book={book} />
          </div>
        </div>

        <section>
          <h2 className="mt-8 mb-3 font-display text-xl font-semibold text-stone-900 md:mt-6 md:text-2xl">Clippings</h2>
          <Clippings session={session} book={book} />
        </section>
      </div>
    </div>
  )
}
