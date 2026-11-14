import { useEffect, useState } from 'react'
import { listImports, readImport, removeImport } from './importQueue.js'
import { isApp } from './api.js'
import { importKind } from './importTypes.js'
import { Card, notify } from './ui.jsx'

// Shared between mounted editors, so navigating away cannot start a second
// upload of the same file. Native copies remain authoritative across restarts.
const active = new Set()
const changed = () => window.dispatchEvent(new Event('crosspoint-imports-changed'))
export async function runImportedAsset(id, action, removeAfter = true) {
  const ids = Array.isArray(id) ? id : [id]
  if (ids.some(id => active.has(id))) throw new Error('This file is already being processed')
  for (const id of ids) active.add(id)
  changed()
  try {
    const result = await action()
    if (removeAfter) for (const id of ids) await removeImport(id)
    return result
  } finally { for (const id of ids) active.delete(id); changed() }
}

export default function ImportedAssets({ kind, actionLabel, onAction, actionDisabled = false, removalDisabled = false, removeAfter = true, groupEntries, onRemoved }) {
  const [entries, setEntries] = useState([])
  const [jobs, setJobs] = useState(new Set())
  useEffect(() => {
    if (!isApp) return
    let live = true, request = 0
    const load = async () => {
      const current = ++request
      setJobs(new Set(active))
      try {
        const all = await listImports()
        if (live && current === request) setEntries(all.filter(e => importKind(e) === kind))
      } catch (error) { if (live) notify({ error: true, title: "Couldn't load queued files", detail: String(error) }) }
    }
    load()
    window.addEventListener('crosspoint-imports-changed', load)
    return () => { live = false; window.removeEventListener('crosspoint-imports-changed', load) }
  }, [kind])
  async function act(entry, remove = false) {
    try {
      const batch = !remove && groupEntries ? groupEntries(entry, entries) : [entry]
      await runImportedAsset(batch.map(e => e.id), async () => {
        if (!remove) {
          const files = await Promise.all(batch.map(readImport))
          await onAction(files[0], entry, files)
        }
      }, remove || removeAfter)
      if (remove) onRemoved?.(entry)
    } catch (error) { notify({ error: true, title: `Couldn't ${remove ? 'remove' : 'process'} ${entry.name}`, detail: String(error) }) }
  }
  if (!entries.length) return null
  return (
    <section className="mt-5">
      <h3 className="text-sm font-semibold text-stone-600">Shared files waiting to send</h3>
      {groupEntries && <p className="mt-1 text-xs text-stone-500">Available styles from the same font family send together.</p>}
      <Card className="mt-2 divide-y divide-stone-100">
        {entries.map(entry => (
          <div key={entry.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-stone-900">{entry.name}</span>
            <button disabled={actionDisabled || jobs.has(entry.id)} onClick={() => act(entry)} className="text-sm font-semibold text-brand-600 disabled:opacity-40">{jobs.has(entry.id) ? 'Processing…' : actionLabel}</button>
            <button disabled={jobs.has(entry.id) || removalDisabled} onClick={() => act(entry, true)} aria-label={`Remove ${entry.name}`} className="text-sm text-stone-500 disabled:opacity-40">Remove</button>
          </div>
        ))}
      </Card>
    </section>
  )
}
