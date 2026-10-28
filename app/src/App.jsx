import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { ChartColumn, CloudOff, Compass, Quote, Eye, EyeOff, LibraryBig, Loader2, Lock, Send as SendIcon, Server, Settings as SettingsIcon, User } from 'lucide-react'
import { useTheme } from './theme.js'
import { DEFAULT_SERVER, syncShortcutsCache, api, hostedServer, isApp, lastServer, loadSession, login, logout, offline, cached, register, saveSession } from './api.js'
import { ErrorNote, LoadCacheProvider, PageSkeleton, RefreshPill, Toaster, useLoad } from './ui.jsx'
import Library from './Library.jsx'
import Book from './Book.jsx'
import Stats from './Stats.jsx'
import Send from './Send.jsx'
import Wallpaper from './Wallpaper.jsx'
import Settings, { Matches } from './Settings.jsx'
import Browse from './Browse.jsx'
import Clippings from './Clippings.jsx'
import { clearWidget, updateWidget } from './widget.js'
import InstallPrompt from './Install.jsx'
import { mountTabBar, nativeTabBar, selectNativeTab, useNativeButton } from './tabbar.js'

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
  const [creating, setCreating] = useState(false) // create an account instead of signing in
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const passwordRef = useRef(null)
  const usernameRef = useRef(null)
  // Functional update: a password manager fills both fields in one go, and spreading
  // this render's `form` would let the second fill wipe out the first.
  const set = (name) => (e) => {
    const value = e.target.value
    setForm((f) => ({ ...f, [name]: value }))
  }
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
      const server = hostedServer ?? (form.selfHosted ? form.server : DEFAULT_SERVER)
      // What the fields show, even if autofill set them without an input event.
      const username = usernameRef.current?.value ?? form.username
      const password = passwordRef.current?.value ?? form.password
      if (creating && password.length < 4) throw new Error('Pick a password of at least 4 characters.')
      onLogin(await (creating ? register : login)(server, username, password))
    } catch (err) {
      setError(err.status === 401 ? 'Wrong username or password.' : err.message)
    }
    setBusy(false)
  }

  return (
    <div className="flex min-h-screen-safe flex-col bg-stone-50 md:flex-row">
      <div className="relative m-3 h-[36dvh] min-h-60 shrink-0 overflow-hidden rounded-[28px] bg-brand-900 md:m-4 md:h-auto md:flex-1">
        <img src={`${import.meta.env.BASE_URL}hero.jpg`} alt="" className="absolute inset-0 size-full object-cover" />
        <div className="absolute inset-0 bg-gradient-to-t from-brand-950/95 via-brand-950/40 to-transparent" />
        <div className="absolute inset-x-0 bottom-0 p-6 md:p-10">
          <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="size-12 rounded-xl ring-1 ring-white/20 md:size-14" />
          <p className="mt-4 inline-block -rotate-1 font-hand text-2xl/7 text-brand-200">Your reading, everywhere</p>
          <h1 className="font-display text-3xl/tight font-semibold tracking-tight text-white md:text-5xl/tight">CrossPoint Sync</h1>
          <p className="mt-2 hidden max-w-md text-base/7 text-white/75 md:block">
            Progress, clippings and reading stats from every CrossPoint and CrossInk reader, in one place.
          </p>
        </div>
      </div>

      <form
        onSubmit={submit}
        className="flex flex-1 flex-col px-5 pt-4 pb-5 md:max-w-md md:justify-center md:px-10 lg:max-w-lg lg:px-16"
      >
        <h2 className="font-display text-2xl font-semibold text-stone-900">{creating ? 'Create your account' : 'Sign in'}</h2>
        <p className="mt-1 text-sm/6 text-stone-500">
          {creating ? 'Pick a username and password, then use the same ones in CrossPoint Sync on your reader.' : 'Use the username and password from CrossPoint Sync on your reader.'}
        </p>

        {!hostedServer && (
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
        )}

        <div className="mt-3 space-y-3">
          {hostedServer ? null : form.selfHosted ? (
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

        <div className="mx-auto mt-auto w-full max-w-sm px-2 pt-6 md:mt-8 md:max-w-none md:px-0">
          <button
            disabled={busy}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 text-base font-semibold text-white shadow-sm transition active:scale-[0.98] active:bg-brand-600 disabled:opacity-60"
          >
            {busy ? <Loader2 className="size-5 animate-spin" /> : creating ? 'Create account' : 'Sign in'}
          </button>
          <p className="mt-4 text-center text-sm text-stone-500">
            {creating ? 'Already have an account?' : 'No account yet?'}{' '}
            <button
              type="button"
              onClick={() => {
                setCreating(!creating)
                setError(null)
              }}
              className="font-semibold text-brand-600"
            >
              {creating ? 'Sign in' : 'Create one'}
            </button>
          </p>
        </div>
      </form>
    </div>
  )
}

const isBook = (hash) => hash.startsWith('#/book/')

// The current route, and the last page that wasn't a book: where a book's back
// button returns to (library, stats tab, clippings...).
function useHash() {
  const [hash, setHash] = useState(location.hash)
  const from = useRef(isBook(location.hash) ? '#/' : location.hash || '#/')
  useEffect(() => {
    const on = () => {
      if (!isBook(location.hash)) from.current = location.hash || '#/'
      setHash(location.hash)
      window.scrollTo(0, 0)
    }
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  return [hash.replace(/^#\/?/, '').split('/'), from.current]
}

const BACK_LABELS = { stats: 'Stats', clippings: 'Clippings', browse: 'Browse', settings: 'Settings' }
const backTo = (hash) => ({ href: hash, label: BACK_LABELS[hash.replace(/^#\/?/, '').split('/')[0]] ?? 'Library' })

const NAV = [
  { href: '#/', label: 'Library', icon: LibraryBig, sf: 'books.vertical', active: (r) => !['stats', 'send', 'browse', 'clippings', 'settings'].includes(r) },
  // Browse and Send need the app (catalog access and the reader on your Wi-Fi), so the web leaves them out.
  ...(isApp ? [{ href: '#/browse', label: 'Browse', icon: Compass, sf: 'safari', active: (r) => r === 'browse' }] : []),
  { href: '#/clippings', label: 'Clippings', icon: Quote, sf: 'quote.opening', active: (r) => r === 'clippings' },
  { href: '#/stats', label: 'Stats', icon: ChartColumn, sf: 'chart.bar', active: (r) => r === 'stats' },
  ...(isApp ? [{ href: '#/send', label: 'Send', icon: SendIcon, sf: 'paperplane', active: (r) => r === 'send' }] : []),
]

function endRefresh() {
  window.CrossPointRefresh?.done() // Android
  if (isApp) invoke('end_refresh').catch(() => {}) // iOS
}

// Phone: bottom tab bar (native on iPhone, see tabbar.js).
function TabBar({ route }) {
  const current = NAV.find((n) => n.active(route))?.href
  useEffect(() => {
    if (nativeTabBar) return mountTabBar(NAV.map((n) => ({ id: n.href, title: n.label, sfSymbol: n.sf })), current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (nativeTabBar && current) selectNativeTab(current)
  }, [current])
  if (nativeTabBar) return null
  const cls = (active) =>
    `flex flex-1 flex-col items-center gap-0.5 pt-2 pb-1.5 text-[0.7rem] font-semibold ${active ? 'text-brand-600' : 'text-stone-500'}`
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-200 bg-surface/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
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

// Phone: settings gear top right of the Library, opening the Settings page.
function SettingsLink() {
  useNativeButton('settings', { sfSymbol: 'gearshape', anchor: 'topTrailing' }, () => (location.hash = '#/settings'))
  return (
    <a
      href="#/settings"
      aria-label="Settings"
      className="native-hide absolute top-4 right-3 z-20 grid size-11 place-items-center rounded-full text-stone-600 active:bg-stone-200/70 md:hidden"
    >
      <SettingsIcon className="size-6" strokeWidth={1.75} />
    </a>
  )
}

// iPad / desktop: sidebar.
function Sidebar({ route, session }) {
  return (
    <aside className="sticky top-[env(safe-area-inset-top)] hidden h-screen-safe w-60 shrink-0 flex-col border-r border-stone-200 bg-surface/60 px-4 py-6 md:flex lg:w-64">
      {/* 44px band at the top, matching each page's first row (back button / title). */}
      <div className="flex h-11 items-center gap-2.5 px-2">
        <img src={`${import.meta.env.BASE_URL}logo.png`} alt="" className="size-8 rounded-lg" />
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
      <div className="mt-auto border-t border-stone-200 pt-4">
        <a
          href="#/settings"
          className={`flex items-center gap-3 rounded-lg px-3 py-2 transition ${
            route === 'settings' ? 'bg-brand-50 text-brand-700' : 'text-stone-600 hover:bg-stone-100 hover:text-stone-900'
          }`}
        >
          <SettingsIcon className="size-5 shrink-0" strokeWidth={1.75} />
          <span className="min-w-0">
            <span className="block text-sm font-semibold">Settings</span>
            <span className="block truncate font-mono text-xs text-stone-500">
              {session.username} · {new URL(session.server).host}
            </span>
          </span>
        </a>
      </div>
    </aside>
  )
}

function Home({ session, onSession, onLogout, theme }) {
  useEffect(() => { syncShortcutsCache(session) }, [session])
  const [parts, from] = useHash()
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
  // Start from the saved copies so launch paints the library at once, then refresh.
  const [books, error, reloadBooks, booksLoading] = useLoad(() => api.books(session), [session], undefined, () => cached.books(session))
  const [summary, , reloadSummary] = useLoad(() => api.summary(session), [session], undefined, () => cached.summary(session))
  const [activity, activityError, reloadActivity, activityLoading, activityUpdatedAt] = useLoad(
    () => api.activity(session), [session], undefined, () => cached.activity(session),
    { retries: 2, reportRefreshErrors: true, initialUpdatedAt: () => cached.activityUpdatedAt(session) }
  )
  useEffect(() => {
    updateWidget({ session, books, summary, activity })
  }, [session, books, summary, activity])

  useEffect(() => {
    if (error?.status === 401 || activityError?.status === 401) onLogout()
  }, [error, activityError, onLogout])
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

  // Native pull-to-refresh (iOS refresh control, Android SwipeRefreshLayout): reload
  // everything, then let the spinner go once the books are back.
  const [pulling, setPulling] = useState(false)
  const sawLoading = useRef(false)
  useEffect(() => {
    const on = () => {
      sawLoading.current = false
      setPulling(true)
      reloadBooks()
      reloadSummary()
      reloadActivity()
    }
    addEventListener('crosspoint-refresh', on)
    return () => removeEventListener('crosspoint-refresh', on)
  })
  useEffect(() => {
    if (!pulling) return
    if (booksLoading) sawLoading.current = true
    else if (sawLoading.current) setPulling(false)
  }, [pulling, booksLoading])
  useEffect(() => {
    if (!pulling) return endRefresh()
    const t = setTimeout(() => setPulling(false), 15000) // never leave it spinning
    return () => clearTimeout(t)
  }, [pulling])

  let page
  if (route === 'settings') page = id ? <Matches session={session} id={id} /> : <Settings session={session} theme={theme} onSession={onSession} onLogout={onLogout} />
  else if (route === 'send' && isApp) page = id === 'wallpaper' ? <Wallpaper /> : <Send />
  else if (route === 'browse' && isApp) page = <Browse parts={parts} />
  else if (error) page = <ErrorNote error={error} />
  else if (!books) page = <PageSkeleton route={route} />
  else if (route === 'clippings') page = <Clippings session={session} books={books} />
  else if (route === 'stats') page = (
    <Stats session={session} tab={id} summary={summary} activity={activity} books={books}
      activityError={activityError} activityLoading={activityLoading} activityUpdatedAt={activityUpdatedAt} onRetryActivity={reloadActivity} />
  )
  else if (route === 'book') page = (
      <Book
        session={session}
        book={books.find((b) => b.document === id)}
        books={books}
        back={backTo(from)}
        activity={activity?.books.find((b) => b.document === id)}
        onChange={() => {
          reloadBooks()
          reloadActivity()
        }}
      />
    )
  else page = <Library session={session} books={books} summary={summary} activity={activity} />

  return (
    <div className="min-h-screen-safe md:flex">
      <Sidebar route={route} session={session} />
      <main className="relative mx-auto w-full min-w-0 max-w-xl pb-24 md:max-w-6xl md:pb-10">
        {isOffline && (
          <div className="sticky top-[env(safe-area-inset-top)] z-30 flex items-center justify-center gap-2 bg-stone-800 px-4 py-2 text-xs font-medium text-stone-100">
            <CloudOff className="size-3.5" /> Offline. Showing what was saved on this device.
          </div>
        )}
        {/* Settings opens from the Library only; sub-screens have a back link instead. */}
        {parts.length < 2 && NAV[0].active(route) && <SettingsLink />}
        <RefreshPill active={booksLoading && !!books && !pulling} />
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
  useEffect(() => {
    if (!session) {
      clearWidget()
      syncShortcutsCache(null)
    }
  }, [session])
  if (!session) return <Login onLogin={(s) => (window.scrollTo(0, 0), setSession(s))} />
  return (
    <LoadCacheProvider key={JSON.stringify([session.server, session.username])}>
      <Home
        session={session}
        theme={theme}
        onSession={(s) => {
          saveSession(s)
          setSession(s)
        }}
        onLogout={() => {
          logout()
          setSession(null)
        }}
      />
      {/* After sign-in, so the card never covers the sign-in button. */}
      <InstallPrompt />
    </LoadCacheProvider>
  )
}
