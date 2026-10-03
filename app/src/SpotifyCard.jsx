import { useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Headphones, Loader2, Play } from 'lucide-react'
import { api, isApp } from './api.js'
import { Card, notify, pct, useLoad } from './ui.jsx'

const open = (url) => (isApp ? openUrl(url) : window.open(url, '_blank', 'noopener'))
const pad = (n) => String(n).padStart(2, '0')

export function clock(ms) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`
}

// The audiobook's place on Spotify next to the reader's. Shown only when Spotify
// is linked and has this book; playback starts only from the button.
export default function SpotifyCard({ session, book }) {
  const [services] = useLoad(() => api.bookMatches(session, book.document), [book.document], `matches ${book.document}`)
  const linked = !!services?.some((s) => s.id === 'spotify')
  const [data, , reload] = useLoad(() => (linked ? api.spotifyPosition(session, book.document) : Promise.resolve(null)), [book.document, linked])
  const [busy, setBusy] = useState(false)
  const p = data?.matched ? data.position : null
  if (!p) return null
  const at = `${p.chapterName} / ${clock(p.positionMs)}`

  async function resume() {
    setBusy(true)
    try {
      const r = await api.spotifyResume(session, book.document)
      // No Premium or no active device: open the chapter in Spotify instead.
      if (r.ok) notify({ title: 'Playing in Spotify' })
      else await open(r.fallback_url)
      reload()
    } catch (e) {
      notify({ error: true, title: "Spotify: that didn't work", detail: e.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mt-4 p-4">
      <p className="flex items-center gap-1.5 text-xs font-medium text-stone-500">
        <Headphones className="size-3.5" strokeWidth={2} /> Spotify audiobook
        {p.live && <span className="ml-auto rounded-full bg-brand-50 px-2 py-0.5 text-brand-700">Playing now</span>}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <dt className="text-xs text-stone-500">Reader</dt>
          <dd className="font-mono text-sm font-semibold text-stone-900">{pct(book.percentage)}</dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">Spotify</dt>
          <dd className="font-mono text-sm font-semibold text-stone-900">{p.finished ? 'Finished' : pct(p.percentage)}</dd>
          <dd className="truncate text-xs text-stone-500">{at}</dd>
        </div>
      </dl>
      <button
        type="button"
        disabled={busy}
        onClick={resume}
        className="mt-3 flex h-11 w-full items-center justify-center gap-1.5 rounded-xl bg-brand-500 px-3 text-sm font-semibold text-white transition active:scale-[0.98] disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4 shrink-0" strokeWidth={2.25} />}
        <span className="truncate">Resume in Spotify at {at}</span>
      </button>
    </Card>
  )
}
