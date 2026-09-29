import { useEffect, useState } from 'react'
import { ChartColumn, LibraryBig, LogOut } from 'lucide-react'
import { DEFAULT_SERVER, api, lastServer, loadSession, login, logout } from './api.js'
import { Card, ErrorNote, Eyebrow, Spinner, useLoad } from './ui.jsx'
import Library from './Library.jsx'
import Book from './Book.jsx'
import Stats from './Stats.jsx'

const inputClass =
  'mt-1 w-full rounded-lg border border-stone-200 bg-stone-50 px-4 py-2.5 text-base text-stone-900 placeholder:text-stone-400 focus:border-brand-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20'

function Login({ onLogin }) {
  const [form, setForm] = useState(() => {
    const server = lastServer()
    return { selfHosted: server !== DEFAULT_SERVER, server: server === DEFAULT_SERVER ? '' : server, username: '', password: '' }
  })
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const field = (name, label, props) => (
    <label className="block text-sm font-medium text-stone-700">
      {label}
      <input
        {...props}
        required
        value={form[name]}
        onChange={(e) => setForm({ ...form, [name]: e.target.value })}
        className={inputClass}
      />
    </label>
  )
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
    <div className="relative mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-6">
      <div className="dot-field pointer-events-none absolute inset-x-0 top-0 h-64 text-stone-200 [mask-image:linear-gradient(to_bottom,black,transparent)]" />
      <div className="relative flex flex-col items-center text-center">
        <img src="/logo.png" alt="" className="size-14 rounded-2xl" />
        <Eyebrow className="mt-4">Your reading, everywhere</Eyebrow>
        <h1 className="mt-2 font-display text-3xl font-semibold tracking-tight text-stone-900">CrossPoint Sync</h1>
        <p className="mt-2 text-sm text-stone-600">Sign in with the sync account your reader uses.</p>
      </div>
      <Card className="relative mt-8 p-6">
        <form onSubmit={submit} className="space-y-4">
          <div>
            <p className="text-sm font-medium text-stone-700">Server</p>
            <div className="mt-1 grid grid-cols-2 gap-1 rounded-lg bg-stone-100 p-1">
              {[
                [false, 'CrossPoint'],
                [true, 'Self-hosted'],
              ].map(([v, label]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setForm({ ...form, selfHosted: v })}
                  className={`rounded-md py-1.5 text-sm font-semibold transition ${
                    form.selfHosted === v ? 'bg-white text-stone-900 shadow-sm ring-1 ring-stone-950/5' : 'text-stone-500'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            {form.selfHosted ? (
              <input
                required
                inputMode="url"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                placeholder="192.168.1.20:8080 or sync.example.com"
                value={form.server}
                onChange={(e) => setForm({ ...form, server: e.target.value })}
                className={`${inputClass} mt-2`}
              />
            ) : (
              <p className="mt-2 font-mono text-xs text-stone-500">{new URL(DEFAULT_SERVER).host}</p>
            )}
          </div>
          {field('username', 'Username', { autoComplete: 'username', autoCapitalize: 'none', spellCheck: false })}
          {field('password', 'Password', { type: 'password', autoComplete: 'current-password' })}
          {error && <p className="text-sm text-red-600">{error}</p>}
          <button
            disabled={busy}
            className="w-full rounded-md bg-brand-500 px-3.5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-brand-600 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </Card>
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
  { href: '#/', label: 'Library', icon: LibraryBig, active: (r) => r !== 'stats' },
  { href: '#/stats', label: 'Stats', icon: ChartColumn, active: (r) => r === 'stats' },
]

// Phone: bottom tab bar.
function TabBar({ route, onLogout }) {
  const cls = (active) =>
    `flex flex-1 flex-col items-center gap-0.5 pt-2 pb-1.5 text-[0.7rem] font-semibold ${active ? 'text-brand-600' : 'text-stone-500'}`
  return (
    <nav className="fixed inset-x-0 bottom-0 border-t border-stone-200 bg-white/90 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      <div className="mx-auto flex max-w-xl">
        {NAV.map((n) => (
          <a key={n.href} href={n.href} className={cls(n.active(route))}>
            <n.icon className="size-6" strokeWidth={1.75} />
            {n.label}
          </a>
        ))}
        <button onClick={onLogout} className={cls(false)}>
          <LogOut className="size-6" strokeWidth={1.75} />
          Sign out
        </button>
      </div>
    </nav>
  )
}

// iPad / desktop: sidebar.
function Sidebar({ route, session, onLogout }) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-60 shrink-0 flex-col border-r border-stone-200 bg-white/60 px-4 py-6 md:flex lg:w-64">
      <div className="flex items-center gap-2.5 px-2">
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
        <button
          onClick={onLogout}
          className="mt-3 flex items-center gap-2 text-sm font-medium text-stone-500 hover:text-stone-900"
        >
          <LogOut className="size-4" strokeWidth={1.75} />
          Sign out
        </button>
      </div>
    </aside>
  )
}

function Home({ session, onLogout }) {
  const [route, id] = useHash()
  const [books, error, reloadBooks] = useLoad(() => api.books(session), [session])
  const [summary, , reloadSummary] = useLoad(() => api.summary(session), [session])
  const [activity, , reloadActivity] = useLoad(() => api.activity(session), [session])

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
  if (error) page = <ErrorNote error={error} />
  else if (!books) page = <Spinner />
  else if (route === 'stats') page = <Stats summary={summary} activity={activity} books={books} />
  else if (route === 'book') page = (
      <Book
        session={session}
        book={books.find((b) => b.document === id)}
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
      <Sidebar route={route} session={session} onLogout={onLogout} />
      <main className="mx-auto w-full max-w-xl pb-24 md:max-w-6xl md:pb-10">{page}</main>
      <TabBar route={route} onLogout={onLogout} />
    </div>
  )
}

export default function App() {
  const [session, setSession] = useState(loadSession)
  if (!session) return <Login onLogin={setSession} />
  return (
    <Home
      session={session}
      onLogout={() => {
        logout()
        setSession(null)
      }}
    />
  )
}
