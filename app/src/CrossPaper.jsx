import { useCallback, useEffect, useState } from 'react'
import { CircleQuestionMark, Download, Loader2, Newspaper, Send as SendIcon, X } from 'lucide-react'
import { api, isApp } from './api.js'
import { sendFile } from './catalogs.js'
import { loadDevicePrefs } from './device.js'
import { addImport, listImports, readImport, removeImport } from './importQueue.js'
import { importKind } from './importTypes.js'
import { EmptyState, ErrorNote, Eyebrow, notify } from './ui.jsx'

// A few places to start; any RSS feed or site address works in the box below.
const SUGGESTED = [
  ['BBC News', 'https://feeds.bbci.co.uk/news/rss.xml'],
  ['NPR', 'https://feeds.npr.org/1001/rss.xml'],
  ['The Guardian', 'https://www.theguardian.com/world/rss'],
  ['Ars Technica', 'https://feeds.arstechnica.com/arstechnica/index'],
  ['The Verge', 'https://www.theverge.com/rss/index.xml'],
  ['Hacker News', 'https://hnrss.org/frontpage'],
  ['Longreads', 'https://longreads.com/feed/'],
]

const button = 'inline-flex h-10 shrink-0 items-center justify-center gap-2 rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-50 md:hover:bg-brand-600'
const remove = '-mr-2 grid size-10 shrink-0 place-items-center rounded-full text-stone-400 active:bg-stone-100'
const FEW = 6 // today's articles shown before "Show all"
const bare = (url) => url.replace(/^https?:\/\/(www\.)?/, '')

function UrlForm({ label, placeholder, action, onSubmit, className = '' }) {
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    if (!url.trim() || busy) return
    setBusy(true)
    if (await onSubmit(url.trim())) setUrl('')
    setBusy(false)
  }
  return (
    <form onSubmit={submit} className={`flex h-11 items-center rounded-xl bg-surface pr-1 ring-1 ring-stone-950/10 focus-within:ring-2 focus-within:ring-brand-500/60 ${className}`}>
      <input
        type="url"
        inputMode="url"
        autoCapitalize="none"
        autoCorrect="off"
        aria-label={label}
        placeholder={placeholder}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="h-full min-w-0 flex-1 bg-transparent px-3 text-sm text-stone-900 outline-none placeholder:text-stone-400"
      />
      <button type="submit" disabled={busy || !url.trim()} className="flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold text-brand-600 active:bg-stone-100 disabled:text-stone-400">
        {busy && <Loader2 className="size-4 animate-spin" />} {action}
      </button>
    </form>
  )
}

// Whether CrossPaper appears in the Library (and the web navigation). On unless
// turned off in Settings; remembered on this device.
const HIDE_CROSSPAPER = 'crosspoint-hide-crosspaper'
export function showCrossPaper() {
  try {
    return localStorage.getItem(HIDE_CROSSPAPER) !== '1'
  } catch {
    return true
  }
}
export function setShowCrossPaper(on) {
  try {
    if (on) localStorage.removeItem(HIDE_CROSSPAPER)
    else localStorage.setItem(HIDE_CROSSPAPER, '1')
  } catch {
    // this session only
  }
  dispatchEvent(new Event('crosspoint-crosspaper-shown'))
}

// The Settings choice to show CrossPaper, kept current while the app is open.
export function useShowCrossPaper() {
  const [shown, setShown] = useState(showCrossPaper)
  useEffect(() => {
    const update = () => setShown(showCrossPaper())
    addEventListener('crosspoint-crosspaper-shown', update)
    return () => removeEventListener('crosspoint-crosspaper-shown', update)
  }, [])
  return shown
}

