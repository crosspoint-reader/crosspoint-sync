import { Fragment, useEffect, useRef, useState } from 'react'
import { BookOpen, ChevronLeft, ChevronRight, CircleCheck, Share2 } from 'lucide-react'
import ShareSheet from './ShareSheet.jsx'
import { renderCalendarCard, renderStatsCard } from './shareCard.js'
import { Card, Cover, Eyebrow, ProgressBar, duration, pct } from './ui.jsx'
import { isPace, moodEmoji } from './moods.js'

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

// Moods and genres across your books (from Hardcover's catalog, via the server).
// Counts each book once per tag; DNF books are left out of your taste profile.
function tagCounts(books, field) {
  const counts = new Map()
  for (const b of books) for (const t of b[field] ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

// Top moods across the given documents (most common first), for share cards.
function topMoods(books, documents, n = 3) {
  const byDoc = new Map(books.map((b) => [b.document, b]))
  const picked = [...new Set(documents)].map((d) => byDoc.get(d)).filter((b) => b && b.status !== 'dnf')
  return tagCounts(picked, 'moods').filter(([m]) => !isPace(m)).slice(0, n).map(([m]) => m)
}

// Moods as outlined stickers, with how many of your books carry each.
function MoodStickers({ rows }) {
  return (
    <div className="mt-3 flex flex-wrap gap-x-3 gap-y-4 pt-1">
      {rows.map(([mood, n]) => (
        <span
          key={mood}
          className="relative inline-flex items-center gap-1.5 rounded-full border-2 border-stone-900 bg-surface px-3.5 py-1.5 text-base font-semibold text-stone-900 shadow-[3px_3px_0_var(--color-stone-900)]"
        >
          <span aria-hidden="true">{moodEmoji(mood)}</span>
          {mood}
          <span className="absolute -top-2.5 -right-2 grid size-5 place-items-center rounded-full bg-brand-500 font-mono text-[0.6rem] text-white ring-2 ring-surface">
            {n}
          </span>
        </span>
      ))}
    </div>
  )
}

// Genres as book spines on a shelf: taller spine, more books.
const SPINES = [
  'bg-brand-500 text-white',
  'bg-brand-300 text-stone-900',
  'bg-stone-300 text-stone-900',
  'bg-brand-200 text-stone-900',
  'bg-brand-400 text-white',
]
const SPINE_WIDTHS = ['w-14', 'w-12', 'w-16', 'w-11', 'w-13']
function GenreShelf({ rows }) {
  const max = Math.max(...rows.map(([, n]) => n), 1)
  return (
    <div>
      <div className="flex h-48 items-end justify-center gap-1.5 px-2">
        {rows.map(([genre, n], i) => (
          <div
            key={genre}
            title={`${genre}: ${n} book${n === 1 ? '' : 's'}`}
            style={{ height: `${45 + (n / max) * 55}%` }}
            className={`relative flex shrink-0 flex-col items-center justify-between rounded-t-md pt-2 pb-1.5 ${SPINES[i % SPINES.length]} ${SPINE_WIDTHS[i % SPINE_WIDTHS.length]}`}
          >
            {/* Two thin bands near the top, like a printed spine */}
            <span className="absolute inset-x-1.5 top-1.5 h-px bg-current opacity-30" />
            <span className="absolute inset-x-1.5 top-2.5 h-px bg-current opacity-30" />
            <span
              className={`mt-2 min-h-0 flex-1 overflow-hidden font-display font-semibold text-ellipsis whitespace-nowrap [writing-mode:vertical-rl] rotate-180 ${
                genre.length > 14 ? 'text-xs' : 'text-sm'
              }`}
            >
              {genre}
            </span>
            <span className="mt-1 font-mono text-[0.65rem] opacity-80">{n}</span>
          </div>
        ))}
      </div>
      <div className="h-2 rounded-sm bg-stone-300 shadow-[0_2px_0_var(--color-stone-400)]" />
    </div>
  )
}

function WhatYouRead({ books }) {
  const read = books.filter((b) => b.status !== 'dnf')
  const all = tagCounts(read, 'moods')
  const moods = all.filter(([m]) => !isPace(m)).slice(0, 5)
  const pace = all.find(([m]) => isPace(m))?.[0]
  const genres = tagCounts(read, 'genres').slice(0, 5)
  if (!moods.length && !genres.length) return null
  return (
    <section>
      <h2 className="mt-10 font-display text-xl font-semibold text-stone-900">What you read</h2>
      <div className="md:grid md:grid-cols-2 md:gap-4">
        {moods.length > 0 && (
          <Card className="mt-4 p-4">
            <h3 className="font-display text-lg font-semibold text-stone-900">Your moods</h3>
            <MoodStickers rows={moods} />
            {pace && (
              <p className="mt-3 text-xs text-stone-500">
                Mostly {pace.toLowerCase()} {moodEmoji(pace)}
              </p>
            )}
          </Card>
        )}
        {genres.length > 0 && (
          <Card className="mt-4 p-4">
            <h3 className="mb-3 font-display text-lg font-semibold text-stone-900">Your genres</h3>
            <GenreShelf rows={genres} />
          </Card>
        )}
      </div>
      <p className="mt-3 text-xs/5 text-stone-500">From Hardcover readers&apos; tags for each book. Books you didn&apos;t finish are left out.</p>
    </section>
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

function ReadingCalendar({ days, books = [] }) {
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
    // Moods of the books read in this period.
    const inPeriod = days.filter((d) => {
      const at = dayDate(d.day)
      return at >= first && at <= last
    })
    const moods = topMoods(books, inPeriod.flatMap((d) => (d.books ?? []).map((b) => b.document)))
    return renderCalendarCard({
      eyebrow,
      moods,
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
  // This year's moods: books finished this year, else anything read this year.
  const readThisYear = activity.books.filter((b) => new Date(b.last_at * 1000).getFullYear() === year)
  const moods = topMoods(books, (thisYear.length ? thisYear : readThisYear).map((b) => b.document))
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
      renderKey={`${year}-${pages}-${thisYear.length}-${moods.join()}`}
      onClose={onClose}
      render={() => renderStatsCard({ heading: `${year} in books`, tiles, covers, weeks: weeklyPages(activity.days), moods })}
    />
  )
}

// Overview / Timeline tabs, kept in the URL (#/stats, #/stats/timeline) so back returns to the same tab.
const TABS = [
  ['', 'Overview'],
  ['timeline', 'Timeline'],
]
function StatsTabs({ tab }) {
  return (
    <nav className="mt-5 flex gap-6 border-b border-stone-200">
      {TABS.map(([id, label]) => (
        <a
          key={id}
          href={id ? `#/stats/${id}` : '#/stats'}
          aria-current={tab === id ? 'page' : undefined}
          className={`-mb-px border-b-2 pb-2.5 text-sm font-semibold transition ${
            tab === id ? 'border-brand-500 text-stone-900' : 'border-transparent text-stone-500 hover:text-stone-800'
          }`}
        >
          {label}
        </a>
      ))}
    </nav>
  )
}

const dayDate = (day) => new Date(`${day}T12:00`)
const shortDate = (d) =>
  d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) })

// What happened to one book on one day, in words.
function dayEvent(entry, act, day) {
  const on = (unix) => unix && localDay(new Date(unix * 1000)) === day
  if (on(act?.finished_at)) return { icon: CircleCheck, text: 'Finished' }
  if (on(act?.started_at) && entry.from <= 0.02) return { icon: BookOpen, text: 'Started reading' }
  const span = entry.to > entry.from ? `${pct(entry.from)} to ${pct(entry.to)}` : `at ${pct(entry.to)}`
  if (entry.pages > 0) return { icon: BookOpen, text: `Read ${entry.pages} page${entry.pages === 1 ? '' : 's'} · ${span}` }
  return { icon: BookOpen, text: entry.to > entry.from ? `Read ${span}` : `Opened ${span}` }
}

const DAYS_PER_PAGE = 21

function Timeline({ session, activity, books }) {
  const [shown, setShown] = useState(DAYS_PER_PAGE)
  const byDoc = new Map(books.map((b) => [b.document, b]))
  const acts = new Map(activity.books.map((b) => [b.document, b]))
  const reading = books.filter((b) => b.status === 'reading').sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))
  const days = activity.days
    .map((d) => ({ ...d, books: (d.books ?? []).filter((b) => byDoc.has(b.document)) }))
    .filter((d) => d.books.length)
    .reverse()

  return (
    <div className="max-w-2xl">
      {reading.length > 0 && (
        <Card className="mt-6 divide-y divide-stone-100 px-4">
          <h2 className="flex items-center gap-2 py-3 font-display text-lg font-semibold text-stone-900">
            <BookOpen className="size-5 text-brand-600" strokeWidth={1.75} />
            {reading.length} reading
          </h2>
          {reading.map((b) => (
            <a key={b.document} href={`#/book/${b.document}`} className="flex items-center gap-4 py-3">
              <Cover session={session} book={b} tiny className="w-14" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-display text-base font-semibold text-stone-900">{b.title || b.filename}</p>
                {b.timestamp && <p className="mt-0.5 text-xs text-stone-500">Last read {shortDate(new Date(b.timestamp * 1000))}</p>}
                <div className="mt-2 flex items-center gap-3">
                  <ProgressBar value={b.percentage} className="flex-1" />
                  <span className="w-9 text-right font-mono text-xs text-brand-600">{pct(b.percentage)}</span>
                </div>
              </div>
              <ChevronRight className="size-5 shrink-0 text-stone-400" />
            </a>
          ))}
        </Card>
      )}

      {!days.length ? (
        <p className="py-10 text-center text-sm text-stone-500">Your reading shows up here as your reader syncs.</p>
      ) : (
        <ol className="mt-8">
          {days.slice(0, shown).map((d) => {
            const date = dayDate(d.day)
            return (
              <li key={d.day} className="relative pb-6 pl-7">
                {/* Dot and connecting line */}
                <span className="absolute top-1.5 left-0 size-3 rounded-full bg-brand-500 ring-4 ring-stone-50" />
                <span className="absolute top-6 bottom-0 left-[5px] border-l-2 border-dashed border-stone-200" />
                <p className="flex items-baseline gap-2">
                  <span className="font-display text-base font-semibold text-stone-900">
                    {date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
                  </span>
                  {date.getFullYear() !== new Date().getFullYear() && <span className="font-mono text-xs text-stone-500">{date.getFullYear()}</span>}
                </p>
                <div className="mt-3 space-y-2">
                  {d.books.map((entry) => {
                    const b = byDoc.get(entry.document)
                    const ev = dayEvent(entry, acts.get(entry.document), d.day)
                    return (
                      <a key={entry.document} href={`#/book/${entry.document}`} className="flex items-center gap-3 rounded-2xl bg-surface p-3 ring-1 ring-stone-950/5 transition active:scale-[0.99] md:hover:bg-stone-50">
                        <Cover session={session} book={b} tiny className="w-11" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-semibold text-stone-900">{b.title || b.filename}</p>
                          <p className={`mt-1 flex items-center gap-1.5 text-xs ${ev.text === 'Finished' ? 'font-medium text-brand-600' : 'text-stone-500'}`}>
                            <ev.icon className="size-3.5 shrink-0" strokeWidth={2} />
                            <span className="truncate">{ev.text}</span>
                          </p>
                        </div>
                        <ChevronRight className="size-4 shrink-0 text-stone-400" />
                      </a>
                    )
                  })}
                </div>
              </li>
            )
          })}
        </ol>
      )}
      {days.length > shown && (
        <button
          type="button"
          onClick={() => setShown(shown + DAYS_PER_PAGE)}
          className="mx-auto mb-4 flex h-11 w-full max-w-xs items-center justify-center rounded-xl bg-surface px-6 text-sm font-semibold text-stone-800 ring-1 ring-stone-950/10 active:bg-stone-50 md:hover:bg-stone-50"
        >
          Show earlier days
        </button>
      )}
    </div>
  )
}

export default function Stats({ session, tab = '', summary, activity, books }) {
  const hasTime = summary?.devices?.length > 0
  const [sharing, setSharing] = useState(false)
  const header = (
    <>
      <Eyebrow className="md:hidden">Reading stats</Eyebrow>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-stone-900 md:mt-0 md:flex md:h-11 md:items-center md:text-4xl">How you read</h1>
      <StatsTabs tab={tab} />
    </>
  )
  if (tab === 'timeline') {
    return (
      <div className="px-4 pt-6 pb-4 md:px-8 md:pt-6 lg:px-12">
        {header}
        {activity ? <Timeline session={session} activity={activity} books={books} /> : <p className="py-6 text-sm text-stone-500">Loading…</p>}
      </div>
    )
  }
  return (
    <div className="px-4 pt-6 pb-4 md:px-8 md:pt-6 lg:px-12">
      {header}
      {sharing && <StatsShare summary={summary} activity={activity} books={books} onClose={() => setSharing(false)} />}

      <h2 className="mt-8 font-display text-xl font-semibold text-stone-900">Pages &amp; books</h2>
      {activity ? <PagesAndBooks activity={activity} books={books} onShare={() => setSharing(true)} /> : <p className="py-6 text-sm text-stone-500">Loading…</p>}
      <WhatYouRead books={books} />

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
        activity && <ReadingCalendar days={activity.days} books={books} />
      )}
    </div>
  )
}
