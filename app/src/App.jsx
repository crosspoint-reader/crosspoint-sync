import { useEffect, useRef, useState } from 'react'
import { ChartColumn, CloudOff, Compass, Quote, Eye, EyeOff, LibraryBig, Loader2, Lock, LogOut, Monitor, Moon, Send as SendIcon, Server, Settings, Sun, User } from 'lucide-react'
import { useTheme } from './theme.js'
import { DEFAULT_SERVER, api, lastServer, loadSession, login, logout, offline } from './api.js'
import { ErrorNote, Spinner, Toaster, useLoad } from './ui.jsx'
import Library from './Library.jsx'
import Book from './Book.jsx'
import Stats from './Stats.jsx'
import Send from './Send.jsx'
import Wallpaper from './Wallpaper.jsx'
import Browse from './Browse.jsx'
import Clippings from './Clippings.jsx'
import { updateWidget } from './widget.js'

// A filled, full-width field with a leading icon: the native mobile idiom.
function Field({ icon: Icon, trailing, inputRef, ...props }) {
  return (
    <label className="flex h-14 items-center gap-3 rounded-2xl bg-surface px-4 ring-1 ring-stone-950/10 transition focus-within:ring-2 focus-within:ring-brand-500/60">
      <Icon className="size-5 shrink-0 text-stone-400" strokeWidth={1.75} />
      <input
        ref={inputRef}
        required
        className="h-full min-w-0 flex-1 bg-transparent text-base text-stone-900 outline-none placeholder:text-stone-400"
        {...props}
      />
      {trailing}
    </label>
  )
}