// Links shared into the app wait in the import queue as tiny .url files.
async function sharedLinks() {
  if (!isApp) return []
  const links = []
  for (const entry of (await listImports()).filter((e) => importKind(e) === 'crosspaper')) {
    const url = /https?:\/\/[^\s"'<>]+/.exec(await (await readImport(entry)).text())?.[0]
    if (url) links.push({ id: entry.id, url })
    else await removeImport(entry.id)
  }
  return links
}

// `aside` sits at the top right of the masthead: Browse puts its side switch there.
export default function CrossPaper({ session, aside }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [links, setLinks] = useState([])
  const [help, setHelp] = useState(false)
  const [building, setBuilding] = useState(null) // the edition being fetched: 'today' or its date
  const [view, setView] = useState('today') // today | feeds | editions
  const [all, setAll] = useState(false) // the whole of today's list, not just its first few

  const load = useCallback(() => api.crossPaper(session).then(setData, setError), [session])
  useEffect(() => {
    if (!session) return
    load()
    // New feed items arrive in the background; show them when they land.
    api.refreshCrossPaper(session).then(load, () => {})
  }, [session, load])
  useEffect(() => {
    const check = () => sharedLinks().then(setLinks, () => {})
    check()
    window.addEventListener('crosspoint-imports-changed', check)
    return () => window.removeEventListener('crosspoint-imports-changed', check)
  }, [])

  if (!session) {
    return (
      <div className="max-w-3xl">
        {aside && <div className="mb-4 flex justify-end">{aside}</div>}
        <EmptyState icon={Newspaper} title="CrossPaper needs an account">
          Sign in to save web pages and follow feeds, then read them as a daily paper on your reader.
        </EmptyState>
      </div>
    )
  }

  // Run a change, reload, and report a failure; resolves to whether it worked.
  const run = async (work, done) => {
    try {
      const result = await work()
      await load()
      if (done) notify({ title: done(result) })
      return true
    } catch (e) {
      notify({ error: true, title: e.message || 'Something went wrong' })
      return false
    }
  }
  const save = (url) => run(() => api.saveArticle(session, url), (r) => `Added "${r.title}"`)
  const answer = async (link, add) => {
    if (add && !(await save(link.url))) return
    await removeImport(link.id).catch(() => {})
    setLinks((cur) => cur.filter((l) => l.id !== link.id))
  }
  const fetchEdition = async (date) => {
    setBuilding(date)
    try {
      const file = await api.crossPaperEpub(session, date)
      if (isApp) {
        // Straight to the reader when it is reachable; otherwise the edition waits in Send.
        try {
          await sendFile(file, loadDevicePrefs())
          notify({ title: 'Sent to your CrossPoint', detail: file.name })
        } catch {
          await addImport(file)
          notify({ error: true, title: "Couldn't reach your reader", detail: 'This edition is waiting in Send. Open File Transfer on your reader, then send it from there.' })
          location.hash = '#/send'
        }
      } else {
        // A browser can't reach the reader on the local network, so the web saves the file.
        const href = URL.createObjectURL(file)
        Object.assign(document.createElement('a'), { href, download: file.name }).click()
        setTimeout(() => URL.revokeObjectURL(href), 10_000)
      }
      await load()
    } catch (e) {
      notify({ error: true, title: e.message || "Couldn't build that edition" })
    }
    setBuilding(null)
  }

  const waiting = data?.articles.filter((a) => !a.issue) ?? []
  // Past editions, newest first, each with the articles that went into it.
  const byDate = {}
  for (const a of data?.articles ?? []) if (a.issue) (byDate[a.issue] ??= []).push(a)
  const editions = Object.entries(byDate).sort(([a], [b]) => b.localeCompare(a))
  const dayName = (date) => new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })
  const followed = new Set(data?.feeds.map((f) => f.url))
  const follow = (url) => run(() => api.addFeed(session, url), (f) => `Following ${f.title}`)
  const suggested = SUGGESTED.filter(([, url]) => !followed.has(url))
  const SendOrSave = isApp ? SendIcon : Download
  return (
    <div className="max-w-3xl">
      {links.map((link) => (
        <div key={link.id} className="mb-5 flex items-center gap-1 rounded-xl bg-brand-50 py-1.5 pr-1.5 pl-4">
          <p className="min-w-0 flex-1 truncate text-sm text-stone-700">{bare(link.url)}</p>
          <button onClick={() => answer(link, true)} className="h-9 rounded-lg bg-brand-500 px-3 text-sm font-semibold text-white active:bg-brand-600">Add</button>
          <button onClick={() => answer(link, false)} aria-label="Not now" className="grid size-9 place-items-center rounded-full text-stone-500 active:bg-brand-100">
            <X className="size-4" />
          </button>
        </div>
      ))}

      <section>
        <div className="flex items-center justify-between gap-3">
          <Eyebrow>CrossPaper</Eyebrow>
          {aside}
        </div>
        {/* The masthead: a newspaper's double rule under the title. */}
        <div className="mt-1 flex items-center gap-1 border-b-[3px] border-double border-stone-900 pb-3">
          <h1 className="font-display text-2xl tracking-tight text-stone-900 md:text-4xl">{new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} Edition</h1>
          <button
            onClick={() => setHelp(!help)}
            aria-expanded={help}
            aria-controls="crosspaper-help"
            aria-label="How CrossPaper works"
            className={`grid size-10 place-items-center rounded-full active:bg-stone-100 ${help ? 'text-brand-600' : 'text-stone-400'}`}
          >
            <CircleQuestionMark className="size-[1.125rem]" />
          </button>
          <button onClick={() => fetchEdition('today')} disabled={!!building} className={`${button} ml-auto`}>
            {building === 'today' ? <Loader2 className="size-4 animate-spin" /> : <SendOrSave className="size-4" />}
            {building === 'today' ? 'Building…' : isApp ? 'Send' : 'Download'}
          </button>
        </div>
        {help && (
          <div id="crosspaper-help" className="max-w-prose space-y-2 border-b border-stone-200 py-4 text-sm/6 text-stone-600">
            <p>
              A daily paper for your reader, made from pages you save and feeds you follow. {isApp ? 'Send' : 'Download'} turns today&apos;s articles into one book; tomorrow starts a new edition.
            </p>
            {isApp && <p>You can also share a page to CrossPoint Sync from any app.</p>}
            <p>
              Without the app, add this OPDS catalog on your reader and sign in with your sync account:
              <span className="mt-1 block font-mono text-xs break-all text-stone-800">{session.server}/opds/crosspaper</span>
            </p>
          </div>
        )}
        <nav aria-label="CrossPaper" className="mt-3 flex gap-6 border-b border-stone-200">
          {[['today', 'Today', waiting.length], ['feeds', 'Feeds', data?.feeds.length], ['editions', 'Editions', editions.length]].map(([id, label, count]) => (
            <button
              key={id}
              onClick={() => setView(id)}
              aria-current={view === id ? 'page' : undefined}
              className={`-mb-px border-b-2 pb-2.5 text-sm font-semibold whitespace-nowrap transition ${view === id ? 'border-brand-500 text-stone-900' : 'border-transparent text-stone-500'}`}
            >
              {label}
              {count > 0 && <span className="ml-1.5 font-normal tabular-nums text-stone-400">{count}</span>}
            </button>
          ))}
        </nav>
      </section>

      {view === 'today' && (
      <section>
        <UrlForm className="mt-4" label="Page address" placeholder="Paste a link to save a page" action="Save" onSubmit={save} />
        {error && !data && <ErrorNote error={error} />}
        {waiting.length > 0 ? (
          <ul aria-label="Waiting articles" className="mt-1 divide-y divide-stone-200">
            {(all ? waiting : waiting.slice(0, FEW)).map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-display text-[0.95rem] text-stone-900">{a.title}</p>
                  <p className="truncate text-xs text-stone-500">{a.section}</p>
                </div>
                <button onClick={() => run(() => api.removeArticle(session, a.id))} aria-label={`Remove ${a.title}`} className={remove}>
                  <X className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : (
          data && <p className="mt-4 text-sm text-stone-500">Nothing in it yet. Save a page or follow a feed.</p>
        )}
        {!all && waiting.length > FEW && (
          <button onClick={() => setAll(true)} className="h-10 text-sm font-semibold text-brand-600">
            Show all {waiting.length}
          </button>
        )}
      </section>
      )}

      {view === 'feeds' && (
      <section>
        <UrlForm className="mt-4" label="Feed address" placeholder="Feed or site address" action="Follow" onSubmit={follow} />
        {data?.feeds.length > 0 && (
          <ul aria-label="Feeds" className="mt-1 divide-y divide-stone-200">
            {data.feeds.map((f) => (
              <li key={f.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-stone-900">{f.title}</p>
                  <p className="truncate text-xs text-stone-500">{bare(f.url)}</p>
                </div>
                <button onClick={() => run(() => api.removeFeed(session, f.id))} aria-label={`Unfollow ${f.title}`} className={remove}>
                  <X className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {suggested.length > 0 && (
          <p className="mt-3 flex flex-wrap items-center gap-x-4 text-sm text-stone-400">
            Try
            {suggested.map(([name, url]) => (
              <button key={url} onClick={() => follow(url)} className="h-9 font-medium text-stone-700 underline decoration-stone-300 underline-offset-4 active:text-brand-600 md:hover:decoration-stone-500">
                {name}
              </button>
            ))}
          </p>
        )}
      </section>
      )}

      {view === 'editions' && (
      <section>
        {editions.length === 0 ? (
          <p className="mt-4 text-sm text-stone-500">No past editions yet. Each day&apos;s paper is kept for two weeks.</p>
        ) : (
          <ul aria-label="Editions" className="mt-1 divide-y divide-stone-200">
            {editions.map(([date, articles]) => (
              <li key={date} className="py-2">
                <details>
                  <summary className="flex cursor-pointer list-none items-center gap-3 [&::-webkit-details-marker]:hidden">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-display text-[0.95rem] text-stone-900">{dayName(date)}</p>
                      <p className="text-xs tabular-nums text-stone-500">{articles.length} {articles.length === 1 ? 'article' : 'articles'}</p>
                    </div>
                    <button
                      onClick={(e) => { e.preventDefault(); fetchEdition(date) }}
                      disabled={!!building}
                      aria-label={`${isApp ? 'Send' : 'Download'} the ${dayName(date)} edition`}
                      className="-mr-2 grid size-10 shrink-0 place-items-center rounded-full text-brand-600 active:bg-stone-100 disabled:opacity-50"
                    >
                      {building === date ? <Loader2 className="size-4 animate-spin" /> : <SendOrSave className="size-4" />}
                    </button>
                  </summary>
                  <ul className="mt-1 mb-2 space-y-1.5">
                    {articles.map((a) => (
                      <li key={a.id} className="text-sm">
                        <a href={a.url} target="_blank" rel="noreferrer" className="text-stone-800 underline-offset-2 hover:underline">{a.title}</a>
                        <span className="text-stone-500"> · {a.section}</span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        )}
        {editions.length > 0 && <p className="mt-3 text-xs text-stone-400">Kept for two weeks</p>}
      </section>
      )}
    </div>
  )
}
