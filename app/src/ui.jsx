import { useEffect, useState } from 'react'
import { BookOpen, CircleAlert, CircleCheck, CircleX, Pause } from 'lucide-react'
import { api, isApp } from './api.js'

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

export function Card({ className = '', children, ...props }) {
  return (
    <div {...props} className={`rounded-xl bg-surface ring-1 ring-stone-950/5 ${className}`}>
      {children}
    </div>
  )
}

export function ProgressBar({ value, className = '' }) {
  return (
    <div className={`h-1.5 overflow-hidden rounded-full bg-stone-200 ${className}`}>
      <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.round(value * 100)}%` }} />
    </div>
  )
}

// Server-resolved cover (cached server-side). Falls back to an e-ink "title page".
export function Cover({ session, book, small = false, tiny = false, className = '' }) {
  // Follows the book prop: one Cover can be handed another book (the library's
  // first paint is the offline copy) or a corrected cover_url.
  const [looked, setLooked] = useState(null) // { document, url } from a cover lookup
  const [broken, setBroken] = useState(null) // the url that failed to load
  useEffect(() => {
    if (book.cover_url || !book.title) return
    let live = true
    api.cover(session, book.document).then((r) => live && setLooked({ document: book.document, url: r.url }), () => {})
    return () => {
      live = false
    }
  }, [session, book.document, book.cover_url, book.title])
  const url = book.cover_url || (looked?.document === book.document ? looked.url : null)

  const frame = `relative aspect-[2/3] shrink-0 overflow-hidden rounded-md shadow-sm ring-1 ring-stone-950/10 ${className}`
  if (url && url !== broken) {
    return <img src={url} alt="" loading="lazy" onError={() => setBroken(url)} className={`${frame} object-cover`} />
  }
  return (
    <div className={`${frame} flex flex-col justify-between bg-cover ${tiny ? 'p-1' : small ? 'p-1 md:p-2.5' : 'p-2.5'}`}>
      <div className="paper-grain absolute inset-0 opacity-[0.06]" />
      <p className={`relative line-clamp-5 font-display font-semibold break-words hyphens-auto text-stone-800 ${tiny ? 'text-[0.45rem]/tight' : small ? 'text-[0.45rem]/tight md:text-sm/tight' : 'text-sm/tight'}`}>
        {book.title || book.filename || 'Untitled'}
      </p>
      <p className={`relative line-clamp-2 text-stone-500 ${tiny ? 'text-[0.35rem]/tight' : small ? 'text-[0.35rem]/tight md:text-[0.65rem]/tight' : 'text-[0.65rem]/tight'}`}>{book.author}</p>
    </div>
  )
}

// The CrossPoint mark with its left page turning over the spine: the app's loader.
export function LogoLoader({ className = 'size-10' }) {
  return (
    <svg viewBox="98 59 316 392" role="img" aria-label="Loading" className={`cp-loader text-brand-500 ${className}`}>
      <path
        fill="currentColor"
        d="M98 104.97A26 26 0 0 1 137.4 82.69L256 154L374.6 82.69A26 26 0 0 1 414 104.97L414 405.03A26 26 0 0 1 374.6 427.31L256 356L137.4 427.31A26 26 0 0 1 98 405.03Z"
      />
      <path className="cp-loader-mark" fill="var(--color-surface)" d="M281 342.5L388 278L388 408Z" />
      <path className="cp-loader-page" fill="var(--color-surface)" d="M123 104L242 175L242 319L123 248Z" />
    </svg>
  )
}

export function Spinner() {
  return (
    <div className="grid place-items-center py-16">
      <LogoLoader />
    </div>
  )
}

export function ErrorNote({ error }) {
  return <p className="my-12 text-center text-sm text-stone-500">{error.message}</p>
}

// Tiny fetch hook: [data, error, reload].
// Last result per `memo` key: revisiting a screen shows it instantly while it refreshes.
const remembered = new Map()

export function useLoad(fn, deps, memo, initial) {
  // `initial` (e.g. the saved offline copy) paints right away while fn() refreshes.
  const [state, setState] = useState(() => ({ data: (memo ? remembered.get(memo) : null) ?? initial?.() ?? null, error: null }))
  const [loading, setLoading] = useState(true)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let live = true
    setLoading(true)
    fn()
      .then(
        (data) => {
          if (memo) remembered.set(memo, data)
          if (live) setState({ data, error: null })
        },
        // A failed refresh keeps whatever is already on screen.
        (error) => live && setState((s) => (s.data ? s : { data: null, error }))
      )
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick])
  return [state.data, state.error, () => setTick((t) => t + 1), loading]
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
        className="toast-in pointer-events-auto flex w-full max-w-sm items-center gap-3 rounded-xl bg-raised px-4 py-3 text-left shadow-lg ring-1 ring-stone-950/10"
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

// ---- Loading states ------------------------------------------------------------
// Placeholder shapes for a page that has nothing to show yet.
export function Bone({ className = '' }) {
  return <div className={`animate-pulse rounded-md bg-stone-200/80 ${className}`} />
}

function BookRowBones() {
  return (
    <div className="flex gap-4 px-4 py-3">
      <Bone className="aspect-[2/3] w-12 shrink-0" />
      <div className="flex-1 space-y-2 pt-1">
        <Bone className="h-4 w-3/4" />
        <Bone className="h-3 w-1/2" />
        <Bone className="mt-3 h-1.5 w-full rounded-full" />
      </div>
    </div>
  )
}

export function PageSkeleton({ route }) {
  return (
    <div className="px-4 pt-6 pb-4 md:px-8 lg:px-12" aria-busy="true" aria-label="Loading">
      <Bone className="h-3 w-24 md:hidden" />
      <Bone className="mt-3 h-8 w-48 md:mt-1.5" />
      {route === 'stats' ? (
        <>
          <div className="mt-8 grid grid-cols-2 gap-3 md:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Bone key={i} className="h-16" />
            ))}
          </div>
          <Bone className="mt-4 h-44" />
          <Bone className="mt-4 h-32" />
        </>
      ) : (
        <>
          <Bone className="mt-6 h-16 md:w-96" />
          <div className="mt-6 flex gap-2">
            <Bone className="h-10 w-28 rounded-full" />
            <Bone className="h-10 w-28 rounded-full" />
            <Bone className="h-10 w-28 rounded-full" />
          </div>
          <Bone className="mt-6 h-40" />
          <div className="mt-4 divide-y divide-stone-100 rounded-xl bg-surface ring-1 ring-stone-950/5">
            <BookRowBones />
            <BookRowBones />
            <BookRowBones />
          </div>
        </>
      )}
    </div>
  )
}

// Background refresh: a floating pill with the turning-page mark, centered at the
// top so it never moves the page. Waits a beat so quick refreshes don't flicker.
export function RefreshPill({ active }) {
  const [show, setShow] = useState(false)
  useEffect(() => {
    if (!active) return setShow(false)
    const t = setTimeout(() => setShow(true), 350)
    return () => clearTimeout(t)
  }, [active])
  return (
    <div
      aria-hidden={!show}
      className={`pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+0.75rem)] z-30 flex justify-center transition duration-300 md:pl-60 lg:pl-64 ${
        show ? 'translate-y-0 opacity-100' : '-translate-y-3 opacity-0'
      }`}
    >
      <div className="rounded-full bg-raised p-2 shadow-md ring-1 ring-stone-950/10">
        <LogoLoader className="size-6" />
      </div>
    </div>
  )
}

// Tiny "via Hardcover" credit: top right of a card (which needs `relative`), or `inline` beside a heading.
// Links to the book on Hardcover when we know it, else Hardcover itself.
export function ViaHardcover({ slug, inline = false }) {
  const url = slug ? `https://hardcover.app/books/${slug}` : 'https://hardcover.app'
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => {
        if (!isApp) return
        e.preventDefault()
        import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(url))
      }}
      className={`${inline ? '' : 'absolute top-3 right-4 '}text-[0.65rem] font-medium text-stone-400 hover:text-stone-600`}
    >
      via Hardcover
    </a>
  )
}

