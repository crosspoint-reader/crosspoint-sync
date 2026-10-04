import { useState } from 'react'
import { openUrl } from '@tauri-apps/plugin-opener'
import { Headphones, Loader2, Play, RefreshCw } from 'lucide-react'
import { api, isApp } from './api.js'
import { Card, notify, pct, useLoad } from './ui.jsx'

const open = (url) => (isApp ? openUrl(url) : window.open(url, '_blank', 'noopener'))
const pad = (n) => String(n).padStart(2, '0')

export function clock(ms) {
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  return h ? `${h}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}` : `${Math.floor(s / 60)}:${pad(s % 60)}`
}

// "3:01" or "1:02:03" -> ms; blank is the start of the track.
export function parseClock(text) {
  const parts = text.trim() ? text.trim().split(':').map(Number) : [0]
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return null
  return parts.reduce((t, n) => t * 60 + n, 0) * 1000
}

// "Not the right spot?": line Spotify up with the reader. Pick the track (and time)
// that matches where the reader is now; the server maps both directions through it.
function Calibrate({ session, book, data, onDone }) {
  const [tracks] = useLoad(() => api.spotifyTracks(session, book.document), [book.document])
  const [track, setTrack] = useState(data.target?.chapterIndex ?? data.position.chapterIndex)
  const [time, setTime] = useState('')
  const [busy, setBusy] = useState(false)
  async function run(fn, title) {
    setBusy(true)
    try {
      await fn()
      notify({ title })
      onDone()
    } catch (e) {
      notify({ error: true, title: "Spotify: that didn't work", detail: e.message })
      setBusy(false)
    }
  }
  const save = (e) => {
    e.preventDefault()
    const ms = parseClock(time)
    if (ms == null) return notify({ error: true, title: 'Use a time like 3:01' })
    run(() => api.setSpotifyAnchor(session, book.document, Number(track), ms), 'Spotify lined up with your reader')
  }
  const field = 'h-11 rounded-xl bg-surface px-3 text-sm text-stone-900 ring-1 ring-stone-950/10 outline-none focus:ring-2 focus:ring-brand-500/60'
  return (
    <form onSubmit={save} className="mt-3 space-y-2 rounded-xl bg-stone-50 p-3">
      <p className="text-sm text-stone-600">
        Your reader is at <span className="font-semibold text-stone-900">{pct(data.reader_pct ?? book.percentage)}</span>. Which part of the audiobook is that?
      </p>
      {!tracks ? (
        <Loader2 className="mx-auto my-2 size-4 animate-spin text-stone-400" />
      ) : (
        <div className="flex gap-2">
          <select aria-label="Spotify track" value={track} onChange={(e) => setTrack(e.target.value)} className={`${field} min-w-0 flex-1`}>
            {tracks.tracks.map((t) => (
              <option key={t.index} value={t.index}>
                {t.name} ({clock(t.start_ms)})
              </option>
            ))}
          </select>
          <input aria-label="Time in track" value={time} onChange={(e) => setTime(e.target.value)} placeholder="0:00" inputMode="numeric" className={`${field} w-20 text-center font-mono`} />
        </div>
      )}
      <div className="flex gap-2">
        <button disabled={busy || !tracks} className="flex h-10 flex-1 items-center justify-center rounded-xl bg-brand-500 text-sm font-semibold text-white disabled:opacity-50">
          {busy ? <Loader2 className="size-4 animate-spin" /> : 'Save'}
        </button>
        {data.anchor && (
          <button type="button" disabled={busy} onClick={() => run(() => api.clearSpotifyAnchor(session, book.document), 'Spotify back to automatic')} className="h-10 rounded-xl px-4 text-sm font-semibold text-stone-600 active:bg-stone-200">
            Reset
          </button>
        )}
      </div>
    </form>
  )
}

// The audiobook's place on Spotify next to the reader's. Shown only when Spotify
// is linked and has this book; playback starts only from the button.
export default function SpotifyCard({ session, book, onChange }) {
  const [services] = useLoad(() => api.bookMatches(session, book.document), [book.document], `matches ${book.document}`)
  const linked = !!services?.some((s) => s.id === 'spotify')
  const [data, , reload] = useLoad(() => (linked ? api.spotifyPosition(session, book.document) : Promise.resolve(null)), [book.document, linked])
  const [busy, setBusy] = useState(false)
  const [calibrating, setCalibrating] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const p = data?.matched ? data.position : null
  if (!p) return null
  // Resume goes to the reader's place when it's ahead of Spotify (older servers send no target).
  const t = data.target ?? p
  const at = `${t.chapterName} / ${clock(t.positionMs)}`
  const spotifyAt = `${p.chapterName} / ${clock(p.positionMs)}`

  // Read Spotify now: moves the book's progress forward if you've listened ahead.
  async function sync() {
    setSyncing(true)
    try {
      const { applied } = await api.spotifySync(session, book.document)
      notify({ title: applied ? 'Progress updated from Spotify' : 'Up to date with Spotify' })
      reload()
      if (applied) onChange?.()
    } catch (e) {
      notify({ error: true, title: "Spotify: that didn't work", detail: e.message })
    } finally {
      setSyncing(false)
    }
  }

  async function resume() {
    setBusy(true)
    try {
      const r = await api.spotifyResume(session, book.document)
      if (r.ok) notify({ title: 'Playing in Spotify' })
      else {
        // No Premium or no active device: open the track in the Spotify app (spotify:
        // link), or its web page when the app isn't there. Without a device the server
        // starts playback at the exact spot once Spotify is up (retrying).
        if (r.retrying) notify({ title: 'Opening Spotify', detail: `Starting ${r.position.chapterName} at ${clock(r.position.positionMs)} in a moment.` })
        if (isApp && r.app_url) {
          try {
            await openUrl(r.app_url)
          } catch {
            await open(r.fallback_url)
          }
        } else await open(r.fallback_url)
      }
      reload()
    } catch (e) {
      notify({ error: true, title: "Spotify: that didn't work", detail: e.message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="relative mt-4 p-4">
      <button
        type="button"
        onClick={sync}
        disabled={syncing}
        aria-label="Sync with Spotify now"
        className="absolute top-1.5 right-1.5 grid size-10 place-items-center rounded-full text-brand-600 active:bg-stone-100 disabled:opacity-60 md:hover:bg-stone-100"
      >
        <RefreshCw className={`size-5 ${syncing ? 'animate-spin' : ''}`} strokeWidth={1.75} />
      </button>
      <p className="flex items-center gap-1.5 pr-9 text-xs font-medium text-stone-500">
        <Headphones className="size-3.5" strokeWidth={2} /> Spotify Audiobook
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
          <dd className="truncate text-xs text-stone-500">{spotifyAt}</dd>
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
      {'reader_pct' in data && (
        <button type="button" onClick={() => setCalibrating(!calibrating)} className="mt-2 w-full text-center text-xs font-medium text-stone-500">
          {calibrating ? 'Cancel' : data.anchor ? 'Lined up with your reader · Adjust' : 'Not the right spot?'}
        </button>
      )}
      {calibrating && (
        <Calibrate
          session={session}
          book={book}
          data={data}
          onDone={() => {
            setCalibrating(false)
            reload()
          }}
        />
      )}
    </Card>
  )
}
