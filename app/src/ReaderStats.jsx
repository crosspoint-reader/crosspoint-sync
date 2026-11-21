import { useState } from 'react'
import { api, isApp } from './api.js'
import { reader } from './catalogs.js'
import { loadDevicePrefs, readText, uploadTo } from './device.js'
import { saveFile, savedMessage } from './shareCard.js'
import { Card, notify } from './ui.jsx'

// The firmware's reading session log, which the reader's Reading Stats app reads.
export const LOG_PATH = '/.crosspoint/reading_sessions.jsonl'
const SEED_TZ = 1 // the server's per-day sessions (SEED_UTC_OFFSET)

const parse = (line) => { try { return JSON.parse(line) } catch { return null } }
const seedKey = (s) => `${s.doc}:${Math.floor((s.start + SEED_TZ * 60) / 86400)}`

/**
 * The reader's log with the server's history added. The reader's own bytes stay untouched in front:
 * its upload position points into them. Sessions it already has are skipped, and a book-day seeded
 * before gets only the time added since.
 */
export function mergeSessionLog(existing, exported) {
  const have = new Set()
  const seeded = new Map()
  for (const s of existing.split('\n').map(parse)) {
    if (!s) continue
    if (s.tz === SEED_TZ) seeded.set(seedKey(s), (seeded.get(seedKey(s)) ?? 0) + s.secs)
    else have.add(`${s.doc}:${s.start}`)
  }
  const added = []
  for (const s of exported.split('\n').map(parse)) {
    if (!s) continue
    if (s.tz !== SEED_TZ) {
      if (!have.has(`${s.doc}:${s.start}`)) added.push(s)
      continue
    }
    const secs = s.secs - (seeded.get(seedKey(s)) ?? 0)
    if (secs >= 10) added.push({ ...s, secs })
  }
  const lines = added.map((s) => `${JSON.stringify(s)}\n`).join('')
  // A power cut can leave the reader's last line unfinished; end it so it doesn't swallow ours.
  return { text: existing && !existing.endsWith('\n') && lines ? `${existing}\n${lines}` : existing + lines, added: added.length }
}

export default function ReaderStats({ session }) {
  const [busy, setBusy] = useState(null)
  const [saved, setSaved] = useState(null)
  const [error, setError] = useState(null)
  const button = 'min-h-11 rounded-xl bg-stone-100 px-4 text-sm font-semibold text-stone-800 disabled:opacity-50'

  async function run(kind, task) {
    setBusy(kind)
    setError(null)
    setSaved(null)
    try { await task() } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    finally { setBusy(null) }
  }
  const download = () => run('download', async () => {
    const text = await api.readerSessions(session)
    setSaved(savedMessage(await saveFile(new Blob([text], { type: 'application/x-ndjson' }), 'reading_sessions.jsonl')))
  })
  const send = () => run('send', async () => {
    const exported = await api.readerSessions(session)
    const base = await reader(loadDevicePrefs()).catch(() => {
      throw new Error('Couldn’t reach your reader. Open File Transfer on it, join the same Wi-Fi, and try again.')
    })
    // Only a missing log starts empty: any other failure must not replace the reader's history.
    const existing = await readText(base, LOG_PATH).catch((e) => { if (e.status === 404) return ''; throw e })
    const { text, added } = mergeSessionLog(existing, exported)
    if (added) await uploadTo(base, LOG_PATH, new TextEncoder().encode(text))
    notify({ title: added ? 'Reading history sent to your reader' : 'Your reader already has this history', detail: added ? `${added} sessions added.` : undefined })
  })

  return (
    <Card className="mt-3 space-y-3 p-4">
      <h3 className="font-semibold text-stone-900">Reading history on your reader</h3>
      <p className="text-sm text-stone-500">Start your reader’s Reading Stats from the history on this account: sessions from your other readers, KOReader imports and linked services. Time known only as a daily total shows as one session at noon.</p>
      {isApp
        ? <p className="text-sm text-stone-500">To send it, open File Transfer on your reader and keep this phone on the same Wi-Fi. Sessions already on the reader are kept and not added twice.</p>
        : <p className="text-sm text-stone-500">Send it from the CrossPoint Sync app, or download the file and copy it to your reader’s SD card as <span className="font-mono">{LOG_PATH}</span>. The .crosspoint folder is hidden: show hidden files on your computer. If that file already exists, run Sync Progress on the reader first, then replace it.</p>}
      <div className="flex flex-wrap gap-2">
        {isApp && <button type="button" className={button} disabled={!!busy} onClick={send}>{busy === 'send' ? 'Sending…' : 'Send to reader'}</button>}
        <button type="button" className={button} disabled={!!busy} onClick={download}>{busy === 'download' ? 'Working…' : 'Download file'}</button>
      </div>
      {saved && <p role="status" className="text-sm text-stone-600">{saved}{isApp && ` Copy it to your reader’s SD card as ${LOG_PATH}.`}</p>}
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </Card>
  )
}
