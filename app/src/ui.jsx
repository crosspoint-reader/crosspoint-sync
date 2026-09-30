import { useEffect, useState } from 'react'
import { BookOpen, CircleAlert, CircleCheck, CircleX, Pause } from 'lucide-react'
import { api } from './api.js'

export const STATUS = [
  { id: 'reading', label: 'Reading', icon: BookOpen },
  { id: 'paused', label: 'Paused', icon: Pause },
  { id: 'finished', label: 'Finished', icon: CircleCheck },
  { id: 'dnf', label: 'Did Not Finish', icon: CircleX },
]

// Handwritten margin-note eyebrow, same as crosspoint-tools ui.jsx.
export function Eyebrow({ children, className = '' }) {
  return (
    <p className={`inline-block -rotate-1 font-hand text-xl/6 font-medium text-brand-600 ${className}`}>
      {children}
    </p>
  )
}

export function Card({ className = '', children }) {
  return <div className={`rounded-xl bg-surface ring-1 ring-stone-950/5 ${className}`}>{children}</div>
}

export function ProgressBar({ value, className = '' }) {
  return (
    <div className={`h-1.5 overflow-hidden rounded-full bg-stone-200 ${className}`}>
      <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  )
}

// Server-resolved cover (cached server-side). Falls back to an e-ink "title page".
export function Cover({ session, book, small = false, className = '' }) {
  const [url, setUrl] = useState(book.cover_url)
  const [broken, setBroken] = useState(false)
  useEffect(() => {
    if (book.cover_url || !book.title) return
    let live = true
    api.cover(session, book.document).then((r) => live && setUrl(r.url), () => {})
    return () => {
      live = false
    }
  }, [session, book.document, book.cover_url, book.title])

  const frame = `relative aspect-[2/3] shrink-0 overflow-hidden rounded-md shadow-sm ring-1 ring-stone-950/10 ${className}`
  if (url && !broken) {
    return <img src={url} alt="" loading="lazy" onError={() => setBroken(true)} className={`${frame} object-cover`} />
  }
  return (
    <div className={`${frame} flex flex-col justify-between bg-cover ${small ? 'p-1 md:p-2.5' : 'p-2.5'}`}>
      <div className="paper-grain absolute inset-0 opacity-[0.06]" />
      <p className={`relative line-clamp-5 font-display font-semibold break-words hyphens-auto text-stone-800 ${small ? 'text-[0.45rem]/tight md:text-sm/tight' : 'text-sm/tight'}`}>
        {book.title || book.filename || 'Untitled'}
      </p>
      <p className={`relative line-clamp-2 text-stone-500 ${small ? 'text-[0.35rem]/tight md:text-[0.65rem]/tight' : 'text-[0.65rem]/tight'}`}>{book.author}</p>
    </div>
  )
}

export function Spinner() {
  return <div className="mx-auto my-16 size-6 animate-spin rounded-full border-2 border-stone-300 border-t-brand-500" />
}

export function ErrorNote({ error }) {
  return <p className="my-12 text-center text-sm text-stone-500">{error.message}</p>
}

// Tiny fetch hook: [data, error, reload].
// Last result per `memo` key: revisiting a screen shows it instantly while it refreshes.
const remembered = new Map()

export function useLoad(fn, deps, memo) {
  const [state, setState] = useState(() => ({ data: memo ? (remembered.get(memo) ?? null) : null, error: null }))
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    fn().then(
      (data) => {
        if (memo) remembered.set(memo, data)
        if (live) setState({ data, error: null })
      },
      // A failed refresh keeps whatever is already on screen.
      (error) => live && setState((s) => (s.data ? s : { data: null, error }))
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return [state.data, state.error, () => setTick((t) => t + 1)]
}

export function duration(seconds) {
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return h ? `${h}h ${m}m` : `${m}m`
}

export function ago(unix) {
  const s = Date.now() / 1000 - unix
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`
  return new Date(unix * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export const pct = (p) => `${Math.round(p * 100)}%`

// App-wide confirmation toast: notify({ title, detail?, error? }) from anywhere;
// <Toaster /> in the shell shows the latest one above the tab bar.
const toasts = new EventTarget()
export function notify(toast) {
  toasts.dispatchEvent(new CustomEvent('toast', { detail: { id: Date.now() + Math.random(), ...toast } }))
}

export const folderLabel = (folder) => (!folder || folder === '/' ? 'the top of the SD card' : folder)

export function Toaster() {
  const [toast, setToast] = useState(null)
  useEffect(() => {
    const on = (e) => setToast(e.detail)
    toasts.addEventListener('toast', on)
    return () => toasts.removeEventListener('toast', on)
  }, [])
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), toast.error ? 7000 : 4000)
    return () => clearTimeout(t)
  }, [toast])
  if (!toast) return null
  const Icon = toast.error ? CircleAlert : CircleCheck
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-50 flex justify-center px-4 md:bottom-6 md:pl-60 lg:pl-64">
      <button
        key={toast.id}
        type="button"
        role="status"
        aria-live="polite"
        onClick={() => setToast(null)}
        className="toast-in pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-2xl bg-raised px-4 py-3 text-left shadow-lg ring-1 ring-stone-950/10"
      >
        <span className={`grid size-9 shrink-0 place-items-center rounded-full ${toast.error ? 'bg-red-50 text-red-600' : 'bg-brand-50 text-brand-600'}`}>
          <Icon className="size-5" strokeWidth={2} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold text-stone-900">{toast.title}</span>
          {toast.detail && <span className="block truncate text-xs text-stone-500">{toast.detail}</span>}
        </span>
      </button>
    </div>
  )
}
