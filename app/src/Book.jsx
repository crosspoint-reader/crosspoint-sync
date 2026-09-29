import { useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { api } from './api.js'
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
          className={`flex items-center justify-center gap-2 rounded-md px-3 py-2.5 text-sm font-semibold transition disabled:opacity-60 ${
            book.status === s.id
              ? 'bg-brand-500 text-white shadow-sm'
              : 'bg-white text-stone-700 shadow-sm ring-1 ring-stone-950/10 active:bg-stone-50'
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
  const [data] = useLoad(() => api.bookStats(session, doc), [session, doc])
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
        <div key={l} className="bg-white px-4 py-3">
          <p className="text-xs text-stone-500">{l}</p>
          <p className="mt-0.5 font-display text-lg font-semibold text-stone-900">{v}</p>
        </div>
      ))}
    </Card>
  )
}

function Clippings({ session, doc }) {
  const [items, error] = useLoad(() => api.clippings(session, doc), [session, doc])
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
              <p className="mt-2 text-right font-mono text-[0.65rem] text-stone-400">{date(c.created_at)}</p>
            </Card>
          </div>
        )
      })}
    </div>
  )
}

export default function Book({ session, book, activity, onChange }) {
  if (!book) return <p className="py-16 text-center text-sm text-stone-500">Book not found.</p>
  return (
    <div className="px-4 pt-4 pb-6 md:px-8 md:pt-8 lg:px-12">
      {/* Top bar: same 44px row as the account avatar (top-4, size-11) so they line up. */}
      <div className="flex h-11 items-center pr-12 md:pr-0">
        <a
          href="#/"
          className="-ml-2 flex h-11 items-center gap-1.5 rounded-full pr-4 pl-2 text-lg font-semibold text-brand-600 transition active:bg-stone-200/70 md:hover:bg-stone-100"
        >
          <ArrowLeft className="size-6" strokeWidth={2} /> Library
        </a>
      </div>
      <div className="md:mt-4 md:grid md:grid-cols-[15rem_1fr] md:items-start md:gap-10 lg:grid-cols-[18rem_1fr] lg:gap-14">
        <aside className="md:sticky md:top-8">
          <div className="relative mt-3 flex gap-4 md:mt-0 md:flex-col md:gap-5">
            <Cover session={session} book={book} className="w-28 md:w-full" />
            <div className="min-w-0 flex-1 pt-1 md:pt-0">
              <h1 className="font-display text-2xl/tight font-semibold tracking-tight text-balance text-stone-900">
                {book.title || book.filename || 'Untitled book'}
              </h1>
              <p className="mt-1 text-sm text-stone-500">{book.author}</p>
              <p className="mt-3 font-mono text-xs text-stone-500">
                <span className="font-semibold text-brand-600">{pct(book.percentage)}</span> · {book.device || book.device_id} · {ago(book.timestamp)}
              </p>
              <ProgressBar value={book.percentage} className="mt-2" />
            </div>
          </div>
          <div className="mt-6">
            <StatusPicker session={session} book={book} onChange={onChange} />
          </div>
          <Stats session={session} doc={book.document} activity={activity} />
        </aside>

        <section className="md:max-w-2xl">
          <h2 className="mt-8 mb-3 font-display text-xl font-semibold text-stone-900 md:mt-0 md:text-2xl">Clippings</h2>
          <Clippings session={session} doc={book.document} />
        </section>
      </div>
    </div>
  )
}
