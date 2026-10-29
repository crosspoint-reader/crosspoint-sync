import { useMemo, useState } from 'react'
import { Copy, FileDown, Quote, Search } from 'lucide-react'
import { api, cached, isApp } from './api.js'
import { saveFile } from './shareCard.js'
import { ClipMenu, ClipShare, DeleteClip, hold } from './Book.jsx'
import { Cover, EmptyState, ErrorNote, ShareIcon, Spinner, useLoad } from './ui.jsx'

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

function Clip({ session, clip, book, onShare, onDelete, showBook }) {
  return (
    <article className={`group relative select-none [-webkit-touch-callout:none] ${showBook
      ? 'border-b border-stone-200 pt-6 pb-4 md:pr-8'
      : 'border-b border-stone-200 py-5 md:pr-8'}`} {...hold(() => onDelete(clip))}>
      <ClipMenu onDelete={() => onDelete(clip)} />
      <blockquote className="font-display text-lg/relaxed text-stone-800">{clip.text}</blockquote>
      {clip.note && <p className="mt-3 font-hand text-lg/6 text-brand-700">{clip.note}</p>}
      {showBook && (
        <a href={`#/book/${book.document}`} className="mt-6 flex items-center gap-3 pr-5">
          <Cover session={session} book={book} small className="w-8" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-stone-900">{book.title || book.filename}</p>
            <p className="truncate text-xs text-stone-500">{book.author}</p>
          </div>
        </a>
      )}
      <div className="mt-2 flex items-center justify-between gap-3">
        <button onClick={() => onShare(clip)} className="-ml-2 flex h-11 items-center gap-1.5 rounded-full px-2 text-sm font-medium text-brand-600 active:bg-stone-100">
          <ShareIcon className="size-4" /> Share
        </button>
        <p className="truncate text-xs text-stone-500">{[clip.chapter, date(clip.created_at)].filter(Boolean).join(' · ')}</p>
      </div>
    </article>
  )
}

