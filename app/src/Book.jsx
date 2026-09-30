import { useEffect, useState } from 'react'
import { ArrowLeft, Copy, Download, Share2, X } from 'lucide-react'
import { api } from './api.js'
import { PLATFORMS, canShareNatively, copyImage, postTo, renderCard, saveImage, shareNatively } from './shareCard.js'
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

// Preview of a clipping's share card, then the native share sheet.
function ShareSheet({ session, book, clip, onClose }) {
  const [card, setCard] = useState(null) // { blob, url }
  const [status, setStatus] = useState(null)
  const meta = { quote: clip.text, title: book.title || book.filename, author: book.author, chapter: clip.chapter }

  useEffect(() => {
    let url
    let live = true
    ;(async () => {
      const coverUrl = book.cover_url ?? (await api.cover(session, book.document).then((r) => r.url, () => null))
      const blob = await renderCard({ ...meta, coverUrl })
      url = URL.createObjectURL(blob)
      if (live) setCard({ blob, url })
    })().catch(() => live && setStatus({ error: "Couldn't make the share card." }))
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id])

  const native = card && canShareNatively(card.blob)
  const desktop = !/android|iphone|ipad/i.test(navigator.userAgent)
  async function act(fn, done) {
    setStatus({ busy: true })
    try {
      const note = await fn()
      setStatus(note ? { note: done(note) } : null)
    } catch (e) {
      if (e?.name !== 'AbortError') setStatus({ error: "That didn't work on this device." })
      else setStatus(null)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center md:items-center">
      <div className="absolute inset-0 bg-stone-950/40" onClick={onClose} />
      <div className="relative max-h-[92dvh] w-full overflow-y-auto rounded-t-[28px] bg-stone-50 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:max-w-md md:rounded-[28px] md:p-6">
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-stone-300 md:hidden" />
        <button onClick={onClose} className="absolute top-3 right-3 grid size-10 place-items-center rounded-full text-stone-500 active:bg-stone-200" aria-label="Close">
          <X className="size-5" />
        </button>
        <h2 className="font-display text-xl font-semibold text-stone-900">Share clipping</h2>
        <div className="mx-auto mt-4 aspect-[4/5] w-full max-w-72 overflow-hidden rounded-xl shadow-lg ring-1 ring-stone-950/10">
          {card ? <img src={card.url} alt="Share card preview" className="size-full" /> : <div className="grid size-full place-items-center bg-[#f5f4ef]"><Spinner /></div>}
        </div>

        {native && (
          <button
            disabled={status?.busy}
            onClick={() => act(() => shareNatively(card.blob, meta).then(() => null), () => null)}
            className="mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 text-base font-semibold text-white shadow-sm active:scale-[0.98] disabled:opacity-60"
          >
            <Share2 className="size-5" /> Share
          </button>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            disabled={!card || status?.busy}
            onClick={() => act(() => copyImage(card.blob, meta).then((ok) => (ok ? 'copied' : 'nocopy')), (r) => (r === 'copied' ? 'Image copied to the clipboard.' : "This device can't copy images; use Save instead."))}
            className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-white text-sm font-semibold text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100 disabled:opacity-50"
          >
            <Copy className="size-4" /> Copy image
          </button>
          <button
            disabled={!card || status?.busy}
            onClick={() => act(() => saveImage(card.blob, meta).then(() => 'saved'), () => (desktop ? 'Saved to your Downloads folder.' : 'Image saved.'))}
            className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-white text-sm font-semibold text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100 disabled:opacity-50"
          >
            <Download className="size-4" /> Save image
          </button>
        </div>

        {desktop && (
          <>
            <p className="mt-5 text-xs font-medium text-stone-500">Post to</p>
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {PLATFORMS.map((p) => (
                <button
                  key={p.id}
                  disabled={!card || status?.busy}
                  onClick={() =>
                    act(
                      () => postTo(p, card.blob, meta).then((copied) => (copied ? 'posted' : 'posted-nocopy')),
                      (r) => (r === 'posted' ? `Image copied. Paste it into your ${p.name} post.` : `Opened ${p.name}. Save the image to attach it.`)
                    )
                  }
                  className="h-11 rounded-xl bg-white text-sm font-semibold text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100 disabled:opacity-50 md:hover:bg-stone-100"
                >
                  {p.name}
                </button>
              ))}
            </div>
          </>
        )}

        {(status?.note || status?.error) && (
          <p className={`mt-4 text-center text-sm ${status.error ? 'text-red-600' : 'text-stone-600'}`}>{status.note ?? status.error}</p>
        )}
      </div>
    </div>
  )
}

function Clippings({ session, book }) {
  const [items, error] = useLoad(() => api.clippings(session, book.document), [session, book.document])
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
      {sharing && <ShareSheet session={session} book={book} clip={sharing} onClose={() => setSharing(null)} />}
    </div>
  )
}

export default function Book({ session, book, activity, onChange }) {
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
          <Clippings session={session} book={book} />
        </section>
      </div>
    </div>
  )
}
