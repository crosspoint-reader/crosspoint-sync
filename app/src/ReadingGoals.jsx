import { useEffect, useState } from 'react'
import { api, cached } from './api.js'
import { Card, useLoad } from './ui.jsx'

export function ReadingGoalCard({ goals }) {
  const year = new Date().getFullYear()
  const goal = goals?.goals?.find(g => g.year === year)
  if (!goal) return null
  const remaining = Math.max(0, goal.target - goal.completed)
  return (
    <Card className="mt-6 p-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-display text-xl font-semibold text-stone-900">Your {year} reading goal</h2>
        <a href="#/settings/goals" className="-my-2 min-h-11 content-center text-sm font-semibold text-brand-600">Edit</a>
      </div>
      <p className="mt-3 font-display text-3xl font-semibold text-stone-900">{goal.completed} of {goal.target} books</p>
      <div role="progressbar" aria-label={`${year} reading goal`} aria-valuemin={0} aria-valuemax={goal.target} aria-valuenow={Math.min(goal.target, goal.completed)} aria-valuetext={`${goal.completed} of ${goal.target} books finished`} className="mt-4 h-2 overflow-hidden rounded-full bg-stone-100">
        <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.min(100, goal.completed / goal.target * 100)}%` }} />
      </div>
      <p className="mt-3 text-sm text-stone-500">{remaining ? `${remaining} more ${remaining === 1 ? 'book' : 'books'} to reach your goal` : 'Goal reached'}</p>
    </Card>
  )
}

export default function ReadingGoals({ session }) {
  // A keyed inner editor discards drafts and pending UI updates on account changes.
  return <GoalEditor key={JSON.stringify([session.server, session.username])} session={session} />
}

function GoalEditor({ session }) {
  const [loaded, error, reload] = useLoad(() => api.readingGoals(session), [session], undefined, () => cached.readingGoals(session))
  const [saved, setSaved] = useState(null)
  const [year, setYear] = useState(String(new Date().getFullYear()))
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState('')
  const data = saved ?? loaded
  const goal = data?.goals?.find(g => g.year === Number(year))
  useEffect(() => { setSaved(null) }, [loaded])
  const send = async (remove = false) => {
    setBusy(true)
    setFailure('')
    try {
      const result = remove ? await api.removeReadingGoal(session, Number(year)) : await api.setReadingGoal(session, Number(year), Number(draft ?? goal?.target))
      setSaved(result)
      setDraft(null)
    } catch (e) { setFailure(e.message) }
    finally { setBusy(false) }
  }
  const inputClass = 'h-11 w-full rounded-lg bg-stone-100 px-3 text-base text-stone-900 outline-none focus:ring-2 focus:ring-brand-300 disabled:opacity-50'
  if (error && !data) return <Card className="mt-3 p-4"><p className="text-sm text-stone-500">{error.status === 404 ? 'This server does not support reading goals yet.' : `Could not load reading goals: ${error.message}`}</p><button className="mt-2 min-h-11 text-sm font-semibold text-brand-600" onClick={reload}>Retry</button></Card>
  if (!data) return <p className="mt-3 text-sm text-stone-500">Loading reading goals…</p>
  return (
    <Card className="mt-3 p-4">
      <p className="text-sm text-stone-500">An optional number of books to finish in a year. Each year is yours to choose.</p>
      <form className="mt-4" onSubmit={e => { e.preventDefault(); send() }}>
        <div className="grid grid-cols-2 gap-4">
          <label className="space-y-2 text-sm font-medium text-stone-800"><span>Year</span><input aria-label="Goal year" required type="number" min="2000" max="9999" step="1" value={year} disabled={busy} onChange={e => { setYear(e.target.value); setDraft(null); setFailure('') }} className={inputClass} /></label>
          <label className="space-y-2 text-sm font-medium text-stone-800"><span>Books to finish</span><input aria-label="Books to finish" required type="number" inputMode="numeric" min="1" max="10000" step="1" value={draft ?? goal?.target ?? ''} disabled={busy} onChange={e => setDraft(e.target.value)} className={inputClass} /></label>
        </div>
        {goal && <p className="mt-3 text-sm text-stone-500">{goal.completed} of {goal.target} books finished</p>}
        {failure && <p role="alert" className="mt-3 text-sm text-red-600">Could not save your change: {failure}</p>}
        {error && <p role="status" className="mt-3 text-sm text-stone-500">Showing saved goals. Refresh when you are back online.</p>}
        <div className="mt-4 flex flex-wrap gap-3">
          <button type="submit" disabled={busy} className="min-h-11 rounded-xl bg-brand-500 px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save goal'}</button>
          {goal && <button type="button" disabled={busy} onClick={() => send(true)} className="min-h-11 rounded-xl px-4 text-sm font-semibold text-stone-600 disabled:opacity-50">Remove goal</button>}
        </div>
      </form>
    </Card>
  )
}