export default function Clippings({ session, books }) {
  const [items, error, reload] = useLoad(() => api.allClippings(session, books), [session, books], `clippings:${session.username}`, () => cached.clippings(session))
  const [query, setQuery] = useState('')
  const [only, setOnly] = useState(null) // document
  const [sharing, setSharing] = useState(null)
  const [deleting, setDeleting] = useState(null)
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

  async function exportMd(save, e) {
    // A <details> menu stays open until toggled; close it so the note shows.
    e.currentTarget.closest('details').open = false
    const md = `# Clippings\n\n${markdown(groups)}\n`
    if (save) {
      await saveFile(new Blob([md], { type: 'text/markdown' }), 'CrossPoint clippings.md')
      setNote(/iphone|ipad/i.test(navigator.userAgent) ? 'Saved in the Files app: On My iPhone › CrossPoint Sync.' : 'Saved to your Downloads folder.')
    } else {
      await navigator.clipboard.writeText(md)
      setNote(`Copied ${matches.length} clipping${matches.length === 1 ? '' : 's'} as Markdown.`)
    }
  }

  return (
    <div className="px-4 pt-6 pb-4 md:px-8 md:pt-6 lg:px-12">
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-stone-900 md:mt-0 md:flex md:h-11 md:items-center md:text-4xl">Clippings</h1>

      {error && !items ? (
        <ErrorNote error={error} />
      ) : !items ? (
        <Spinner />
      ) : all.length === 0 ? (
        <div className="mt-6 md:max-w-2xl">
          <EmptyState icon={Quote} note="Clean margins, for now" title="No clippings yet">
            Highlight a passage on your reader with clipping sync on, and it lands here, ready to search and share.
          </EmptyState>
        </div>
      ) : (
        <>
          {daily && !q && !only && (
            <section className="mt-6">
              <p className="inline-block -rotate-1 font-hand text-xl text-brand-600">Highlight of the day</p>
              <div className="mt-2 md:max-w-2xl">
                <Clip session={session} clip={daily} book={byDoc.get(daily.document)} onShare={setSharing} onDelete={setDeleting} showBook />
              </div>
            </section>
          )}

          <div className="mt-6 flex items-center gap-3">
            <div className="relative min-w-0 flex-1 md:max-w-sm">
              <Search className="pointer-events-none absolute top-3.5 left-4 size-5 text-stone-400" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search clippings"
                placeholder="Search clippings"
                enterKeyHint="search"
                className="h-12 w-full rounded-xl bg-surface pr-4 pl-12 text-base text-stone-900 ring-1 ring-stone-950/10 outline-none placeholder:text-stone-400 focus:ring-2 focus:ring-brand-500/60"
              />
            </div>
            <details className="relative shrink-0">
              <summary aria-label="Export clippings" title="Export clippings" className="grid size-11 cursor-pointer list-none place-items-center rounded-full text-stone-600 hover:bg-stone-100 active:bg-stone-200 [&::-webkit-details-marker]:hidden">
                <FileDown aria-hidden="true" className="size-5" strokeWidth={1.75} />
              </summary>
              <div className="absolute right-0 z-20 mt-1 w-48 rounded-xl bg-surface p-2 shadow-lg ring-1 ring-stone-950/10">
                <button onClick={(e) => exportMd(false, e)} className="flex h-11 w-full items-center gap-2 rounded-lg px-3 text-sm font-medium text-stone-700 hover:bg-stone-100">
                  <Copy className="size-4" /> Copy Markdown
                </button>
                {isApp && (
                  <button onClick={(e) => exportMd(true, e)} className="flex h-11 w-full items-center gap-2 rounded-lg px-3 text-sm font-medium text-stone-700 hover:bg-stone-100">
                    <FileDown className="size-4" /> Save .md
                  </button>
                )}
              </div>
            </details>
          </div>
          {note && <p className="mt-2 text-sm text-stone-600">{note}</p>}

          <div className="-mx-4 mt-4 flex gap-5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] md:mx-0 md:flex-wrap md:px-0">
            <button
              aria-pressed={!only}
              onClick={() => setOnly(null)}
              className={`shrink-0 min-h-11 border-b-2 px-1 py-2 text-sm font-medium ${!only ? 'border-brand-500 text-brand-700' : 'border-transparent text-stone-500'}`}
            >
              All <span className="ml-0.5 text-xs tabular-nums">{all.length}</span>
            </button>
            {[...counts].map(([doc, n]) => (
              <button
                key={doc}
                aria-pressed={only === doc}
                onClick={() => setOnly(only === doc ? null : doc)}
                className={`max-w-56 shrink-0 truncate min-h-11 border-b-2 px-1 py-2 text-sm font-medium ${only === doc ? 'border-brand-500 text-brand-700' : 'border-transparent text-stone-500'}`}
              >
                {byDoc.get(doc).title || byDoc.get(doc).filename} <span className="ml-0.5 text-xs tabular-nums">{n}</span>
              </button>
            ))}
          </div>

          {groups.length === 0 && (
            <EmptyState compact icon={Search} title="No clippings match">
              Try another word, or clear the book filter.
            </EmptyState>
          )}
          {groups.map(({ book, clips }) => (
            <section key={book.document} className="mt-8">
              <a href={`#/book/${book.document}`} className="flex items-center gap-3">
                <Cover session={session} book={book} small className="w-10" />
                <div className="min-w-0">
                  <h2 className="truncate font-display text-lg font-semibold text-stone-900">{book.title || book.filename}</h2>
                  <p className="truncate text-sm text-stone-500">{book.author}</p>
                </div>
              </a>
              <div className="mt-3 grid grid-cols-1 gap-x-8 md:grid-cols-2">
                {clips.map((c) => (
                  <Clip key={c.id} session={session} clip={c} book={book} onShare={setSharing} onDelete={setDeleting} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      {sharing && <ClipShare session={session} book={byDoc.get(sharing.document)} clip={sharing} onClose={() => setSharing(null)} />}
      {deleting && (
        <DeleteClip
          session={session}
          clip={deleting}
          document={deleting.document}
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
