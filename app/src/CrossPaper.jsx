import { useCallback, useEffect, useState } from 'react'
import { Download, Loader2, Newspaper, Plus, Rss, Send as SendIcon, X } from 'lucide-react'
import { api, isApp } from './api.js'
import { sendFile } from './catalogs.js'
import { loadDevicePrefs } from './device.js'
import { addImport, listImports, readImport, removeImport } from './importQueue.js'
import { importKind } from './importTypes.js'
import { Card, EmptyState, ErrorNote, notify } from './ui.jsx'

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

const button = 'inline-flex h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-50 md:hover:bg-brand-600'

function UrlForm({ label, placeholder, action, onSubmit }) {
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
    <form onSubmit={submit} className="mt-3 flex gap-2">
      <input
        type="url"
        inputMode="url"
        autoCapitalize="none"
        autoCorrect="off"
        aria-label={label}
        placeholder={placeholder}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="h-11 min-w-0 flex-1 rounded-xl bg-stone-50 px-3 text-sm text-stone-900 ring-1 ring-stone-950/10 outline-none focus:ring-brand-500"
      />
      <button type="submit" disabled={busy || !url.trim()} className={button}>
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />} {action}
      </button>
    </form>
  )
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

export default function CrossPaper({ session }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [links, setLinks] = useState([])
  const [building, setBuilding] = useState(null) // the edition being fetched: 'today' or its date

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
      <div className="mt-6 max-w-3xl">
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
  return (
    <div className="max-w-3xl">
      {links.map((link) => (
        <Card key={link.id} className="mt-5 p-4">
          <h2 className="font-semibold text-stone-900">Add this to your CrossPaper?</h2>
          <p className="mt-1 text-sm break-all text-stone-500">{link.url}</p>
          <div className="mt-3 flex gap-2">
            <button onClick={() => answer(link, true)} className={button}>Add</button>
            <button onClick={() => answer(link, false)} className="h-11 rounded-xl px-4 text-sm font-semibold text-stone-600 ring-1 ring-stone-950/10 active:bg-stone-100">Not now</button>
          </div>
        </Card>
      ))}

      <Card className="mt-5 p-4">
        <h2 className="font-semibold text-stone-900">Today&apos;s CrossPaper</h2>
        <p className="mt-1 text-sm/6 text-stone-600">
          A daily newspaper for your reader, made from web pages you save and feeds you follow. Each day&apos;s articles are bundled into one book.
        </p>
        <ol className="mt-3 list-decimal space-y-1 pl-5 text-sm/6 text-stone-600">
          <li>Save pages or follow feeds below.</li>
          <li>Press <span className="font-medium text-stone-800">{isApp ? 'Send to CrossPoint' : 'Download Today’s Edition'}</span> to get today&apos;s edition as a book.</li>
          <li>Tomorrow starts a new edition. Earlier ones are kept under Editions.</li>
        </ol>
        <p className="mt-4 text-sm font-medium text-stone-900">
          {waiting.length ? `Today so far: ${waiting.length} ${waiting.length === 1 ? 'article' : 'articles'}` : 'Nothing saved yet today'}
        </p>
        <button onClick={() => fetchEdition('today')} disabled={!!building} className={`${button} mt-2`}>
          {building === 'today' ? <Loader2 className="size-4 animate-spin" /> : isApp ? <SendIcon className="size-4" /> : <Download className="size-4" />}
          {building === 'today' ? 'Building…' : isApp ? 'Send to CrossPoint' : 'Download Today’s Edition'}
        </button>
        <details className="mt-4 border-t border-stone-200 pt-3 text-sm/6 text-stone-500">
          <summary className="cursor-pointer font-medium text-stone-600">Get it from your reader, without the app</summary>
          <p className="mt-2">On your reader, add this OPDS catalog and sign in with your sync username and password:</p>
          <p className="mt-1 font-mono text-xs break-all text-stone-700">{session.server}/opds/crosspaper</p>
        </details>
      </Card>

      <Card className="mt-5 p-4">
        <h2 className="font-semibold text-stone-900">Save a page</h2>
        <p className="mt-1 text-sm/6 text-stone-500">{isApp ? 'Paste a link here, or share a page to CrossPoint Sync from any app.' : 'Paste a link to an article.'}</p>
        <UrlForm label="Page address" placeholder="https://…" action="Save" onSubmit={save} />
        {error && !data && <div className="mt-3"><ErrorNote error={error} /></div>}
      </Card>

      {waiting.length > 0 && (
        <Card className="mt-5 p-4">
          <h2 className="font-semibold text-stone-900">In today&apos;s edition</h2>
          <ul aria-label="Waiting articles" className="mt-2 divide-y divide-stone-200">
            {waiting.map((a) => (
              <li key={a.id} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-stone-900">{a.title}</p>
                  <p className="truncate text-xs text-stone-500">{a.section}</p>
                </div>
                <button onClick={() => run(() => api.removeArticle(session, a.id))} aria-label={`Remove ${a.title}`} className="grid size-10 shrink-0 place-items-center rounded-full text-stone-400 active:bg-stone-100">
                  <X className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-5 p-4">
        <h2 className="font-semibold text-stone-900">Feeds</h2>
        <p className="mt-1 text-sm/6 text-stone-500">New posts from these go into each day&apos;s edition. Enter a feed or just a site&apos;s address.</p>
        <UrlForm label="Feed address" placeholder="https://example.com/feed" action="Follow" onSubmit={(url) => run(() => api.addFeed(session, url), (f) => `Following ${f.title}`)} />
        {data?.feeds.length > 0 && (
          <ul aria-label="Feeds" className="mt-3 divide-y divide-stone-200">
            {data.feeds.map((f) => (
              <li key={f.id} className="flex items-center gap-3 py-2.5">
                <Rss className="size-4 shrink-0 text-stone-400" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-stone-900">{f.title}</p>
                  <p className="truncate text-xs text-stone-500">{f.url}</p>
                </div>
                <button onClick={() => run(() => api.removeFeed(session, f.id))} aria-label={`Unfollow ${f.title}`} className="grid size-10 shrink-0 place-items-center rounded-full text-stone-400 active:bg-stone-100">
                  <X className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {SUGGESTED.filter(([, url]) => !followed.has(url)).map(([name, url]) => (
            <button key={url} onClick={() => run(() => api.addFeed(session, url), (f) => `Following ${f.title}`)} className="inline-flex h-9 items-center gap-1 rounded-full px-3 text-sm font-medium text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100">
              <Plus className="size-3.5" /> {name}
            </button>
          ))}
        </div>
      </Card>

      <Card className="mt-5 p-4">
        <h2 className="font-semibold text-stone-900">Editions</h2>
        <p className="mt-1 text-sm/6 text-stone-500">Every day&apos;s paper, kept for two weeks.</p>
        {editions.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500">No editions yet. Your first appears once today&apos;s is fetched or the day ends.</p>
        ) : (
          <ul aria-label="Editions" className="mt-2 divide-y divide-stone-200">
            {editions.map(([date, articles]) => (
              <li key={date} className="py-2.5">
                <details>
                  <summary className="flex cursor-pointer list-none items-center gap-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium text-stone-900">{dayName(date)}</p>
                      <p className="text-xs text-stone-500">{articles.length} {articles.length === 1 ? 'article' : 'articles'}</p>
                    </div>
                    <button
                      onClick={(e) => { e.preventDefault(); fetchEdition(date) }}
                      disabled={!!building}
                      aria-label={`${isApp ? 'Send' : 'Download'} the ${dayName(date)} edition`}
                      className="grid size-10 shrink-0 place-items-center rounded-full text-brand-600 active:bg-stone-100 disabled:opacity-50"
                    >
                      {building === date ? <Loader2 className="size-4 animate-spin" /> : isApp ? <SendIcon className="size-4" /> : <Download className="size-4" />}
                    </button>
                  </summary>
                  <ul className="mt-2 space-y-1.5 border-l-2 border-stone-200 pl-3">
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
      </Card>
    </div>
  )
}
