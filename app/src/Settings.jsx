import { useEffect, useRef, useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { ArrowLeft, ChevronRight, KeyRound, ListChecks, Loader2, LogOut, Monitor, Moon, RefreshCw, Search, Server, Sun, Trash2, UserX } from 'lucide-react'
import SparkMD5 from 'spark-md5'
import { api, isApp } from './api.js'
import { Bone, Card, EmptyState, Eyebrow, notify, useLoad } from './ui.jsx'

// Appearance: follow the system, or force light or dark.
const THEMES = [
  ['system', 'System', Monitor],
  ['light', 'Light', Sun],
  ['dark', 'Dark', Moon],
]
function Appearance({ theme: [pref, setPref] }) {
  return (
    <div className="grid grid-cols-3 gap-1 rounded-xl bg-stone-200/60 p-1" role="radiogroup" aria-label="Appearance">
      {THEMES.map(([v, label, Icon]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={pref === v}
          onClick={() => setPref(v)}
          className={`flex h-10 items-center justify-center gap-1.5 rounded-lg text-sm font-semibold transition ${
            pref === v ? 'bg-raised text-stone-900 shadow-sm' : 'text-stone-500 active:bg-stone-200'
          }`}
        >
          <Icon className="size-4" strokeWidth={2} />
          {label}
        </button>
      ))}
    </div>
  )
}

// What each service does, as on the web dashboard.
const HINTS = {
  hardcover: 'Syncs your reading progress and shelf status to Hardcover.',
  microblog: 'Keeps your Currently reading and Finished reading bookshelves in sync.',
  readwise: 'Syncs your highlights to Readwise.',
  'readwise-reader': 'Archives books in Reader when you finish them, and brings your Reader progress back.',
  kosync: 'Mirrors your reading progress to another KOReader-compatible (KOSync) server.',
  bookfusion: 'Syncs reading progress with BookFusion. You approve the request on bookfusion.com.',
  audiobookshelf: 'Keeps your place between the ebook and the audiobook. Create an API key in Audiobookshelf under Settings, Users, API Keys.',
  bookorbit: 'Syncs progress both ways with your BookOrbit server, and adds your clippings as highlights.',
  kindle: 'Linking needs the CrossPoint Kindle Link browser extension.',
}
// Where to get a token, for the services that use one.
const TOKEN_HELP = {
  hardcover: ['Or use an API key', 'https://hardcover.app/account/api/keys/new?scope=read:me+read:library+read:catalog+write:library'],
  microblog: ['Get an app token', 'https://micro.blog/account/apps'],
  readwise: ['Get your access token', 'https://readwise.io/access_token'],
  'readwise-reader': ['Get your access token', 'https://readwise.io/access_token'],
}

const open = (url) => (isApp ? openUrl(url) : window.open(url, '_blank', 'noopener'))

const field =
  'h-11 w-full rounded-xl bg-stone-50 px-3 text-sm text-stone-900 ring-1 ring-stone-950/10 outline-none placeholder:text-stone-400 focus:ring-2 focus:ring-brand-500/60'

// The link form for one service, by credential kind (same shapes as the web).
function LinkForm({ session, conn, onLinked }) {
  const [v, setV] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [device, setDevice] = useState(null) // device-code sign-in in progress
  const live = useRef(true)
  useEffect(() => () => (live.current = false), [])
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value })

  async function link(credential) {
    setBusy(true)
    setError(null)
    try {
      await api.linkConnector(session, conn.id, credential)
      onLinked()
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  async function startDevice() {
    setBusy(true)
    setError(null)
    try {
      const d = await api.beginLink(session, conn.id)
      setDevice(d)
      const deadline = Date.now() + (d.expires_in ?? 900) * 1000
      const tick = async () => {
        if (!live.current) return
        if (Date.now() > deadline) return (setError('The code expired. Start again.'), setDevice(null))
        const p = await api.pollLink(session, conn.id, d.device_code).catch((e) => ({ status: 'error', error: e.message }))
        if (p.status === 'ok') return onLinked()
        if (p.status === 'pending') return setTimeout(tick, Math.max(2, d.interval ?? 5) * 1000)
        setError(p.error || 'Linking failed. Start again.')
        setDevice(null)
      }
      setTimeout(tick, Math.max(2, d.interval ?? 5) * 1000)
    } catch (e) {
      setError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const submit = (label, credential) => (
    <button
      type="submit"
      disabled={busy}
      onClick={(e) => {
        e.preventDefault()
        link(credential())
      }}
      className="flex h-11 w-full items-center justify-center rounded-xl bg-brand-500 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-50"
    >
      {busy ? <Loader2 className="size-4 animate-spin" /> : label}
    </button>
  )
  const help = TOKEN_HELP[conn.id]
  const tokenForm = (
    <form className="space-y-2">
      {help && (
        <button type="button" onClick={() => open(help[1])} className="text-sm font-medium text-brand-600">
          {help[0]}
        </button>
      )}
      <input className={`${field} font-mono`} type="password" placeholder="Paste token" value={v.token ?? ''} onChange={set('token')} autoComplete="off" />
      {submit(`Link ${conn.name}`, () => ({
        token: (v.token ?? '').trim().replace(/^Bearer\s+/i, ''),
      }))}
    </form>
  )

  let body
  if (conn.id === 'kindle') {
    body = <p className="text-sm text-stone-600">Link Kindle from the CrossPoint Sync website with the browser extension.</p>
  } else if (conn.credential_kind === 'device_code') {
    body = device ? (
      <div className="space-y-2 rounded-xl bg-stone-50 p-3 text-center">
        {device.verification_uri_complete && (
          <button
            type="button"
            onClick={() => open(device.verification_uri_complete)}
            className="flex h-11 w-full items-center justify-center rounded-xl bg-brand-500 text-sm font-semibold text-white"
          >
            Approve on {conn.name}
          </button>
        )}
        <p className="text-xs text-stone-500">
          Or go to{' '}
          <button type="button" onClick={() => open(device.verification_uri)} className="font-medium text-brand-600">
            {device.verification_uri.replace(/^https?:\/\//, '')}
          </button>{' '}
          and enter
        </p>
        <p className="font-mono text-2xl tracking-[0.2em] text-stone-900">{device.user_code}</p>
        <p className="flex items-center justify-center gap-1.5 text-xs text-stone-500">
          <Loader2 className="size-3.5 animate-spin" /> Waiting for approval…
        </p>
      </div>
    ) : (
      <div className="space-y-3">
        <button
          type="button"
          disabled={busy}
          onClick={startDevice}
          className="flex h-11 w-full items-center justify-center rounded-xl bg-brand-500 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-50"
        >
          {busy ? <Loader2 className="size-4 animate-spin" /> : `Sign in with ${conn.name}`}
        </button>
        {conn.id === 'hardcover' && tokenForm}
      </div>
    )
  } else if (conn.credential_kind === 'kosync') {
    body = (
      <form className="space-y-2">
        <input
          className={`${field} font-mono`}
          placeholder={conn.id === 'bookorbit' ? 'https://books.example.com' : 'https://sync.koreader.rocks'}
          value={v.server ?? ''}
          onChange={set('server')}
          inputMode="url"
          autoCapitalize="none"
        />
        <input className={field} placeholder="Username" value={v.username ?? ''} onChange={set('username')} autoCapitalize="none" autoComplete="off" />
        <input className={field} type="password" placeholder="Password" value={v.password ?? ''} onChange={set('password')} autoComplete="off" />
        {submit('Connect', () => ({
          server: (v.server ?? '').trim(),
          username: (v.username ?? '').trim(),
          password: v.password ?? '',
        }))}
      </form>
    )
  } else if (conn.credential_kind === 'abs') {
    body = (
      <form className="space-y-2">
        <input
          className={`${field} font-mono`}
          placeholder="https://audiobookshelf.example.com"
          value={v.server ?? ''}
          onChange={set('server')}
          inputMode="url"
          autoCapitalize="none"
        />
        <input className={`${field} font-mono`} type="password" placeholder="API key" value={v.token ?? ''} onChange={set('token')} autoComplete="off" />
        {submit('Connect', () => ({
          server: (v.server ?? '').trim(),
          token: (v.token ?? '').trim(),
        }))}
      </form>
    )
  } else {
    body = tokenForm
  }
  return (
    <div className="mt-3 space-y-2">
      {body}
      {error && <p className="text-sm text-red-700">{error}</p>}
    </div>
  )
}

function Service({ session, conn, onChange }) {
  const [openForm, setOpenForm] = useState(false)
  const [busy, setBusy] = useState(null)
  const needsRelink = conn.linked && conn.status === 'needs_reauth'
  const icon = `${session.server}/icons/${conn.id}.png`

  async function act(kind, fn, done) {
    setBusy(kind)
    try {
      await fn()
      done?.()
      onChange()
    } catch (e) {
      notify({
        error: true,
        title: `${conn.name}: that didn't work`,
        detail: e.message,
      })
    } finally {
      setBusy(null)
    }
  }
  const unlink = () => {
    if (!confirm(`Unlink ${conn.name}? Its book matches and any queued syncs are removed.`)) return
    act(
      'unlink',
      () => api.unlinkConnector(session, conn.id),
      () => notify({ title: `${conn.name} unlinked` }),
    )
  }

  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <img src={icon} alt="" className="size-9 shrink-0 rounded-lg bg-stone-100" onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-sm font-semibold text-stone-900">
            {conn.name}
            {conn.beta && <span className="rounded-full bg-stone-100 px-1.5 py-0.5 text-[0.6rem] font-medium text-stone-500">Beta</span>}
          </p>
          <p className={`truncate text-xs ${needsRelink ? 'text-red-700' : 'text-stone-500'}`}>
            {needsRelink ? 'Needs to be linked again' : conn.linked ? `Linked${conn.account ? ` as ${conn.account}` : ''}` : (HINTS[conn.id] ?? 'Not linked')}
          </p>
        </div>
        {conn.linked && !needsRelink ? (
          <div className="flex shrink-0 items-center gap-1">
            {conn.matches !== false && (
              <a
                href={`#/settings/${conn.id}`}
                aria-label={`${conn.name} matches`}
                className="grid size-9 place-items-center rounded-full text-stone-500 active:bg-stone-100 md:hover:bg-stone-100"
              >
                <ListChecks className="size-4" />
              </a>
            )}
            <button
              type="button"
              aria-label={`Sync ${conn.name} now`}
              disabled={!!busy}
              onClick={() =>
                act('sync', async () => {
                  const r = await api.syncConnector(session, conn.id)
                  notify({
                    title: `Syncing to ${conn.name}`,
                    detail: r?.queued ? `${r.queued} book${r.queued === 1 ? '' : 's'} queued` : 'Everything is up to date',
                  })
                })
              }
              className="grid size-9 place-items-center rounded-full text-stone-500 active:bg-stone-100 md:hover:bg-stone-100"
            >
              {busy === 'sync' ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
            </button>
            <button
              type="button"
              disabled={!!busy}
              onClick={unlink}
              className="h-9 rounded-full px-3 text-sm font-medium text-red-600 active:bg-stone-100 md:hover:bg-stone-100"
            >
              {busy === 'unlink' ? <Loader2 className="size-4 animate-spin" /> : 'Unlink'}
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpenForm(!openForm)}
            className="h-9 shrink-0 rounded-full px-3.5 text-sm font-semibold text-brand-600 ring-1 ring-brand-200 active:bg-brand-50"
          >
            {openForm ? 'Cancel' : needsRelink ? 'Relink' : 'Link'}
          </button>
        )}
      </div>
      {openForm && (!conn.linked || needsRelink) && (
        <LinkForm
          session={session}
          conn={conn}
          onLinked={() => {
            setOpenForm(false)
            notify({ title: `${conn.name} linked` })
            onChange()
          }}
        />
      )}
    </div>
  )
}

function Services({ session }) {
  const [data, error, reload] = useLoad(() => api.connectors(session), [session], `connectors ${session.username}@${session.server}`)
  if (error && !data) return <p className="py-4 text-sm text-stone-500">Couldn&apos;t load services ({error.message}).</p>
  if (!data) return <Loader2 className="mx-auto my-6 size-5 animate-spin text-stone-400" />
  if (data.encryption === 'disabled') {
    return <p className="py-4 text-sm text-stone-500">This server can&apos;t store service logins (no TOKEN_ENC_KEY is set).</p>
  }
  const list = [...data.connectors].sort((a, b) => Number(b.linked) - Number(a.linked))
  return (
    <Card className="mt-3 divide-y divide-stone-100">
      {list.map((conn) => (
        <Service key={conn.id} session={session} conn={conn} onChange={reload} />
      ))}
    </Card>
  )
}

// Password, clear data, delete: what the website's account page did.
function Account({ session, onSession, onLogout }) {
  const [editing, setEditing] = useState(false)
  const [pw, setPw] = useState({ next: '', again: '' })
  const [busy, setBusy] = useState(null)
  const row = 'flex w-full items-center gap-3 px-4 py-3 text-left text-sm font-medium active:bg-stone-50'

  async function run(kind, fn) {
    setBusy(kind)
    try {
      await fn()
    } catch (e) {
      notify({ error: true, title: "That didn't work", detail: e.message })
    } finally {
      setBusy(null)
    }
  }
  const savePassword = (e) => {
    e.preventDefault()
    if (pw.next.length < 4) return notify({ error: true, title: 'Use at least 4 characters' })
    if (pw.next !== pw.again) return notify({ error: true, title: "The passwords don't match" })
    run('password', async () => {
      await api.changePassword(session, pw.next)
      onSession({ ...session, key: SparkMD5.hash(pw.next) })
      setEditing(false)
      setPw({ next: '', again: '' })
      notify({
        title: 'Password changed',
        detail: 'Enter the new one in CrossPoint Sync on your reader too.',
      })
    })
  }
  const clearData = () => {
    if (
      !confirm(
        'Clear all your reading data? Progress, clippings, stats and linked services are deleted. Your account stays, and readers sync again from scratch.',
      )
    )
      return
    run('clear', async () => {
      await api.clearData(session)
      notify({ title: 'Reading data cleared' })
      location.hash = '#/'
      location.reload()
    })
  }
  const deleteAccount = () => {
    const typed = prompt(`This deletes the account and everything in it, for good. Type ${session.username} to confirm.`)
    if (typed?.trim() !== session.username) return
    run('delete', async () => {
      await api.deleteAccount(session)
      onLogout()
    })
  }

  return (
    <Card className="mt-3 divide-y divide-stone-100">
      <button type="button" onClick={() => setEditing(!editing)} className={`${row} text-stone-800`}>
        <KeyRound className="size-4 text-stone-400" />
        <span className="flex-1">Change sync password</span>
        <ChevronRight className={`size-4 text-stone-400 transition ${editing ? 'rotate-90' : ''}`} />
      </button>
      {editing && (
        <form onSubmit={savePassword} className="space-y-2 px-4 py-3">
          <input
            className={field}
            type="password"
            placeholder="New password"
            value={pw.next}
            onChange={(e) => setPw({ ...pw, next: e.target.value })}
            autoComplete="new-password"
          />
          <input
            className={field}
            type="password"
            placeholder="New password again"
            value={pw.again}
            onChange={(e) => setPw({ ...pw, again: e.target.value })}
            autoComplete="new-password"
          />
          <button
            disabled={busy === 'password'}
            className="flex h-11 w-full items-center justify-center rounded-xl bg-brand-500 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-50"
          >
            {busy === 'password' ? <Loader2 className="size-4 animate-spin" /> : 'Save password'}
          </button>
        </form>
      )}
      <button type="button" disabled={!!busy} onClick={clearData} className={`${row} text-red-600`}>
        {busy === 'clear' ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        Clear reading data
      </button>
      <button type="button" disabled={!!busy} onClick={deleteAccount} className={`${row} text-red-600`}>
        {busy === 'delete' ? <Loader2 className="size-4 animate-spin" /> : <UserX className="size-4" />}
        Delete account
      </button>
    </Card>
  )
}

export default function Settings({ session, theme, onSession, onLogout }) {
  const host = new URL(session.server).host
  const section = 'mt-8 font-display text-xl font-semibold text-stone-900'
  return (
    <div className="max-w-2xl px-4 pt-6 pb-8 md:px-8 md:pt-6 lg:px-12">
      <Eyebrow className="md:hidden">Your account</Eyebrow>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-stone-900 md:mt-0 md:flex md:h-11 md:items-center md:text-4xl">Settings</h1>

      <Card className="mt-6 flex items-center gap-3 p-4">
        <div className="grid size-11 shrink-0 place-items-center rounded-full bg-brand-50 font-display text-lg font-semibold text-brand-700">
          {session.username.slice(0, 1).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-stone-900">{session.username}</p>
          <p className="truncate font-mono text-xs text-stone-500">{host}</p>
        </div>
      </Card>

      <h2 className={section}>Account</h2>
      <Account session={session} onSession={onSession} onLogout={onLogout} />

      <h2 className={section}>Appearance</h2>
      <div className="mt-3">
        <Appearance theme={theme} />
      </div>

      <h2 className={section}>Connected services</h2>
      <p className="mt-1 text-sm text-stone-500">Your reading syncs out to these as you go.</p>
      <Services session={session} />

      {isApp && (
        <>
          <h2 className={section}>Library</h2>
          <Card className="mt-3">
            <a href="#/browse/manage" className="flex items-center gap-3 px-4 py-3 text-sm font-medium text-stone-800 active:bg-stone-50">
              <Server className="size-5 text-stone-500" strokeWidth={1.75} />
              <span className="flex-1">Catalogs</span>
              <ChevronRight className="size-4 text-stone-400" />
            </a>
          </Card>
        </>
      )}

      <button
        type="button"
        onClick={onLogout}
        className="mt-8 flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-surface text-sm font-semibold text-red-600 ring-1 ring-stone-950/10 active:bg-stone-50"
      >
        <LogOut className="size-4" /> Sign out
      </button>
    </div>
  )
}

// One service's matches: which book there each synced title maps to. Fix wrong
// ones, pick one for books that didn't match, or stop syncing a book.
export function Matches({ session, id }) {
  const [conns] = useLoad(() => api.connectors(session), [session], `connectors ${session.username}@${session.server}`)
  const [books, error, reload] = useLoad(() => api.review(session, id), [session, id])
  const [picking, setPicking] = useState(null)
  const conn = conns?.connectors.find((c) => c.id === id)
  const name = conn?.name ?? id

  return (
    <div className="max-w-2xl px-4 pt-6 pb-8 md:px-8 md:pt-6 lg:px-12">
      <a href="#/settings" className="inline-flex items-center gap-1.5 text-sm font-medium text-stone-500">
        <ArrowLeft className="size-4" /> Settings
      </a>
      <h1 className="mt-3 font-display text-3xl font-semibold tracking-tight text-stone-900 md:text-4xl">{name} matches</h1>
      <p className="mt-1 text-sm/6 text-stone-500">Which book on {name} each title you read maps to. Fix any that matched wrong.</p>

      {error && !books ? (
        <p className="py-6 text-sm text-stone-500">Couldn&apos;t load matches ({error.message}).</p>
      ) : !books ? (
        <Card className="mt-4 divide-y divide-stone-100">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="space-y-2 px-4 py-3">
              <Bone className="h-4 w-2/3" />
              <Bone className="h-3 w-1/3" />
            </div>
          ))}
        </Card>
      ) : !books.length ? (
        <EmptyState icon={ListChecks} title="Nothing to match yet" note="Read something on your reader and it shows up here." />
      ) : (
        <Card className="mt-4 divide-y divide-stone-100">
          {books.map((b) => (
            <div key={b.document} className="px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-stone-900">{b.title || <span className="font-mono">{b.document.slice(0, 12)}…</span>}</p>
                  <p className="truncate text-xs text-stone-500">
                    {b.author && `${b.author} · `}
                    {b.matched ? (
                      <span className="text-emerald-700">{b.source === 'manual' ? 'Matched by you' : 'Matched'}</span>
                    ) : b.source === 'manual' ? (
                      'Not syncing'
                    ) : (
                      <span className="text-amber-700">Not matched</span>
                    )}
                  </p>
                  {b.push_note && <p className="mt-1 text-xs text-amber-700">{b.push_note}</p>}
                </div>
                <button
                  type="button"
                  onClick={() => setPicking(picking === b.document ? null : b.document)}
                  className="h-8 shrink-0 rounded-full px-3 text-sm font-semibold text-brand-600 ring-1 ring-brand-200 active:bg-brand-50"
                >
                  {picking === b.document ? 'Cancel' : b.matched ? 'Change' : 'Match'}
                </button>
              </div>
              {picking === b.document && (
                <Picker
                  session={session}
                  id={id}
                  name={name}
                  book={b}
                  onDone={() => {
                    setPicking(null)
                    reload()
                  }}
                />
              )}
            </div>
          ))}
        </Card>
      )}
    </div>
  )
}

export function Picker({ session, id, name, book, onDone }) {
  const [reading] = useLoad(() => api.candidates(session, id).catch(() => []), [session, id], `candidates ${id}`)
  const [q, setQ] = useState(book.title ?? '')
  const [results, setResults] = useState(null)
  const [busy, setBusy] = useState(false)
  async function search(text) {
    if (!text.trim()) return
    setResults(null)
    setResults(await api.searchConnector(session, id, text.trim()).catch(() => []))
  }
  useEffect(() => {
    if (book.title) search(book.title)
    else setResults([])
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  async function choose(pick) {
    setBusy(true)
    try {
      await api.setMatch(session, id, book.document, pick)
      notify({
        title: pick ? `Matched to ${pick.title}` : `${book.title || 'Book'} won't sync to ${name}`,
      })
      onDone()
    } catch (e) {
      notify({
        error: true,
        title: "Couldn't save the match",
        detail: e.message,
      })
      setBusy(false)
    }
  }
  const rows = (list) =>
    list.map((c) => (
      <button
        key={c.externalId}
        type="button"
        disabled={busy}
        onClick={() => choose(c)}
        className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left active:bg-stone-50 md:hover:bg-stone-50"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm text-stone-900">{c.title}</span>
          {c.author && <span className="block truncate text-xs text-stone-500">{c.author}</span>}
        </span>
        <span className="text-xs font-semibold text-brand-600">Use</span>
      </button>
    ))
  const group = 'mt-3 px-2 text-[0.65rem] font-semibold tracking-wider text-stone-400 uppercase'

  return (
    <div className="mt-3 rounded-xl bg-stone-50 p-2">
      {reading?.length > 0 && (
        <>
          <p className={group}>Currently reading</p>
          {rows(reading)}
        </>
      )}
      <p className={group}>Results</p>
      {results === null ? (
        <Loader2 className="mx-auto my-3 size-4 animate-spin text-stone-400" />
      ) : results.length ? (
        rows(results)
      ) : (
        <p className="px-2 py-2 text-sm text-stone-500">No matches found.</p>
      )}
      <form
        className="mt-2 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          search(q)
        }}
      >
        <input className={`${field} bg-surface`} placeholder={`Search ${name}`} value={q} onChange={(e) => setQ(e.target.value)} />
        <button aria-label="Search" className="grid size-11 shrink-0 place-items-center rounded-xl bg-brand-500 text-white">
          <Search className="size-4" />
        </button>
      </form>
      <button type="button" disabled={busy} onClick={() => choose(null)} className="mt-2 w-full py-2 text-sm font-medium text-stone-500">
        Don&apos;t sync this book
      </button>
    </div>
  )
}