function Login({ onLogin }) {
  const [form, setForm] = useState(() => {
    const server = lastServer()
    return { selfHosted: server !== DEFAULT_SERVER, server: server === DEFAULT_SERVER ? '' : server, username: '', password: '' }
  })
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const passwordRef = useRef(null)
  const usernameRef = useRef(null)
  const set = (name) => (e) => setForm({ ...form, [name]: e.target.value })
  // Keyboard "Next" moves to the following field instead of submitting early.
  const next = (ref) => (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      ref.current?.focus()
    }
  }

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      onLogin(await login(form.selfHosted ? form.server : DEFAULT_SERVER, form.username, form.password))
    } catch (err) {
      setError(err.status === 401 ? 'Wrong username or password.' : err.message)
    }
    setBusy(false)
  }

  return (
    <div className="flex min-h-dvh flex-col bg-stone-50 md:flex-row">
      <div className="relative m-3 h-[36dvh] min-h-60 shrink-0 overflow-hidden rounded-[28px] bg-brand-900 md:m-4 md:h-auto md:flex-1">
        <img src="/hero.jpg" alt="" className="absolute inset-0 size-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-brand-950/95 via-brand-950/40 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-6 md:p-10">
          <img src="/logo.png" alt="" className="size-12 rounded-xl ring-1 ring-white/20 md:size-14" />
          <p className="mt-4 inline-block -rotate-1 font-hand text-2xl/7 text-brand-200">Your reading, everywhere</p>
          <h1 className="font-display text-3xl/tight font-semibold tracking-tight text-white md:text-5xl/tight">CrossPoint Sync</h1>
          <p className="mt-2 hidden max-w-md text-base/7 text-white/75 md:block">
            Progress, clippings and reading stats from every CrossPoint and CrossInk reader, in one place.
          </p>
        </div>
      </div>

      <form
        onSubmit={submit}
        className="flex flex-1 flex-col px-5 pt-4 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:max-w-md md:justify-center md:px-10 lg:max-w-lg lg:px-16"
      >
        <h2 className="font-display text-2xl font-semibold text-stone-900">Sign in</h2>
        <p className="mt-1 text-sm/6 text-stone-500">Use the username and password from CrossPoint Sync on your reader.</p>

        <div className="mt-5 grid grid-cols-2 gap-1 rounded-2xl bg-stone-200/60 p-1">
          {[
            [false, 'CrossPoint'],
            [true, 'Self-hosted'],
          ].map(([v, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => setForm({ ...form, selfHosted: v })}
              className={`h-10 rounded-xl text-sm font-semibold transition ${
                form.selfHosted === v ? 'bg-raised text-stone-900 shadow-sm' : 'text-stone-500 active:bg-stone-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="mt-3 space-y-3">
          {form.selfHosted ? (
            <Field
              icon={Server}
              value={form.server}
              onChange={set('server')}
              onKeyDown={next(usernameRef)}
              placeholder="192.168.1.20:8080 or sync.example.com"
              inputMode="url"
              enterKeyHint="next"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
            />
          ) : (
            <p className="flex items-center gap-2 px-1 font-mono text-xs text-stone-500">
              <Server className="size-3.5" /> {new URL(DEFAULT_SERVER).host}
            </p>
          )}
          <Field
            icon={User}
            inputRef={usernameRef}
            value={form.username}
            onChange={set('username')}
            onKeyDown={next(passwordRef)}
            placeholder="Username"
            autoComplete="username"
            enterKeyHint="next"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <Field
            icon={Lock}
            inputRef={passwordRef}
            value={form.password}
            onChange={set('password')}
            placeholder="Password"
            type={showPassword ? 'text' : 'password'}
            autoComplete="current-password"
            enterKeyHint="go"
            trailing={
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="-mr-2 grid size-10 place-items-center rounded-full text-stone-400 active:bg-stone-100"
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOff className="size-5" strokeWidth={1.75} /> : <Eye className="size-5" strokeWidth={1.75} />}
              </button>
            }
          />
        </div>

        {error && <p className="mt-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>}

        <div className="mt-auto pt-6 md:mt-8">
          <button
            disabled={busy}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 text-base font-semibold text-white shadow-sm transition active:scale-[0.98] active:bg-brand-600 disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-5 animate-spin" /> : 'Sign in'}
          </button>
          <p className="mt-4 text-center text-xs/5 text-stone-500">
            No account yet? Create one on your reader under Settings, CrossPoint Sync.
          </p>
        </div>
      </form>
    </div>
  )
}

function useHash() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => {
      setHash(location.hash)
      window.scrollTo(0, 0)
    }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return hash.replace(/^#\/?/, '').split('/')
}

const NAV = [
  { href: '#/', label: 'Library', icon: LibraryBig, active: (r) => !['stats', 'send', 'browse', 'clippings'].includes(r) },
  { href: '#/browse', label: 'Browse', icon: Compass, active: (r) => r === 'browse' },
  { href: '#/clippings', label: 'Clippings', icon: Quote, active: (r) => r === 'clippings' },
  { href: '#/stats', label: 'Stats', icon: ChartColumn, active: (r) => r === 'stats' },
  { href: '#/send', label: 'Send', icon: SendIcon, active: (r) => r === 'send' },
]

// Phone: bottom tab bar.
function TabBar({ route }) {
  const cls = (active) =>
    `flex flex-1 flex-col items-center gap-0.5 pt-2 pb-1.5 text-[0.7rem] font-semibold ${active ? 'text-brand-600' : 'text-stone-500'}`
  return (
    <nav className="fixed inset-x-0 bottom-0 border-t border-stone-200 bg-surface/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      <div className="mx-auto flex max-w-xl">
        {NAV.map((n) => (
          <a key={n.href} href={n.href} className={cls(n.active(route))}>
            <n.icon className="size-6" strokeWidth={1.75} />
            {n.label}
          </a>
        ))}
      </div>
    </nav>
  )
}

// Appearance: follow the system, or force light or dark.
const THEMES = [
  ['system', 'System', Monitor],
  ['light', 'Light', Sun],
  ['dark', 'Dark', Moon],
]
function Appearance({ theme: [pref, setPref], className = '' }) {
  return (
    <div className={`grid grid-cols-3 gap-1 rounded-xl bg-stone-200/60 p-1 ${className}`} role="radiogroup" aria-label="Appearance">
      {THEMES.map(([v, label, Icon]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={pref === v}
          onClick={() => setPref(v)}
          className={`flex h-9 flex-col items-center justify-center rounded-lg text-[0.7rem] font-semibold transition ${
            pref === v ? 'bg-raised text-stone-900 shadow-sm' : 'text-stone-500 active:bg-stone-200'
          }`}
        >
          <Icon className="size-3.5" strokeWidth={2} />
          {label}
        </button>
      ))}
    </div>
  )
}

// Phone: account icon top right; tapping opens a small menu so sign out is one deliberate step away.
function AccountMenu({ session, onLogout, theme }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="absolute top-4 right-3 z-20 md:hidden">
      <button
        onClick={() => setOpen(!open)}
        className="grid size-11 place-items-center rounded-full text-stone-600 active:bg-stone-200/70"
        aria-label="Settings"
        aria-expanded={open}
      >
        <Settings className="size-6" strokeWidth={1.75} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0" onClick={() => setOpen(false)} />
          <div className="absolute right-0 mt-1 w-64 overflow-hidden rounded-2xl bg-surface shadow-lg ring-1 ring-stone-950/10">
            <div className="px-4 py-3">
              <p className="truncate text-sm font-semibold text-stone-900">{session.username}</p>
              <p className="truncate font-mono text-xs text-stone-500">{new URL(session.server).host}</p>
            </div>
            <div className="border-t border-stone-100 px-3 py-3">
              <Appearance theme={theme} />
            </div>
            <a
              href="#/browse/manage"
              onClick={() => setOpen(false)}
              className="flex w-full items-center gap-3 border-t border-stone-100 px-4 py-3 text-sm font-medium text-stone-700 active:bg-stone-50"
            >
              <Server className="size-4" strokeWidth={1.75} />
              Catalogs
            </a>
            <button
              onClick={onLogout}
              className="flex w-full items-center gap-3 border-t border-stone-100 px-4 py-3 text-sm font-medium text-red-600 active:bg-stone-50"
            >
              <LogOut className="size-4" strokeWidth={1.75} />
              Sign out
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// iPad / desktop: sidebar.
function Sidebar({ route, session, onLogout, theme }) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-stone-200 bg-surface/60 px-4 py-6 md:flex lg:w-64">
      {/* 44px band at the top, matching each page's first row (back button / title). */}
      <div className="flex h-11 items-center gap-2.5 px-2">
        <img src="/logo.png" alt="" className="size-8 rounded-lg" />
        <span className="font-display text-lg font-semibold text-stone-900">CrossPoint Sync</span>
      </div>
      <nav className="mt-8 space-y-1">
        {NAV.map((n) => (
          <a
            key={n.href}
            href={n.href}
            className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-semibold transition ${
              n.active(route) ? 'bg-brand-50 text-brand-700' : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900'
            }`}
          >
            <n.icon className="size-5" strokeWidth={1.75} />
            {n.label}
          </a>
        ))}
      </nav>
      <div className="mt-auto border-t border-stone-200 px-2 pt-4">
        <p className="truncate text-sm font-medium text-stone-900">{session.username}</p>
        <p className="truncate font-mono text-xs text-stone-500">{new URL(session.server).host}</p>
        <Appearance theme={theme} className="mt-3" />
        <a href="#/browse/manage" className="mt-3 flex items-center gap-2 text-sm font-medium text-stone-500 hover:text-stone-900">
          <Server className="size-4" strokeWidth={1.75} />
          Catalogs
        </a>
        <button
          onClick={onLogout}
          className="mt-2 flex items-center gap-2 text-sm font-medium text-stone-500 hover:text-stone-900"
        >
          <LogOut className="size-4" strokeWidth={1.75} />
          Sign out
        </button>
      </div>
    </aside>
  )
}

