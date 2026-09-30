import { Fragment, useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Share2 } from 'lucide-react'
import ShareSheet from './ShareSheet.jsx'
import { renderCalendarCard, renderStatsCard } from './shareCard.js'
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

function Tiles({ tiles, action }) {
  return (
    <Card className="relative mt-4 grid grid-cols-2 gap-px overflow-hidden bg-stone-100 md:grid-cols-3">
      {action}
      {tiles.map(([l, v]) => (
        <div key={l} className="bg-surface px-4 py-3">
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
function weeklyPages(days, weeks = 12) {
  const byDay = new Map(days.map((d) => [d.day, d.pages]))
  const monday = new Date()
  monday.setHours(12, 0, 0, 0)
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7))
  return Array.from({ length: weeks }, (_, i) => {
    const start = new Date(monday.getTime() - (weeks - 1 - i) * 7 * DAY_MS)
    let pages = 0
    for (let d = 0; d < 7; d++) pages += byDay.get(localDay(new Date(start.getTime() + d * DAY_MS))) ?? 0
    return { start, pages }
  })
}

function WeeklyPages({ days, weeks = 12 }) {
  const cols = weeklyPages(days, weeks)
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

// Calendar of reading days from the sync history: one square per day, shaded by
// print pages read that day. Weekday rows (Monday first), weeks run left to right.
const SHADES = ['bg-stone-100', 'bg-brand-100', 'bg-brand-200', 'bg-brand-300', 'bg-brand-400']
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const SCALES = [
  ['month', 'Month'],
  ['quarter', '3 months'],
  ['year', 'Year'],
]
const mondayOf = (d) => new Date(d.getTime() - ((d.getDay() + 6) % 7) * DAY_MS)
const fmt = (d, o) => d.toLocaleDateString(undefined, o)

// Weeks (Monday dates) shown for a scale, `back` periods before now, plus the visible day range.
function calendarRange(scale, back, today) {
  if (scale === 'month') {
    const first = new Date(today.getFullYear(), today.getMonth() - back, 1, 12)
    const last = new Date(first.getFullYear(), first.getMonth() + 1, 0, 12)
    const weeks = []
    for (let m = mondayOf(first); m <= last; m = new Date(m.getTime() + 7 * DAY_MS)) weeks.push(m)
    return { weeks, first, last, label: fmt(first, { month: 'long', year: 'numeric' }) }
  }
  const count = scale === 'quarter' ? 13 : 52
  const end = new Date(mondayOf(today).getTime() - back * count * 7 * DAY_MS)
  const weeks = Array.from({ length: count }, (_, i) => new Date(end.getTime() - (count - 1 - i) * 7 * DAY_MS))
  const first = weeks[0]
  const last = new Date(end.getTime() + 6 * DAY_MS)
  const opts = { month: 'short', year: first.getFullYear() === last.getFullYear() ? undefined : 'numeric' }
  return { weeks, first, last, label: `${fmt(first, opts)} to ${fmt(last > today ? today : last, { month: 'short', year: 'numeric' })}` }
}

function ReadingCalendar({ days }) {
  const [scale, setScale] = useState('year')
  const [back, setBack] = useState(0)
  const [sharing, setSharing] = useState(false)
  const scroller = useRef(null)
  // Any sync marks a reading day; pages read deepen the shade.
  const byDay = new Map(days.filter((d) => d.syncs > 0 || d.pages > 0).map((d) => [d.day, d.pages]))
  const max = Math.max(...byDay.values(), 1)
  const level = (day) => (!byDay.has(day) ? 0 : Math.max(1, Math.min(4, Math.ceil((byDay.get(day) / max) * 4))))
  const today = new Date()
  today.setHours(12, 0, 0, 0)
  const { weeks, first, last, label } = calendarRange(scale, back, today)
  const shown = (d) => d >= first && d <= last && d <= today
  let count = 0
  for (let d = first; d <= last && d <= today; d = new Date(d.getTime() + DAY_MS)) if (byDay.has(localDay(d))) count++
  const month = scale === 'month'
  const year = scale === 'year'
  // The newest weeks sit on the right; start the (phone-scrollable) year there.
  useEffect(() => {
    if (scroller.current) scroller.current.scrollLeft = scroller.current.scrollWidth
  }, [scale, back])
  const pick = (v) => {
    setScale(v)
    setBack(0)
  }
  const cell = (d, round) => {
    if (!shown(d)) return <div key={d.getTime()} className="aspect-square" />
    const key = localDay(d)
    const pages = byDay.get(key) ?? 0
    const lv = level(key)
    const tip = `${fmt(d, { weekday: 'short', month: 'short', day: 'numeric' })}: ${pages ? `${Math.round(pages)} pages` : lv ? 'read' : 'no reading'}`
    return <div key={d.getTime()} title={tip} aria-label={tip} className={`aspect-square ${round} ${SHADES[lv]}`} />
  }
  // Share image: the period on screen, its reading days, pages and longest streak.
  const share = () => {
    let pages = 0, streak = 0, run = 0
    for (let d = first; d <= last && d <= today; d = new Date(d.getTime() + DAY_MS)) {
      const key = localDay(d)
      pages += byDay.get(key) ?? 0
      run = byDay.has(key) ? run + 1 : 0
      streak = Math.max(streak, run)
    }
    const lv = (d) => (shown(d) ? level(localDay(d)) : null)
    const day = (monday, r) => new Date(monday.getTime() + r * DAY_MS)
    const strip = (ws) => ({
      grid: WEEKDAYS.map((_, r) => ws.map((m) => lv(day(m, r)))),
      left: WEEKDAYS.map((w, r) => (r % 2 === 0 ? w : '')),
      bottom: ws.map((m, i) => (m.getDate() <= 7 || i === 0 ? fmt(m, { month: 'short' }) : '')),
    })
    // A year is two stacked half-year strips so the squares stay a readable size.
    const blocks = month
      ? [{ grid: weeks.map((m) => WEEKDAYS.map((_, r) => lv(day(m, r)))), top: WEEKDAYS }]
      : year
        ? [strip(weeks.slice(0, 26)), strip(weeks.slice(26))]
        : [strip(weeks)]
    const eyebrow = {
      month: back ? `My ${fmt(first, { month: 'long' })}` : 'My month',
      quarter: back ? 'My 3 months' : 'My last 3 months',
      year: back ? 'My year' : 'My past year',
    }[scale]
    return renderCalendarCard({
      eyebrow,
      heading: 'Reading days',
      subtitle: label,
      tiles: [
        ['reading days', count],
        ['pages read', Math.round(pages).toLocaleString()],
        ['day streak', streak],
      ],
      blocks,
    })
  }
  const arrow = 'grid size-9 place-items-center rounded-full text-stone-600 active:bg-stone-100 md:hover:bg-stone-100 disabled:opacity-30'
  return (
    <Card className="mt-4 p-4">
      {sharing && (
        <ShareSheet
          heading="Share your reading days"
          meta={{
            title: `Reading days: ${label}`,
            postTitle: `My reading days, ${label}`,
            fileName: `Reading days ${label}.png`,
            text: `${count} reading ${count === 1 ? 'day' : 'days'}, ${label}. Tracked with CrossPoint Sync.`,
          }}
          renderKey={`${scale}-${back}-${count}`}
          onClose={() => setSharing(false)}
          render={share}
        />
      )}
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="mr-auto font-display text-lg font-semibold text-stone-900">Reading days</h2>
        <button
          type="button"
          onClick={() => setSharing(true)}
          aria-label="Share your reading days"
          className="-my-2 -mr-2 grid size-10 place-items-center rounded-full text-brand-600 active:bg-stone-100 sm:order-last md:hover:bg-stone-100"
        >
          <Share2 className="size-5" strokeWidth={1.75} />
        </button>
        <div className="grid w-full grid-cols-3 gap-1 rounded-xl bg-stone-200/60 p-1 sm:w-auto">
          {SCALES.map(([v, l]) => (
            <button
              key={v}
              type="button"
              onClick={() => pick(v)}
              className={`h-8 rounded-lg px-3 text-xs font-semibold whitespace-nowrap transition ${
                scale === v ? 'bg-raised text-stone-900 shadow-sm' : 'text-stone-500 active:bg-stone-200'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between">
        <button type="button" className={arrow} onClick={() => setBack(back + 1)} aria-label="Earlier">
          <ChevronLeft className="size-5" strokeWidth={1.75} />
        </button>
        <div className="text-center">
          <p className="text-sm font-semibold text-stone-800">{label}</p>
          <p className="font-mono text-xs text-stone-500">
            {count} reading {count === 1 ? 'day' : 'days'}
          </p>
        </div>
        <button type="button" className={arrow} onClick={() => setBack(back - 1)} disabled={back === 0} aria-label="Later">
          <ChevronRight className="size-5" strokeWidth={1.75} />
        </button>
      </div>
      {month ? (
        // Month: a regular calendar, weekdays across the top and one row per week.
        <div className="mx-auto mt-3 grid max-w-sm grid-cols-7 gap-1.5">
          {WEEKDAYS.map((w) => (
            <p key={w} className="text-center font-mono text-[0.6rem] text-stone-400">
              {w}
            </p>
          ))}
          {weeks.map((monday) => WEEKDAYS.map((w, r) => cell(new Date(monday.getTime() + r * DAY_MS), 'rounded-md')))}
        </div>
      ) : (
        <div ref={scroller} className="mt-3 overflow-x-auto">
          <div
            className={`grid ${year ? 'w-max min-w-full' : 'w-full'}`}
            style={{
              gridAutoFlow: 'column',
              gridTemplateRows: 'repeat(7, auto) auto',
              gridTemplateColumns: `auto repeat(${weeks.length}, minmax(${year ? '11px' : '0'}, ${year ? '1fr' : '2.25rem'}))`,
              gap: 3,
              justifyContent: year ? undefined : 'center',
            }}
          >
            {WEEKDAYS.map((w, r) => (
              <p key={w} className="sticky left-0 z-10 flex min-w-6 items-center self-stretch bg-surface pr-1.5 font-mono text-[0.6rem] leading-none text-stone-400 shadow-[4px_0_0_white]">
                {!year || r % 2 === 0 ? w[0] : ''}
              </p>
            ))}
            <span />
            {weeks.map((monday) => (
              <Fragment key={monday.getTime()}>
                {WEEKDAYS.map((w, r) => cell(new Date(monday.getTime() + r * DAY_MS), 'rounded-[2px]'))}
                <p className="pt-1 font-mono text-[0.6rem] whitespace-nowrap text-stone-400">
                  {monday.getDate() <= 7 || monday.getTime() === weeks[0].getTime() ? fmt(monday, { month: 'short' }) : ''}
                </p>
              </Fragment>
            ))}
          </div>
        </div>
      )}
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

function PagesAndBooks({ activity: all, books, onShare }) {
  const titles = new Map(books.map((b) => [b.document, b.title || b.filename]))
  // Only books the library shows (metadata-less ones are hidden everywhere).
  const shown = all.books.filter((b) => titles.has(b.document))
  const activity = { ...all, books: shown, pages_total: shown.reduce((n, b) => n + (b.pages_read ?? 0), 0) }
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
      <Tiles
        tiles={tiles}
        action={
          <button
            onClick={onShare}
            aria-label="Share your stats"
            className="absolute top-1.5 right-1.5 z-10 grid size-10 place-items-center rounded-full text-brand-600 active:bg-stone-100 md:hover:bg-stone-100"
          >
            <Share2 className="size-5" strokeWidth={1.75} />
          </button>
        }
      />
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

// The stats share card: this year's headline numbers, recent covers, weekly pages.
function StatsShare({ summary, activity, books, onClose }) {
  const year = new Date().getFullYear()
  const shown = new Map(books.map((b) => [b.document, b]))
  const finished = activity.books
    .filter((b) => b.finished_at && shown.has(b.document))
    .sort((a, b) => b.finished_at - a.finished_at)
  const thisYear = finished.filter((b) => new Date(b.finished_at * 1000).getFullYear() === year)
  const pages = activity.books.filter((b) => shown.has(b.document)).reduce((n, b) => n + (b.pages_read ?? 0), 0)
  const hasTime = summary?.devices?.length > 0
  const tiles = [
    [`finished in ${year}`, thisYear.length],
    ['pages read', pages.toLocaleString()],
    ...(hasTime
      ? [
          ['hours read', Math.round(summary.seconds / 3600).toLocaleString()],
          ['day streak', summary.current_streak],
        ]
      : [['reading now', books.filter((b) => b.status === 'reading').length]]),
  ]
  const covers = finished.map((b) => shown.get(b.document).cover_url).filter(Boolean)
  const meta = {
    title: `${year} in books`,
    postTitle: `My ${year} in books`,
    fileName: `${year} in books.png`,
    text: `My ${year} in books: ${thisYear.length} finished, ${pages.toLocaleString()} pages read. Tracked with CrossPoint Sync.`,
  }
  return (
    <ShareSheet
      heading="Share your stats"
      meta={meta}
      renderKey={`${year}-${pages}-${thisYear.length}`}
      onClose={onClose}
      render={() => renderStatsCard({ heading: `${year} in books`, tiles, covers, weeks: weeklyPages(activity.days) })}
    />
  )
}

export default function Stats({ summary, activity, books }) {
  const hasTime = summary?.devices?.length > 0
  const [sharing, setSharing] = useState(false)
  return (
    <div className="px-4 pt-6 pb-4 md:px-8 md:pt-6 lg:px-12">
      <Eyebrow className="md:hidden">Reading stats</Eyebrow>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-stone-900 md:mt-0 md:flex md:h-11 md:items-center md:text-4xl">How you read</h1>
      {sharing && <StatsShare summary={summary} activity={activity} books={books} onClose={() => setSharing(false)} />}

      <h2 className="mt-8 font-display text-xl font-semibold text-stone-900">Pages &amp; books</h2>
      {activity ? <PagesAndBooks activity={activity} books={books} onShare={() => setSharing(true)} /> : <p className="py-6 text-sm text-stone-500">Loading…</p>}

      {hasTime ? (
        <>
          <h2 className="mt-10 font-display text-xl font-semibold text-stone-900">Reading time</h2>
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
        activity && <ReadingCalendar days={activity.days} />
      )}
    </div>
  )
}