// ---- Empty states ------------------------------------------------------------
// A little shelf: two tilted spines with the state's icon between them, a
// handwritten margin note, a title, one line of help and the next useful action.
export function EmptyState({ icon: Icon, note, title, children, action, compact = false }) {
  if (compact) {
    return (
      <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
        {Icon && (
          <span className="grid size-10 place-items-center rounded-full bg-stone-100 text-stone-500">
            <Icon className="size-5" strokeWidth={1.75} />
          </span>
        )}
        <p className="font-display text-base font-semibold text-stone-800">{title}</p>
        {children && <p className="max-w-xs text-sm/6 text-stone-500">{children}</p>}
        {action}
      </div>
    )
  }
  return (
    <div className="relative overflow-hidden rounded-xl bg-surface px-6 py-10 text-center ring-1 ring-stone-950/5">
      <div className="dot-field pointer-events-none absolute inset-0 text-stone-950/[0.06]" />
      <div className="relative">
        <div className="relative mx-auto h-24 w-36" aria-hidden="true">
          <span className="absolute bottom-0 left-4 h-20 w-7 -rotate-6 rounded-t-md bg-brand-200" />
          <span className="absolute bottom-0 left-11 h-16 w-6 -rotate-2 rounded-t-md bg-stone-200" />
          <span className="absolute right-5 bottom-0 h-[4.5rem] w-7 rotate-6 rounded-t-md bg-brand-300" />
          <span className="absolute inset-x-1 bottom-0 h-1.5 rounded-full bg-stone-300" />
          {Icon && (
            <span className="absolute top-3 left-1/2 grid size-12 -translate-x-1/2 place-items-center rounded-full bg-surface text-brand-600 shadow-sm ring-1 ring-stone-950/10">
              <Icon className="size-6" strokeWidth={1.75} />
            </span>
          )}
        </div>
        {note && <p className="mt-5 -rotate-1 font-hand text-xl text-brand-600">{note}</p>}
        <p className={`${note ? 'mt-1' : 'mt-5'} font-display text-xl font-semibold text-stone-900`}>{title}</p>
        {children && <p className="mx-auto mt-2 max-w-sm text-sm/6 text-stone-500">{children}</p>}
        {action && <div className="mt-5 flex justify-center">{action}</div>}
      </div>
    </div>
  )
}

/** The pill button used as an empty state's action. */
export function EmptyAction({ href, onClick, children }) {
  const cls =
    'inline-flex h-10 items-center gap-1.5 rounded-full bg-brand-500 px-4 text-sm font-semibold text-white transition active:scale-[0.98] md:hover:bg-brand-600'
  return href ? (
    <a href={href} className={cls}>
      {children}
    </a>
  ) : (
    <button type="button" onClick={onClick} className={cls}>
      {children}
    </button>
  )
}
