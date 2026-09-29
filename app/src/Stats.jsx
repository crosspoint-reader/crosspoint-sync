import { Card, Eyebrow, duration } from './ui.jsx'

const WEEKS = 52 // phones show the newest 26
const EPOCH = Date.UTC(2000, 0, 1)

// history_b64: bit N (LSB-first per byte) = anchor_day - N, anchor_day = days since 2000-01-01.
export function decodeHistory(b64, anchorDay) {
  const bytes = Uint8Array.from(atob(b64 || ''), (ch) => ch.charCodeAt(0))
  const read = (n) => n >= 0 && n < bytes.length * 8 && ((bytes[n >> 3] >> (n & 7)) & 1) === 1
  const anchor = new Date(EPOCH + anchorDay * 86400000)
  const anchorRow = (anchor.getUTCDay() + 6) % 7 // Monday = 0
  return { read, anchor, anchorRow }
}

function Heatmap({ summary }) {
  const { read, anchor, anchorRow } = decodeHistory(summary.history_b64, summary.anchor_day)
  let days = 0
  for (let n = 0; n < 365; n++) if (read(n)) days++
  const cols = Array.from({ length: WEEKS }, (_, c) =>
    Array.from({ length: 7 }, (_, r) => anchorRow - r + (WEEKS - 1 - c) * 7)
  )
  return (
    <Card className="mt-4 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-semibold text-stone-900">Reading days</h2>
        <p className="font-mono text-xs text-stone-500">{days} in the last year</p>
      </div>
      <div className="mt-3 flex justify-between gap-[3px]">
        {cols.map((col, c) => (
          <div key={c} className={`flex-1 flex-col gap-[3px] ${c < WEEKS / 2 ? 'hidden md:flex' : 'flex'}`}>
            {col.map((n) => (
              <div
                key={n}
                className={`aspect-square rounded-[2px] ${n < 0 ? 'bg-transparent' : read(n) ? 'bg-brand-500' : 'bg-stone-100'}`}
              />
            ))}
          </div>
        ))}
      </div>
      <p className="mt-2 text-right font-mono text-[0.65rem] text-stone-400">
        through {anchor.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })}
      </p>
    </Card>
  )
}

