import { useMemo, useRef, useState } from 'react'
import { Copy, FileDown, Quote, Search } from 'lucide-react'
import { api, cached, isApp } from './api.js'
import { saveFile } from './shareCard.js'
import { ClipMenu, ClipShare, DeleteClip, hold } from './Book.jsx'
import { ActionSheet, Cover, EmptyState, ErrorNote, ShareIcon, Spinner, useLoad } from './ui.jsx'

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

function Clip({ session, clip, book, onShare, onDelete, showBook, onMicroblog, sending }) {
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
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <button onClick={() => onShare(clip)} className="-ml-2 flex h-11 items-center gap-1.5 rounded-full px-2 text-sm font-medium text-brand-600 active:bg-stone-100">
          <ShareIcon className="size-4" /> Share
        </button>
        {onMicroblog && (
          <button type="button" disabled={sending} onClick={() => onMicroblog(clip)} className="min-h-11 rounded-full px-2 text-sm font-medium text-brand-600 disabled:opacity-50">
            Add clipping to Micro.blog
          </button>
        )}
        <p className="truncate text-xs text-stone-500">{[clip.chapter, date(clip.created_at)].filter(Boolean).join(' · ')}</p>
      </div>
    </article>
  )
}

export default function Clippings({ session, books }) {
  const [items, error, reload] = useLoad(() => api.allClippings(session, books), [session, books], `clippings:${session.username}`, () => cached.clippings(session))
  const [connectors] = useLoad(() => api.connectors(session).then((r) => r.connectors), [session], `clipping-connectors:${session.username}`)
  const microblog = connectors?.some((c) => c.id === 'microblog' && c.linked)
  const [postData, postError, reloadPosts] = useLoad(() => microblog ? api.microblogClippingPosts(session) : Promise.resolve({ items: [] }), [session, microblog])
  const [recreating, setRecreating] = useState(null)
  const [query, setQuery] = useState('')
  const [only, setOnly] = useState(null) // document
  const [sharing, setSharing] = useState(null)
  const [deleting, setDeleting] = useState(null)
  const [note, setNote] = useState(null)
  const [sending, setSending] = useState(false)
  const pending = useRef(false)
  const [sendError, setSendError] = useState(null)
  const byDoc = useMemo(() => new Map(books.map((b) => [b.document, b])), [books])
  const missingPosts = microblog ? (postData?.items || []).filter((post) => post.missing && byDoc.has(post.document)) : []

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

  async function addToMicroblog(clip) {
    if (pending.current) return
    pending.current = true
    setSending(true)
    setNote(null)
    setSendError(null)
    try {
      const result = await api.addMicroblogClipping(session, clip.document, clip.id)
      setNote(result.waiting_for_match
        ? 'Clipping saved for Micro.blog. Match this book in Settings; it will be included on the next sync.'
        : result.queued ? 'Clipping selected for the book’s Micro.blog post. The update is queued.'
          : 'Clipping is selected for the book’s Micro.blog post.')
    } catch (error) {
      setSendError(error.message || 'Could not add this clipping to Micro.blog.')
    } finally {
      pending.current = false
      setSending(false)
    }
  }

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
      {sendError && <p role="alert" className="mt-3 text-sm text-red-600">{sendError}</p>}
      {postError && microblog && <p role="alert" className="mt-3 text-sm text-red-600">Could not load Micro.blog post status: {postError.message}</p>}
      {note && <p role="status" className="mt-2 text-sm text-stone-600">{note}</p>}
      {missingPosts.length > 0 && <section aria-label="Paused Micro.blog posts" className="mt-6 rounded-xl bg-surface p-4 ring-1 ring-stone-200">
        <h2 className="font-medium text-stone-900">Micro.blog publishing paused</h2>
        {missingPosts.map((post) => {
          const book = byDoc.get(post.document)
          return <div key={post.document} className="mt-3 text-sm">
            <a href={`#/book/${post.document}`} className="font-medium text-stone-900">{book.title || book.filename}</a>
            {book.author && <p className="text-stone-500">{book.author}</p>}
            <p className="mt-1 text-stone-600">The Micro.blog post was deleted. Clippings are retained while publishing is paused.</p>
            <button type="button" onClick={() => setRecreating(post)} className="min-h-11 font-medium text-brand-600">Recreate clippings post</button>
          </div>
        })}
      </section>}

      {error && !items ? (
        <ErrorNote error={error} />
      ) : !items ? (
        <Spinner />
      ) : all.length === 0 ? (
        <div className="mt-6 md:max-w-2xl">
          <EmptyState icon={Quote} note="Clean margins, for now" title="No clippings yet">
            Clippings saved on your reader land here, ready to search and share.
          </EmptyState>
        </div>
      ) : (
        <>
          {daily && !q && !only && (
            <section className="mt-6">
              <p className="inline-block -rotate-1 font-hand text-xl text-brand-600">Clipping of the day</p>
              <div className="mt-2 md:max-w-2xl">
                <Clip session={session} clip={daily} book={byDoc.get(daily.document)} onShare={setSharing} onDelete={setDeleting} showBook onMicroblog={microblog ? addToMicroblog : null} sending={sending} />
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
                  <Clip key={c.id} session={session} clip={c} book={book} onShare={setSharing} onDelete={setDeleting} onMicroblog={microblog ? addToMicroblog : null} sending={sending} />
                ))}
              </div>
            </section>
          ))}
        </>
      )}

      {recreating && <RecreateClippingsPost session={session} post={recreating} onClose={() => setRecreating(null)} onDone={() => {
        reloadPosts()
        setNote('Replacement clippings post queued for Micro.blog.')
      }} />}
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

function RecreateClippingsPost({ session, post, onClose, onDone }) {
  const [blogs, error, reload] = useLoad(() => api.microblogDestinations(session), [session])
  const [target, setTarget] = useState('original')
  const [busy, setBusy] = useState(false)
  const currentBlog = blogs?.items?.find((b) => b.uid === blogs.selected)
  const original = post.destination || post.url
  return (
    <ActionSheet title="Recreate clippings post?" actionLabel="Recreate post" pendingLabel="Queuing…" onClose={onClose} onConfirm={async () => {
      setBusy(true)
      try {
        await api.recreateMicroblogPost(session, post.document, target)
        onDone()
      } finally { setBusy(false) }
    }}>
      This republishes this book’s collected clippings. Future clippings for this book will update the replacement on the chosen blog.
      <label className="mt-3 flex items-start gap-2">
        <input type="radio" name="recreate-blog" value="original" checked={target === 'original'} disabled={busy} onChange={() => setTarget('original')} className="mt-1" />
        <span className="break-all">Previous blog: {original}</span>
      </label>
      {currentBlog?.uid !== post.destination && <label className="mt-3 flex items-start gap-2">
        <input type="radio" name="recreate-blog" value="current" checked={target === 'current'} disabled={busy || !currentBlog} onChange={() => setTarget('current')} className="mt-1" />
        <span className="break-all">Current clippings blog: {currentBlog ? `${currentBlog.name} (${currentBlog.uid})` : blogs ? 'Choose an available blog in Settings first.' : 'Loading…'}</span>
      </label>}
      {currentBlog?.uid === post.destination && <span className="mt-3 block">The current clippings blog is also the previous blog.</span>}
      {error && <span className="mt-3 block">Could not load the current clippings blog. <button type="button" onClick={reload} className="font-medium text-brand-600">Retry</button></span>}
    </ActionSheet>
  )
}
