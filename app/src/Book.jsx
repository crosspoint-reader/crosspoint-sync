import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, CalendarDays, MoreHorizontal, PenLine, Split, Trash2, Image as ImageIcon, Loader2, Merge, Quote, Search, Star, X } from 'lucide-react'
import { api, isApp } from './api.js'
import { renderCard } from './shareCard.js'
import { isPace, moodEmoji } from './moods.js'
import ShareSheet from './ShareSheet.jsx'
import { useNativeBack, useNativeButton } from './tabbar.js'
import SpotifyCard from './SpotifyCard.jsx'
import { Picker } from './Settings.jsx'
import { STATUS, ActionSheet, Card, Cover, EmptyState, ErrorNote, ProgressBar, ShareIcon, Sheet, Spinner, ViaHardcover, ago, duration, notify, pct, useLoad } from './ui.jsx'

const date = (unix, opts) =>
  unix ? new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric', ...opts }) : null
// CrossInk stats dates are calendar dates sent as UTC midnight: show them in UTC so they don't slip a day.
const calendarDate = (unix) => date(unix, { timeZone: 'UTC' })

function StatusPicker({ session, book, onChange }) {
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)
  async function pick(id) {
    setBusy(id)
    setError(null)
    try {
      await api.setStatus(session, book.document, id)
      onChange()
    } catch (err) {
      setError(err.message || "Couldn’t update reading status. Try again.")
    } finally {
      setBusy(null)
    }
  }
  return (
    <div>
      <label className="flex min-h-11 items-center justify-between gap-4 border-y border-stone-200 py-2 text-sm text-stone-500">
        Reading status
        <select
          value={book.status}
          disabled={busy !== null}
          onChange={(e) => pick(e.target.value)}
          className="min-h-11 max-w-full rounded-lg bg-transparent px-2 text-base font-medium text-brand-700 disabled:opacity-60"
        >
          {STATUS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      {busy && <p role="status" className="mt-2 text-sm text-stone-500">Saving status…</p>}
      {error && <p role="alert" className="mt-2 text-sm text-red-700">{error}</p>}
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

function Stats({ session, doc, aliases, activity: a, wide = false, revision = 0 }) {
  // Merging or separating copies changes which stats count, so refetch then.
  const [data] = useLoad(() => api.bookStats(session, doc), [session, doc, aliases?.join(), revision], `bookstats:${doc}`)
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

function Clippings({ session, book, revision = 0 }) {
  const [items, error, reload] = useLoad(() => api.clippings(session, book.document), [session, book.document, revision], `clips:${book.document}`)
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
            {heading && <p className="mt-5 mb-2 text-sm font-medium text-stone-500">{heading}</p>}
            <article className="group relative border-b border-stone-200 py-5 md:pr-8 select-none [-webkit-touch-callout:none]" {...hold(() => setDeleting(c))}>
              <ClipMenu onDelete={() => setDeleting(c)} />
              <blockquote className="font-display text-lg/relaxed text-stone-800">
                {c.text}
              </blockquote>
              {c.note && <p className="mt-3 font-hand text-lg/6 text-brand-700">{c.note}</p>}
              <div className="mt-2 flex items-center justify-between">
                <button
                  onClick={() => setSharing(c)}
                  className="-ml-2 flex h-9 items-center gap-1.5 rounded-full px-2 text-sm font-medium text-brand-600 active:bg-stone-100"
                  aria-label="Share clipping"
                >
                  <ShareIcon className="size-4" /> Share
                </button>
                <p className="text-xs text-stone-500">{date(c.created_at)}</p>
              </div>
            </article>
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

// Letters, marks and digits of every script: an ASCII-only pattern reduces Japanese titles to their
// digits, and dropping marks merges Thai or Hindi words that differ only in a tone or vowel sign.
const norm = (s) => (s ?? '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()
// Same normalized title (and author when both have one): probably the same book synced twice.
export const looksLikeSame = (a, b) =>
  a.document !== b.document && norm(a.title) && norm(a.title) === norm(b.title) && (!a.author || !b.author || norm(a.author) === norm(b.author))

// First book that looks like another copy of itself, in one pass: per title, how many books
// have each author and how many have none (looksLikeSame's rules, without comparing every pair).
export function firstDuplicate(books) {
  const byTitle = new Map()
  for (const b of books) {
    const t = norm(b.title)
    if (!t) continue
    if (!byTitle.has(t)) byTitle.set(t, { size: 0, noAuthor: 0, authors: new Map() })
    const g = byTitle.get(t)
    g.size++
    if (!b.author) g.noAuthor++
    else g.authors.set(norm(b.author), (g.authors.get(norm(b.author)) ?? 0) + 1)
  }
  return books.find((b) => {
    const g = byTitle.get(norm(b.title))
    if (!g || g.size < 2) return false
    return !b.author || g.noAuthor > 0 || g.authors.get(norm(b.author)) > 1
  })
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
  const [selected, setSelected] = useState(null)
  const [stats, setStats] = useState(true)
  const [query, setQuery] = useState('')
  // Syncs with no title or filename (e.g. KOReader on a binary hash) are hidden from
  // the library; list them here, newest first, so they can be folded into the real book.
  const [untitled] = useLoad(() => api.untitledBooks(session).catch(() => []), [session], 'untitled books')
  const others = books
    .filter((b) => b.document !== book.document)
    .sort((a, b) => Number(looksLikeSame(book, b)) - Number(looksLikeSame(book, a)) || (a.title ?? '').localeCompare(b.title ?? ''))
    .concat([...(untitled ?? [])].sort((a, b) => b.timestamp - a.timestamp))
  // Matched the way duplicates are, so any script, width or case finds the book.
  const q = norm(query)
  const shown = q ? others.filter((b) => [b.title, b.author, b.filename].some((v) => norm(v).includes(q))) : others
  if (selected) {
    const what = selected.stats ? 'progress, clippings and reading stats' : 'progress and clippings'
    return (
      <ActionSheet title={`Merge "${selected.book.title || selected.book.filename || 'Untitled book'}" into this book?`} actionLabel="Merge" pendingLabel="Merging…" onClose={() => setSelected(null)} onConfirm={async () => {
        await api.merge(session, selected.book.document, book.document, selected.stats)
        onDone()
      }}>
        Its {what} move here, and future syncs of it land here too.
      </ActionSheet>
    )
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
      <input
        className={`${field} mt-4 scroll-mt-4`}
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search title, author or file"
        aria-label="Search books"
        autoCapitalize="none"
        autoCorrect="off"
      />
      {shown.length === 0 && <p className="mt-4 text-center text-sm text-stone-500">No book matches.</p>}
      <Card className="mt-4 divide-y divide-stone-100">
        {shown.map((b) => (
          <button key={b.document} onClick={() => setSelected({ book: b, stats })} className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-stone-50">
            <Cover session={session} book={b} small className="w-9" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold text-stone-900">{b.title || b.filename || 'Untitled book'}</p>
              <p className="truncate text-xs text-stone-500">
                {[b.author, pct(b.percentage), b.device, !b.title && !b.filename && b.timestamp && `synced ${ago(b.timestamp)}`].filter(Boolean).join(' · ')}
              </p>
            </div>
            {looksLikeSame(book, b) && <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-[0.65rem] font-semibold text-brand-700">Likely duplicate</span>}
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
        Only the start and finish days are added to your reading grid.
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

// Lists Hardcover fills in, with the server's limits (API.md: PUT /documents/{document}/info).
const LIST_FIELDS = [
  { key: 'genres', label: 'Genres', max: 10, placeholder: 'Add a genre' },
  { key: 'moods', label: 'Moods', max: 12, placeholder: 'Add a mood' },
  { key: 'content_warnings', label: 'Content warnings', max: 12, placeholder: 'Add a warning' },
]

function ChipField({ label, items, onChange, max, placeholder }) {
  const [draft, setDraft] = useState('')
  const full = items.length >= max
  function add() {
    const name = draft.trim().slice(0, 64)
    if (!name || full) return
    if (!items.some((i) => i.toLowerCase() === name.toLowerCase())) onChange([...items, name])
    setDraft('')
  }
  return (
    <div>
      <p className="text-sm font-medium text-stone-700">{label}</p>
      {items.length > 0 && (
        <ul className="mt-1.5 flex flex-wrap gap-2" aria-label={label}>
          {items.map((name) => (
            <li key={name} className="flex items-center gap-1 rounded-full bg-stone-100 py-1 pr-1 pl-3 text-sm text-stone-800">
              {name}
              <button type="button" aria-label={`Remove ${name}`} onClick={() => onChange(items.filter((i) => i !== name))} className="grid size-7 place-items-center rounded-full text-stone-500 active:bg-stone-200">
                <X className="size-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1.5 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add()
            }
          }}
          onBlur={add}
          disabled={full}
          placeholder={full ? `Up to ${max}` : placeholder}
          aria-label={placeholder}
          enterKeyHint="done"
          className={field}
        />
        <button type="button" onClick={add} disabled={full || !draft.trim()} className="h-11 shrink-0 rounded-xl px-4 text-sm font-semibold text-brand-600 ring-1 ring-stone-950/10 disabled:opacity-40">
          Add
        </button>
      </div>
    </div>
  )
}

const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

// Every detail but the cover and reading dates, in one form. Only changed fields are sent: an emptied list or
// description is saved empty, while a cleared series, year or page count goes back to the lookup. A new title
// sticks over later device syncs and the cover and catalog details are looked up again with it.
function EditDetailsSheet({ session, book: current, onDone, onClose }) {
  const [book] = useState(current) // the values the form opened with, so a background refresh is not saved as an edit
  const [about] = useLoad(() => api.about(session, book.document), [book.document], `about ${book.document}`)
  const [title, setTitle] = useState(book.title ?? '')
  const [author, setAuthor] = useState(book.author ?? '')
  const [lists, setLists] = useState(() => Object.fromEntries(LIST_FIELDS.map((f) => [f.key, book[f.key] ?? []])))
  const [description, setDescription] = useState(null) // null until edited: the stored one loads separately
  const [series, setSeries] = useState(book.series ?? '')
  const [position, setPosition] = useState(book.series_position ?? '')
  const [year, setYear] = useState(book.release_year ?? '')
  const [pages, setPages] = useState(book.page_count ?? '')
  const [saving, setSaving] = useState(false)
  const shownDescription = description ?? about?.description ?? ''

  async function save(e) {
    e.preventDefault()
    const titleChanged = title.trim() !== (book.title ?? '')
    if (titleChanged && !title.trim()) return notify({ error: true, title: 'A title is needed' })
    const n = String(position).trim() === '' ? null : Number(String(position).replace(',', '.'))
    if (n !== null && !(n >= 0 && n <= 10000)) return notify({ error: true, title: 'The series number is from 0 to 10000' })
    const y = String(year).trim() === '' ? null : parseInt(year, 10)
    if (y !== null && !(y >= 1 && y <= 9999)) return notify({ error: true, title: 'Enter a release year' })
    const p = String(pages).trim() === '' ? null : parseInt(pages, 10)
    if (p !== null && !(p > 0 && p <= 100000)) return notify({ error: true, title: 'Enter the number of pages' })

    const patch = {}
    if (titleChanged) patch.title = title.trim()
    if (author.trim() !== (book.author ?? '')) patch.author = author.trim()
    for (const f of LIST_FIELDS) if (!sameList(lists[f.key], book[f.key] ?? [])) patch[f.key] = lists[f.key]
    if (description !== null && description.trim() !== (about?.description ?? '')) patch.description = description.trim()
    if (series.trim() !== (book.series ?? '') || n !== (book.series_position ?? null)) Object.assign(patch, series.trim() ? { series: series.trim(), series_position: n } : { series: null })
    if (y !== (book.release_year ?? null)) patch.release_year = y
    if (p !== (book.page_count ?? null)) patch.page_count = p
    if (!Object.keys(patch).length) return onClose()

    setSaving(true)
    try {
      await api.setInfo(session, book.document, patch)
      notify(patch.title !== undefined || patch.author !== undefined ? { title: 'Saved', detail: 'Looking up the cover and details again.' } : { title: 'Saved' })
      onDone()
    } catch (err) {
      notify({ error: true, title: "Couldn't save", detail: err.message })
      setSaving(false)
    }
  }

  const label = 'block text-sm font-medium text-stone-700'
  return (
    <Sheet title="Edit details" onClose={onClose}>
      <form onSubmit={save} className="mt-4 space-y-4">
        <label className={label}>
          Title
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={`${field} mt-1.5`} />
        </label>
        <label className={label}>
          Author
          <input value={author} onChange={(e) => setAuthor(e.target.value)} className={`${field} mt-1.5`} />
        </label>
        {LIST_FIELDS.map((f) => (
          <ChipField key={f.key} label={f.label} max={f.max} placeholder={f.placeholder} items={lists[f.key]} onChange={(items) => setLists({ ...lists, [f.key]: items })} />
        ))}
        <label className={label}>
          Description
          <textarea value={shownDescription} onChange={(e) => setDescription(e.target.value.slice(0, 6000))} rows={6} className={`${field} mt-1.5 h-auto py-2.5 leading-6`} />
        </label>
        <div className="grid grid-cols-[1fr_6rem] gap-3">
          <label className={label}>
            Series
            <input value={series} onChange={(e) => setSeries(e.target.value)} maxLength={200} className={`${field} mt-1.5`} />
          </label>
          <label className={label}>
            Number
            <input value={position} onChange={(e) => setPosition(e.target.value.replace(/[^\d.,]/g, ''))} inputMode="decimal" placeholder="e.g. 2" className={`${field} mt-1.5`} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className={label}>
            Release year
            <input value={year} onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))} inputMode="numeric" placeholder="e.g. 1945" className={`${field} mt-1.5`} />
          </label>
          <label className={label}>
            Print pages
            <input value={pages} onChange={(e) => setPages(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="e.g. 384" className={`${field} mt-1.5`} />
          </label>
        </div>
        <button disabled={saving} className="flex h-11 w-full items-center justify-center rounded-xl bg-brand-500 text-sm font-semibold text-white disabled:opacity-60">
          {saving ? <Loader2 className="size-4 animate-spin" /> : 'Save'}
        </button>
      </form>
    </Sheet>
  )
}

function BookMenu({ session, book, books, activity, onChange }) {
  const [action, setAction] = useState(null)
  const [open, setOpen] = useState(null) // 'edit' | 'cover' | 'dates' | 'merge'
  const [menu, setMenu] = useState(false)
  useNativeButton('more', { sfSymbol: 'ellipsis', anchor: 'topTrailing' }, () => setMenu((m) => !m))
  const dupes = books.filter((b) => looksLikeSame(book, b)).length
  const done = () => {
    setOpen(null)
    onChange()
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
        className="native-hide grid size-11 place-items-center rounded-full text-stone-600 transition active:bg-stone-200/70 md:hover:bg-stone-100"
      >
        <MoreHorizontal className="size-6" />
      </button>
      {menu && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
          <div role="menu" className="native-menu absolute top-12 right-0 z-30 w-64 divide-y divide-stone-100 overflow-hidden rounded-xl bg-surface shadow-lg ring-1 ring-stone-950/10">
            {item(PenLine, 'Edit details', () => setOpen('edit'))}
            {item(ImageIcon, 'Change cover', () => setOpen('cover'))}
            {item(CalendarDays, 'Reading dates', () => setOpen('dates'))}
            {item(
              Merge,
              'Merge a duplicate',
              () => setOpen('merge'),
              dupes > 0 && <span className="ml-auto rounded-full bg-brand-50 px-2 py-0.5 text-[0.65rem] font-semibold text-brand-700">{dupes} likely</span>
            )}
            {book.aliases?.length > 0 &&
              item(Split, book.aliases.length === 1 ? 'Separate merged copy' : `Separate ${book.aliases.length} merged copies`, () => setAction({ kind: 'separate', aliases: [...book.aliases] }))}
            {item(Trash2, 'Remove from library', () => setAction({ kind: 'remove', document: book.document, title: book.title }), null, true)}
          </div>
        </>
      )}
      {action && (
        <ActionSheet
          title={action.kind === 'separate' ? 'Separate merged copies?' : `Remove "${action.title || 'this book'}" from your library?`}
          actionLabel={action.kind === 'separate' ? 'Separate' : 'Remove'}
          pendingLabel={action.kind === 'separate' ? 'Separating…' : 'Removing…'}
          danger={action.kind === 'remove'}
          onClose={() => setAction(null)}
          onConfirm={async () => {
            if (action.kind === 'separate') {
              for (const alias of action.aliases) {
                await api.unmerge(session, alias)
                // Retry only the remaining copies if a later request fails.
                setAction((current) => ({ ...current, aliases: current.aliases.filter((id) => id !== alias) }))
              }
            } else {
              await api.removeBook(session, action.document)
              location.hash = '#/'
            }
            onChange()
          }}
        >
          {action.kind === 'separate'
            ? 'Future syncs from the separated copies will show as their own books.'
            : 'Its progress, clippings and stats are deleted. A reader that still has it will sync it again.'}
        </ActionSheet>
      )}
      {open === 'cover' && <CoverPicker session={session} book={book} onDone={done} onClose={() => setOpen(null)} />}
      {open === 'dates' && <DatesSheet session={session} book={book} activity={activity} onDone={done} onClose={() => setOpen(null)} />}
      {open === 'merge' && <MergePicker session={session} book={book} books={books} onDone={done} onClose={() => setOpen(null)} />}
      {open === 'edit' && <EditDetailsSheet session={session} book={book} onDone={done} onClose={() => setOpen(null)} />}
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
function Services({ session, book, onSync }) {
  const done = book.status === 'finished' || book.percentage >= 0.9
  const [series] = useLoad(() => (book.series && done ? api.next(session, book.document) : Promise.resolve(null)), [book.document, done], `next ${book.document}`)
  const [data, , reload] = useLoad(() => api.bookMatches(session, book.document), [book.document], `matches ${book.document}`)
  const [picking, setPicking] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState(null)
  const [syncResult, setSyncResult] = useState(null)
  async function sync(m) {
    setSyncing(m.id)
    setSyncError(null)
    setSyncResult(null)
    try {
      const result = await api.syncBook(session, m.id, book.document)
      setSyncResult({ id: m.id, text: result.history_pending ? 'Progress and clippings updated. More history remains; sync again to continue.' :
        result.queued ? (m.sync.read ? `Updated from ${m.name}. Outgoing updates queued.` : 'Outgoing updates queued.') :
        m.sync.read ? `Updated from ${m.name}.` : 'No updates to send.' })
      onSync()
    } catch (err) {
      setSyncError({ id: m.id, text: err.message || 'Couldn’t sync this book. Try again.' })
    } finally {
      setSyncing(false)
    }
  }
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
                    {m.matched ? (m.match_by === 'document' ? 'Linked by document' : m.source === 'manual' ? 'Matched by you' : 'Matched') : m.source === 'manual' ? 'Not syncing' : 'Not matched'}
                  </p>
                </div>
                {m.match_by !== 'document' && <button
                  type="button"
                  onClick={() => setPicking(picking === m.id ? null : m.id)}
                  className="h-8 shrink-0 rounded-full px-3 text-sm font-semibold text-brand-600 ring-1 ring-brand-200 active:bg-brand-50"
                >
                  {picking === m.id ? 'Cancel' : m.matched ? 'Change' : 'Match'}
                </button>}
              </div>
              {m.push_note && <p className="mt-1 text-xs text-amber-700">{m.push_note}</p>}
              {m.matched && m.sync?.enabled && (m.sync.read || m.sync.write) && (
                <div className="mt-3">
                  <button type="button" disabled={!!syncing} onClick={() => sync(m)}
                    className="inline-flex min-h-11 items-center gap-2 rounded-full px-4 text-sm font-semibold text-brand-600 ring-1 ring-brand-200 disabled:opacity-60">
                    {syncing === m.id && <Loader2 aria-hidden="true" className="size-4 animate-spin" />}
                    {syncing === m.id ? 'Syncing…' : 'Sync now'}
                  </button>
                  <p className="mt-2 text-xs text-stone-500">{m.sync.read ? (m.sync.write ? 'Pulls this book’s latest data, then queues outgoing updates.' : 'Pulls this book’s latest updates.') : 'Queues this book’s updates for this service.'}</p>
                  {syncResult?.id === m.id && <p role="status" className="mt-2 text-xs text-stone-600">{syncResult.text}</p>}
                  {syncError?.id === m.id && <p role="alert" className="mt-2 text-xs text-red-700">{syncError.text}</p>}
                </div>
              )}
              {picking === m.id && (
                <Picker
                  session={session}
                  id={m.id}
                  name={m.name}
                  book={book}
                  onDone={() => {
                    setPicking(null)
                    reload()
                    onSync() // the Spotify card follows a changed match
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

function About({ session, book, revision }) {
  const [data] = useLoad(() => api.about(session, book.document), [book.document, revision], `about ${book.document}`)
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
      {!data.manual && <ViaHardcover slug={book.hardcover_slug} />}
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
  const [revision, setRevision] = useState(0)
  const synced = () => { setRevision((n) => n + 1); onChange() }
  useNativeBack(back.href)
  if (!book) return <p className="py-16 text-center text-sm text-stone-500">Book not found.</p>
  return (
    <div className="px-4 pt-6 pb-6 md:px-8 md:pt-6 lg:px-12">
      <div className="-mr-2 mb-6 flex h-11 items-center md:mb-0">
        <a
          href={back.href}
          className="native-hide -ml-2 flex h-11 items-center gap-1.5 rounded-full pr-4 pl-2 text-lg font-semibold text-brand-600 transition active:bg-stone-200/70 md:hover:bg-stone-100"
        >
          <ArrowLeft className="size-6" strokeWidth={2} /> {back.label}
        </a>
        <BookMenu key={book.document} session={session} book={book} books={books} activity={activity} onChange={synced} />
      </div>
      {/* One column at every size: the book up top, its cards two-up on wide screens, clippings below. */}
      <div className="md:mt-4">
        <div>
          {/* Phone: cover beside the title, status buttons full width below. Wider: status sits under the title, beside the cover. */}
          <div className="relative grid grid-cols-[7rem_1fr] gap-x-4 md:mt-0 md:grid-cols-[11rem_1fr] md:grid-rows-[auto_1fr] md:gap-x-8 lg:grid-cols-[13rem_1fr]">
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
              {wide && <Stats session={session} doc={book.document} aliases={book.aliases} activity={activity} wide revision={revision} />}
            </div>
            <div className="col-span-2 mt-6 md:col-span-1 md:col-start-2 md:self-end">
              <StatusPicker session={session} book={book} onChange={onChange} />
            </div>
          </div>
          <About session={session} book={book} revision={revision} />
          {/* Cards two-up in a grid, so the rest reflow when one (Spotify) drops out. */}
          <div className="md:mt-4 md:grid md:grid-cols-2 md:items-start md:gap-4 md:[&>*]:mt-0">
            <Details book={book} />
            {!wide && <Stats session={session} doc={book.document} aliases={book.aliases} activity={activity} revision={revision} />}
            <SpotifyCard session={session} book={book} onChange={onChange} revision={revision} />
            <Services key={book.document} session={session} book={book} onSync={synced} />
          </div>
        </div>

        <section>
          <h2 className="mt-8 mb-3 font-display text-xl font-semibold text-stone-900 md:mt-6 md:text-2xl">Clippings</h2>
          <Clippings session={session} book={book} revision={revision} />
        </section>
      </div>
    </div>
  )
}
