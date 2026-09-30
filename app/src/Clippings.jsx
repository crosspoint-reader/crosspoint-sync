import { useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { Copy, FileDown, Search, Share2 } from 'lucide-react'
import { api, isApp } from './api.js'
import { ClipShare } from './Book.jsx'
import { Card, Cover, ErrorNote, Eyebrow, Spinner, useLoad } from './ui.jsx'

const date = (unix) => new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

// Same clipping all day, a different one tomorrow.
function ofTheDay(items) {
  const d = new Date()
  const seed = d.getFullYear() * 400 + d.getMonth() * 31 + d.getDate()
  return items[(seed * 2654435761) % items.length]
}

function markdown(groups) {
  return groups
    .map(({ book, clips }) =>
      [
        `## ${book.title || book.filename}${book.author ? ` by ${book.author}` : ''}`,
        ...clips.map((c) => [`> ${c.text.replace(/\n/g, '\n> ')}`, c.note ? `\n${c.note}` : '', c.chapter ? `\n*${c.chapter}*` : ''].join('')),
      ].join('\n\n')
    )
    .join('\n\n---\n\n')
}

function Clip({ session, clip, book, onShare, showBook }) {
  return (
    <Card className="p-4">
      {showBook && (
        <a href={`#/book/${book.document}`} className="mb-3 flex items-center gap-3">
          <Cover session={session} book={book} small className="w-8" />
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-stone-900">{book.title || book.filename}</p>
            <p className="truncate text-xs text-stone-500">{book.author}</p>
          </div>
        </a>
      )}
      <blockquote className="border-l-2 border-brand-300 pl-3 font-display text-[0.95rem]/relaxed text-stone-800 italic">{clip.text}</blockquote>
      {clip.note && <p className="mt-3 font-hand text-lg/6 text-brand-700">{clip.note}</p>}
      <div className="mt-2 flex items-center justify-between gap-3">
        <button onClick={() => onShare(clip)} className="-ml-2 flex h-9 items-center gap-1.5 rounded-full px-2 text-sm font-medium text-brand-600 active:bg-stone-100">
          <Share2 className="size-4" /> Share
        </button>
        <p className="truncate font-mono text-[0.65rem] text-stone-400">{[clip.chapter, date(clip.created_at)].filter(Boolean).join(' · ')}</p>
      </div>
    </Card>
  )
}

export default function Clippings({ session, books }) {
  const [items, error] = useLoad(() => api.allClippings(session, books), [session], `clippings:${session.username}`)
  const [query, setQuery] = useState('')
  const [only, setOnly] = useState(null) // document
  const [sharing, setSharing] = useState(null)
  const [note, setNote] = useState(null)
  const byDoc = useMemo(() => new Map(books.map((b) => [b.document, b])), [books])

  // Only clippings of books the library shows (metadata-less ones are hidden everywhere).
  const all = (items ?? []).filter((c) => byDoc.has(c.document))
  const q = query.trim().toLowerCase()
  const matches = all.filter((c) => {
    if (only && c.document !== only) return false
    if (!q) return true
    const b = byDoc.get(c.document)
    return [c.text, c.note, b.title, b.author].some((s) => s?.toLowerCase().includes(q))
  })
  const groups = [...new Set(matches.map((c) => c.document))].map((doc) => ({ book: byDoc.get(doc), clips: matches.filter((c) => c.document === doc) }))
  const counts = all.reduce((m, c) => m.set(c.document, (m.get(c.document) ?? 0) + 1), new Map())
  const daily = all.length ? ofTheDay(all) : null

  async function exportMd(save) {
    const md = `# Clippings\n\n${markdown(groups)}\n`
    if (save) {
      await invoke('save_file', new TextEncoder().encode(md), { headers: { 'x-name': encodeURIComponent('CrossPoint clippings.md') } })
      setNote('Saved to your Downloads folder.')
    } else {
      await navigator.clipboard.writeText(md)
      setNote(`Copied ${matches.length} clipping${matches.length === 1 ? '' : 's'} as Markdown.`)
    }
  }

  return (
    <div className="px-4 pt-6 pb-4 md:px-8 md:pt-6 lg:px-12">
      <Eyebrow className="md:hidden">Passages worth keeping</Eyebrow>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-stone-900 md:mt-0 md:flex md:h-11 md:items-center md:text-4xl">Clippings</h1>

      {error && !items ? (
        <ErrorNote error={error} />
      ) : !items ? (
        <Spinner />
      ) : all.length === 0 ? (
        <p className="py-16 text-center text-sm text-stone-500">No clippings yet. Highlight passages on your reader and turn on clipping sync.</p>
      ) : (
        <>
          {daily && !q && !only && (
            <section className="mt-6">
              <p className="font-mono text-[0.65rem] font-medium tracking-wider text-stone-400 uppercase">Highlight of the day</p>
              <div className="mt-2 md:max-w-2xl">
                <Clip session={session} clip={daily} book={byDoc.get(daily.document)} onShare={setSharing} showBook />
              </div>
            </section>
          )}

          <div className="mt-6 flex flex-col gap-3 md:flex-row md:items-center">
            <div className="relative md:w-80">
              <Search className="pointer-events-none absolute top-3.5 left-4 size-5 text-stone-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search clippings"
                enterKeyHint="search"
                className="h-12 w-full rounded-xl bg-white pr-4 pl-12 text-base text-stone-900 ring-1 ring-stone-950/10 outline-none placeholder:text-stone-400 focus:ring-2 focus:ring-brand-500/60"
              />
            </div>
            <div className="flex gap-2">
              <button onClick={() => exportMd(false)} className="flex h-11 items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100">
                <Copy className="size-4" /> Copy Markdown
              </button>
              {isApp && (
                <button onClick={() => exportMd(true)} className="flex h-11 items-center gap-2 rounded-xl bg-white px-4 text-sm font-semibold text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100">
                  <FileDown className="size-4" /> Save .md
                </button>
              )}
            </div>
          </div>
          {note && <p className="mt-2 text-sm text-stone-600">{note}</p>}

          <div className="-mx-4 mt-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0">
            <button
              onClick={() => setOnly(null)}
              className={`shrink-0 rounded-full px-3.5 py-1.5 text-sm font-medium ${!only ? 'bg-brand-500 text-white' : 'bg-white text-stone-600 ring-1 ring-stone-950/10'}`}
            >
              All <span className="ml-0.5 font-mono text-xs opacity-70">{all.length}</span>
            </button>
            {[...counts].map(([doc, n]) => (
              <button
                key={doc}
                onClick={() => setOnly(only === doc ? null : doc)}
                className={`max-w-56 shrink-0 truncate rounded-full px-3.5 py-1.5 text-sm font-medium ${only === doc ? 'bg-brand-500 text-white' : 'bg-white text-stone-600 ring-1 ring-stone-950/10'}`}
              >
                {byDoc.get(doc).title || byDoc.get(doc).filename} <span className="ml-0.5 font-mono text-xs opacity-70">{n}</span>
              </button>
            ))}
          </div>

          {groups.length === 0 && <p className="py-12 text-center text-sm text-stone-500">No clippings match.</p>}
          {groups.map(({ book, clips }) => (
            <section key={book.document} className="mt-8">
              <a href={`#/book/${book.document}`} className="flex items-center gap-3">
                <Cover session={session} book={book} small className="w-10" />
                <div className="min-w-0">
                  <h2 className="truncate font-display text-lg font-semibold text-stone-900">{book.title || book.filename}</h2>
                  <p className="truncate text-sm text-stone-500">{book.author}</p>
                </div>
              </a>
              <div className="mt-3 grid gap-3 md:grid-cols-2">
                {clips.map((c) => (
                  <Clip key={c.id} session={session} clip={c} book={book} onShare={setSharing} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      {sharing && <ClipShare session={session} book={byDoc.get(sharing.document)} clip={sharing} onClose={() => setSharing(null)} />}
    </div>
  )
}