function Bars({ title, labels, values }) {
  const max = Math.max(...values, 1)
  return (
    <Card className="mt-4 p-4">
      <h2 className="font-display text-lg font-semibold text-stone-900">{title}</h2>
      <div className="mt-3 space-y-2">
        {labels.map((l, i) => (
          <div key={l} className="flex items-center gap-3 text-xs">
            <span className="w-16 shrink-0 text-stone-500">{l}</span>
            <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-stone-100">
              <div className="h-full rounded-full bg-brand-500" style={{ width: `${(values[i] / max) * 100}%` }} />
            </div>
            <span className="w-14 shrink-0 text-right font-mono text-stone-500">{duration(values[i])}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

function Tiles({ tiles }) {
  return (
    <Card className="mt-4 grid grid-cols-2 gap-px overflow-hidden bg-stone-100 md:grid-cols-3">
      {tiles.map(([l, v]) => (
        <div key={l} className="bg-white px-4 py-3">
          <p className="text-xs text-stone-500">{l}</p>
          <p className="mt-0.5 font-display text-xl font-semibold text-stone-900 md:text-2xl">{v}</p>
        </div>
      ))}
    </Card>
  )
}

const DAY_MS = 86400000
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Print pages per week (Monday start), newest week last.
function WeeklyPages({ days, weeks = 12 }) {
  const byDay = new Map(days.map((d) => [d.day, d.pages]))
  const monday = new Date()
  monday.setHours(12, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  const cols = Array.from({ length: weeks }, (_, i) => {
    const start = new Date(monday.getTime() - (weeks - 1 - i) * 7 * DAY_MS)
    let pages = 0
    for (let d = 0; d < 7; d++) pages += byDay.get(localDay(new Date(start.getTime() + d * DAY_MS))) ?? 0
    return { start, pages }
  })
  const max = Math.max(...cols.map((c) => c.pages), 1)
  return (
    <Card className="mt-4 p-4">
      <div className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-semibold text-stone-900">Pages per week</h2>
        <p className="font-mono text-xs text-stone-500">print pages</p>
      </div>
      <div className="mt-4 flex h-32 items-end gap-1.5">
        {cols.map((c) => (
          <div key={c.start.getTime()} className="flex h-full flex-1 flex-col justify-end" title={`${c.pages} pages`}>
            <p className="mb-1 text-center font-mono text-[0.6rem] text-stone-500">{c.pages || ''}</p>
            <div className="rounded-t-[3px] bg-brand-500" style={{ height: `${(c.pages / max) * 100}%`, minHeight: c.pages ? 2 : 0 }} />
            <div className="h-px bg-stone-200" />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5">
        {cols.map((c, i) => (
          <p key={i} className="flex-1 text-center font-mono text-[0.6rem] text-stone-400">
            {c.start.getDate() <= 7 || i === 0 ? c.start.toLocaleDateString(undefined, { month: 'short' }) : ''}
          </p>
        ))}
      </div>
    </Card>
  )
}

function Finished({ list, titles }) {
  if (!list.length) return null
  return (
    <Card className="mt-4 divide-y divide-stone-100 px-4">
      <h2 className="py-3 font-display text-lg font-semibold text-stone-900">Finished</h2>
      {list.map((b) => (
        <a key={b.document} href={`#/book/${b.document}`} className="flex items-baseline justify-between gap-3 py-2.5">
          <span className="truncate text-sm font-medium text-stone-800">{titles.get(b.document) ?? b.document}</span>
          <span className="shrink-0 font-mono text-xs text-stone-500">
            {new Date(b.finished_at * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
        </a>
      ))}
    </Card>
  )
}

function PagesAndBooks({ activity, books }) {
  const titles = new Map(books.map((b) => [b.document, b.title || b.filename]))
  const finished = activity.books.filter((b) => b.finished_at).sort((a, b) => b.finished_at - a.finished_at)
  const spans = finished.map((b) => (b.finished_at - b.started_at) / 86400).filter((d) => d >= 1)
  const known = activity.books.filter((b) => b.page_count).length
  const tiles = [
    ['Pages read', activity.pages_total.toLocaleString()],
    ['Books finished', finished.length],
    ['Reading now', books.filter((b) => b.status === 'reading').length],
    ['Finished this year', finished.filter((b) => new Date(b.finished_at * 1000).getFullYear() === new Date().getFullYear()).length],
    ['Pages per book', known ? Math.round(activity.books.reduce((n, b) => n + (b.page_count ?? 0), 0) / known) : '-'],
    ['Days per book', spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : '-'],
  ]
  return (
    <section>
      <Tiles tiles={tiles} />
      <WeeklyPages days={activity.days} />
      <Finished list={finished} titles={titles} />
      <p className="mt-3 text-xs/5 text-stone-500">
        Pages are print-edition pages (your progress x the book&apos;s page count from Open Library), so they don&apos;t
        depend on font size.{' '}
        {known < activity.books.length && `${activity.books.length - known} book(s) have no known page count yet. `}
        Weekly pages start from the first sync after history began.
      </p>
    </section>
  )
}

export default function Stats({ summary, activity, books }) {
  const hasTime = summary?.devices?.length > 0
  return (
    <div className="px-4 pt-6 pb-4 md:px-8 md:pt-10 lg:px-12">
      <Eyebrow>Reading stats</Eyebrow>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-stone-900 md:text-4xl">How you read</h1>

      <h2 className="mt-8 font-display text-xl font-semibold text-stone-900">Pages &amp; books</h2>
      {activity ? <PagesAndBooks activity={activity} books={books} /> : <p className="py-6 text-sm text-stone-500">Loading…</p>}

      <h2 className="mt-10 font-display text-xl font-semibold text-stone-900">Reading time</h2>
      {hasTime ? (
        <>
          <Tiles
            tiles={[
              ['Current streak', `${summary.current_streak} days`],
              ['Longest streak', `${summary.streak} days`],
              ['Time read', duration(summary.seconds)],
              ['Pages turned', summary.pages.toLocaleString()],
              ['Sessions', summary.sessions.toLocaleString()],
              ['Books finished', summary.completed],
            ]}
          />
          <Heatmap summary={summary} />
          <div className="md:grid md:grid-cols-2 md:gap-4">
            <Bars title="Time of day" labels={['Morning', 'Afternoon', 'Evening', 'Night']} values={summary.tod} />
            <Bars title="Day of week" labels={['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']} values={summary.dow} />
          </div>
          <p className="mt-6 text-center font-mono text-[0.65rem] text-stone-400">
            Combined from {summary.devices.map((d) => d.device || d.device_id).join(', ')}
          </p>
        </>
      ) : (
        <Card className="mt-4 p-4 text-sm/6 text-stone-600">
          None of your readers send reading time yet. CrossInk tracks it on the device (time per page, ignoring idle
          pages) and syncs it here; stock CrossPoint and KOReader only sync your position.
        </Card>
      )}
    </div>
  )
}