function Home({ session, onLogout, theme }) {
  const parts = useHash()
  // Offline: api.js serves the last saved copy and says so; show a slim notice until the network is back.
  const [isOffline, setOffline] = useState(false)
  useEffect(() => {
    const on = () => setOffline(true)
    const off = () => setOffline(false)
    offline.addEventListener('offline', on)
    offline.addEventListener('online', off)
    return () => {
      offline.removeEventListener('offline', on)
      offline.removeEventListener('online', off)
    }
  }, [])
  const [route, id] = parts
  const [books, error, reloadBooks] = useLoad(() => api.books(session), [session])
  const [summary, , reloadSummary] = useLoad(() => api.summary(session), [session])
  const [activity, , reloadActivity] = useLoad(() => api.activity(session), [session])
  useEffect(() => {
    updateWidget({ books, summary, activity })
  }, [books, summary, activity])

  useEffect(() => {
    if (error?.status === 401) onLogout()
  }, [error, onLogout])
  useEffect(() => {
    const on = () => {
      if (document.visibilityState === 'visible') {
        reloadBooks()
        reloadSummary()
        reloadActivity()
      }
    }
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  })

  let page
  if (route === 'send') page = id === 'wallpaper' ? <Wallpaper /> : <Send />
  else if (route === 'browse') page = <Browse parts={parts} />
  else if (error) page = <ErrorNote error={error} />
  else if (!books) page = <Spinner />
  else if (route === 'clippings') page = <Clippings session={session} books={books} />
  else if (route === 'stats') page = <Stats session={session} tab={id} summary={summary} activity={activity} books={books} />
  else if (route === 'book') page = (
      <Book
        session={session}
        book={books.find((b) => b.document === id)}
        books={books}
        activity={activity?.books.find((b) => b.document === id)}
        onChange={() => {
          reloadBooks()
          reloadActivity()
        }}
      />
    )
  else page = <Library session={session} books={books} summary={summary} activity={activity} />

  return (
    <div className="min-h-dvh md:flex">
      <Sidebar route={route} session={session} onLogout={onLogout} theme={theme} />
      <main className="relative mx-auto w-full max-w-xl pb-24 md:max-w-6xl md:pb-10">
        {isOffline && (
          <div className="sticky top-0 z-30 flex items-center justify-center gap-2 bg-stone-800 px-4 py-2 text-xs font-medium text-stone-100">
            <CloudOff className="size-3.5" /> Offline. Showing what was saved on this device.
          </div>
        )}
        <AccountMenu key={parts.join('/')} session={session} onLogout={onLogout} theme={theme} />
        <Toaster />
        {page}
      </main>
      <TabBar route={route} />
    </div>
  )
}

export default function App() {
  const theme = useTheme()
  const [session, setSession] = useState(loadSession)
  if (!session) return <Login onLogin={setSession} />
  return (
    <Home
      session={session}
      theme={theme}
      onLogout={() => {
        logout()
        setSession(null)
      }}
    />
  )
}
