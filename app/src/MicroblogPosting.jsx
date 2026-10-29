import { useRef, useState } from 'react'
import { api } from './api.js'
import { useLoad } from './ui.jsx'

export default function MicroblogPosting({ session, onChange }) {
  const [data, loadError, reload] = useLoad(() => api.microblogDestinations(session), [session])
  const [override, setOverride] = useState(undefined)
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState(null)
  const value = override === undefined ? data?.selected || '' : override
  async function change(destination) {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    try {
      await api.setMicroblogDestination(session, destination)
      setOverride(destination)
      onChange?.()
    } catch (e) { setError(e.message || 'Could not save blog') }
    finally { pending.current = false; setBusy(false) }
  }
  return (
    <div className="mt-3 space-y-2 pl-12 text-sm text-stone-700">
      <label className="flex flex-wrap items-center justify-between gap-2">
        Post clippings to
        <select aria-label="Post clippings to" disabled={busy || !data} value={value} onChange={(e) => change(e.target.value)} className="h-10 max-w-full rounded-lg bg-stone-50 px-2 text-sm text-stone-900 ring-1 ring-stone-950/10 disabled:opacity-50">
          <option value="" disabled>{data ? 'Choose a blog' : 'Loading blogs…'}</option>
          {value && !data?.items?.some((d) => d.uid === value) && <option value={value}>Unavailable: {value}</option>}
          {data?.items?.map((d) => <option key={d.uid} value={d.uid}>{d.name}</option>)}
        </select>
      </label>
      <p className="text-xs text-stone-500">For new collections. Existing posts and later clippings stay on their original blog.</p>
      {data?.items?.length === 0 && <p>No blogs are available to this token.</p>}
      {(error || loadError) && <p role="alert" className="text-xs text-red-700">{error || loadError.message}</p>}
      {loadError && <button type="button" onClick={reload} className="min-h-10 text-brand-600">Retry loading blogs</button>}
    </div>
  )
}
