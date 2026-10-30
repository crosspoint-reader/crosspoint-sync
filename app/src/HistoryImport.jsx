import { useRef, useState } from 'react'
import { api } from './api.js'
import { Card, notify, STATUS } from './ui.jsx'

export default function HistoryImport({ session }) {
  const input = useRef(null)
  const [file, setFile] = useState(null)
  const [timezone, setTimezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC')
  const [preview, setPreview] = useState(null)
  const [finishes, setFinishes] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const button = 'min-h-11 rounded-xl bg-stone-100 px-4 text-sm font-semibold text-stone-800 disabled:opacity-50'

  async function review() {
    setBusy(true)
    setError(null)
    try {
      if (file.size > 50 * 1024 * 1024) throw new Error('Choose a file no larger than 50 MB.')
      const result = await api.importHistory(session, file, timezone)
      setFinishes(Object.fromEntries(result.books.map(b => result.kind === 'tracker'
        ? [b.source_id, { target: b.target, status: b.status, start_date: b.start_date, finished_date: b.finished_date }]
        : [b.document, b.completed ? b.finished_date : null])))
      setPreview(result)
    } catch (e) { setError(e.message) }
    finally { setBusy(false) }
  }
  async function importBooks() {
    setBusy(true)
    setError(null)
    try {
      const result = await api.importHistory(session, file, timezone, finishes)
      notify({ title: `${result.books} books imported`, detail: preview.kind === 'tracker' ? `${result.skipped} books skipped.` : `${result.preserved_history} books kept their existing reading stats.` })
      location.hash = '#/'
      location.reload()
    } catch (e) { setError(e.message); setBusy(false) }
  }

  return (
    <Card className="mt-3 space-y-3 p-4">
      <h3 className="font-semibold text-stone-900">Import reading history</h3>
      <p className="text-sm text-stone-500">Upload a Goodreads or StoryGraph CSV (up to 10 MB), or a KOReader / KOInsight database or ZIP (up to 50 MB).</p>
      <p className="text-sm text-stone-500">Your reader positions stay unchanged. Existing book stats, statuses and dates are preserved, and no updates are sent to linked services. Export an account backup before importing.</p>
      <fieldset disabled={busy} className="space-y-3 disabled:opacity-60">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={button} onClick={() => input.current.click()}>Choose file</button>
          <span className="min-w-0 break-all text-sm text-stone-500" role="status">{file?.name || 'No file selected'}</span>
          <input ref={input} type="file" accept=".csv,.sqlite,.sqlite3,.db,.zip" aria-label="Reading-history file" className="hidden" onChange={e => { setFile(e.target.files?.[0] || null); setPreview(null); setError(null) }} />
        </div>
        <label className="block text-sm font-medium text-stone-700">
          Reading time zone
          <input value={timezone} onChange={e => { setTimezone(e.target.value); setPreview(null) }} placeholder="America/New_York" className="mt-1 block min-h-11 w-full rounded-xl bg-surface px-3 ring-1 ring-stone-950/10" />
        </label>
        {!preview && <button type="button" className={button} disabled={!file || !timezone} onClick={review}>{busy ? 'Reading file…' : 'Review history'}</button>}
        {preview && <>
          {preview.kind === 'tracker' ? <>
            <p className="text-sm text-stone-700">{preview.source}: {preview.books.length} books to review</p>
            <p className="text-sm text-stone-500">Confirm book matches, statuses and dates. Blank dates stay unknown. Existing values on matched books are kept. CSV imports add no reading sessions or daily activity. Reviews and tags are not imported.</p>
            {preview.warnings.map(w => <p key={w} className="text-sm text-amber-800">{w}</p>)}
            <div className="max-h-96 space-y-3 overflow-y-auto rounded-xl border border-stone-200 p-3">
              {preview.books.map(b => <TrackerRow key={b.source_id} book={b} library={preview.library} choice={finishes[b.source_id]} onChange={choice => setFinishes({ ...finishes, [b.source_id]: choice })} />)}
            </div>
          </> : <>
          <p className="text-sm text-stone-700">{preview.books.length} books · {Object.values(finishes).filter(Boolean).length} finished · {preview.books.filter(b => b.existing_history).length} with existing stats</p>
          <p className="text-sm text-stone-500">Review suggested completions below. For new history, reaching 98% suggests a finish date; this can include a skipped-to ending. Unfinished historical books appear under Paused. Existing completion information is kept.</p>
          <div className="max-h-96 space-y-3 overflow-y-auto rounded-xl border border-stone-200 p-3">
            {preview.books.map(b => <div key={b.document} className="space-y-1 border-b border-stone-100 pb-3 last:border-0">
              <p className="text-sm font-medium text-stone-900">{b.title}</p>
              <p className="text-xs text-stone-500">{b.author}{b.existing_history ? ' · Existing stats kept' : ` · ${b.records} page records`}</p>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input type="checkbox" checked={b.existing_history || b.status != null ? b.completed : finishes[b.document] !== null} disabled={b.existing_history || b.status != null} onChange={e => setFinishes({ ...finishes, [b.document]: e.target.checked ? b.finished_date || b.start_date || new Date().toISOString().slice(0, 10) : null })} />
                Finished: {b.title}
              </label>
              {finishes[b.document] !== null && <label className="block text-sm text-stone-700">
                Finish date: {b.title}
                <input type="date" required min={b.start_date || undefined} value={finishes[b.document]} disabled={b.existing_history || b.status != null} onChange={e => setFinishes({ ...finishes, [b.document]: e.target.value })} className="mt-1 block min-h-11 rounded-lg bg-surface px-2 ring-1 ring-stone-950/10" />
              </label>}
            </div>)}
          </div>
          </>}
          <button type="button" className={button} disabled={!preview.books.length || Object.values(finishes).some(v => preview.kind === 'tracker' ? v.target === '' : v === '')} onClick={importBooks}>{busy ? 'Importing…' : `Import ${preview.kind === 'tracker' ? Object.values(finishes).filter(v => v.target !== null).length : preview.books.length} books`}</button>
        </>}
      </fieldset>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    </Card>
  )
}

function TrackerRow({ book, library, choice, onChange }) {
  const [query, setQuery] = useState('')
  const matches = query ? library.filter(b => `${b.title} ${b.author}`.toLowerCase().includes(query.toLowerCase())).slice(0, 20) : book.candidates
  const selected = library.find(b => b.document === choice.target)
  const options = selected && !matches.some(b => b.document === selected.document) ? [selected, ...matches] : matches
  const field = 'mt-1 block min-h-11 w-full rounded-lg bg-surface px-2 text-sm ring-1 ring-stone-950/10'
  const update = patch => onChange({ ...choice, ...patch })
  return <div className="space-y-2 border-b border-stone-100 pb-4 last:border-0">
    <p className="text-sm font-medium text-stone-900">{book.title}</p>
    <p className="text-xs text-stone-500">{book.author}{book.isbn ? ` · ISBN ${book.isbn}` : ''}{book.user_rating != null ? ` · Your rating: ${book.user_rating}/5` : ''}</p>
    {!book.locked && <label className="block text-sm">Search existing books for {book.title}
      <input value={query} onChange={e => setQuery(e.target.value)} className={field} type="search" />
    </label>}
    <label className="block text-sm">Import destination for {book.title}
      <select value={choice.target === null ? 'skip' : choice.target} disabled={book.locked} onChange={e => update({ target: e.target.value === 'skip' ? null : e.target.value })} className={field}>
        <option value="" disabled>Choose a match</option>
        <option value="new">Create a new book</option>
        <option value="skip">Skip this book</option>
        {options.map(b => <option key={b.document} value={b.document}>{b.title || 'Untitled'}{b.author ? ` — ${b.author}` : ''}</option>)}
      </select>
    </label>
    {book.locked && <p className="text-xs text-stone-500">Already imported. Its existing match and saved values will be kept.</p>}
    {choice.target !== null && <>
      <label className="block text-sm">Status for {book.title}
        <select value={choice.status} onChange={e => update({ status: e.target.value, finished_date: e.target.value === 'finished' ? choice.finished_date : null })} className={field}>
          {STATUS.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </label>
      <label className="block text-sm">Start date for {book.title} (optional)
        <input type="date" value={choice.start_date || ''} onChange={e => update({ start_date: e.target.value || null })} className={field} />
      </label>
      {choice.status === 'finished' && <label className="block text-sm">Finish date for {book.title} (optional)
        <input type="date" min={choice.start_date || undefined} value={choice.finished_date || ''} onChange={e => update({ finished_date: e.target.value || null })} className={field} />
      </label>}
    </>}
  </div>
}
