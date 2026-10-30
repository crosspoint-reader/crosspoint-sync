import { hasReadingTime, readingStreak } from './readingHistory.js'
import { useMemo, useState } from 'react'
import { BookOpen, ChevronRight, Merge } from 'lucide-react'
import { isApp } from './api.js'
import { firstDuplicate } from './Book.jsx'
import { STATUS, Cover, EmptyAction, EmptyState, ProgressBar, ago, duration, pct } from './ui.jsx'

function greeting() {
  const now = new Date()
  const h = now.getHours() + now.getMinutes() / 60
  // 5am-noon morning, noon-4:30pm afternoon, 4:30-10pm evening; the small hours get their own.
  if (h >= 5 && h < 12) return 'Good morning'
  if (h >= 12 && h < 16.5) return 'Good afternoon'
  if (h >= 16.5 && h < 22) return 'Good evening'
  return 'Hello, night owl'
}

function ReadingCard({ session, book }) {
  return (
    <a href={`#/book/${book.document}`} className="block">
      <div className="relative mt-5 flex items-start gap-4 rounded-xl bg-surface p-4 ring-1 ring-stone-950/5 md:gap-8 md:p-6">
        <div aria-hidden="true" className="paper-grain pointer-events-none absolute inset-0 rounded-xl opacity-[0.04]" />
        <div aria-hidden="true" className="dot-field-sm pointer-events-none absolute inset-y-0 right-0 w-1/2 rounded-r-xl text-stone-200 [mask-image:linear-gradient(to_left,black,transparent)]" />
        <Cover session={session} book={book} className="w-28 sm:w-36 md:w-40" />
        <div className="relative flex min-w-0 flex-1 flex-col self-stretch">
          <p className="text-xs font-medium text-brand-600">{book.history_only ? 'Reading history' : 'Continue reading'}</p>
          <h2 className="mt-2 line-clamp-3 font-display text-xl/snug font-semibold text-stone-900 md:text-2xl/snug">{book.title || book.filename}</h2>
          <p className="truncate text-sm text-stone-500 md:text-base">{book.author}</p>
          <div className="mt-auto pt-3 md:max-w-md">
            <div className="mb-1.5 flex justify-between text-xs tabular-nums text-stone-500">
              <span className="font-semibold text-brand-600">{book.history_only ? 'Historical reading' : pct(book.percentage)}</span>
              <span>{ago(book.timestamp)}</span>
            </div>
            {!book.history_only && <ProgressBar value={book.percentage} />}
          </div>
        </div>
      </div>
    </a>
  )
}

function Row({ session, book }) {
  return (
    <a href={`#/book/${book.document}`} className="group flex items-center gap-3 py-3 active:bg-stone-100 md:flex-col md:items-stretch md:gap-2.5 md:py-0 md:active:bg-transparent">
      <Cover session={session} book={book} small className="w-12 transition md:w-full md:group-hover:-translate-y-0.5 md:group-hover:shadow-md" />
      <div className="min-w-0 flex-1">
        <p className="truncate font-display md:text-sm text-[0.95rem] font-semibold text-stone-900">{book.title || book.filename || 'Untitled book'}</p>
        <p className="truncate text-xs text-stone-500">{book.author}</p>
        {book.history_only ? <p className="mt-2 text-xs text-stone-500">Historical reading</p> : <div className="mt-2 flex items-center gap-2">
          <ProgressBar value={book.percentage} className="flex-1" />
          <span className="w-9 text-right font-mono text-[0.7rem] text-stone-500">{pct(book.percentage)}</span>
        </div>}
      </div>
    </a>
  )
}

// Newest first, by what each tab is about: finish date for Finished, when the
// status was set for Paused / Did not finish, last sync for Reading.
function sortForTab(list, tab, activity) {
  const finishedAt = new Map((activity?.books ?? []).map((b) => [b.document, b.finished_at]))
  const key =
    tab === 'finished'
      ? (b) => finishedAt.get(b.document) ?? b.status_at ?? b.timestamp ?? 0
      : tab === 'reading'
        ? (b) => b.timestamp ?? 0
        : (b) => b.status_at ?? b.timestamp ?? 0
  return [...list].sort((a, b) => key(b) - key(a))
}

export default function Library({ session, books, summary, activity }) {
  const [tab, setTab] = useState('reading')
  const counts = Object.fromEntries(STATUS.map((s) => [s.id, books.filter((b) => b.status === s.id).length]))
  const shown = sortForTab(books.filter((b) => b.status === tab), tab, activity)
  // First book that looks like another synced copy of itself.
  // Only when the books change, not on every render.
  const dupe = useMemo(() => firstDuplicate(books), [books])
  // Totals count only books the library shows, as Stats does: metadata-less
  // syncs are hidden everywhere, so they mustn't add a "finished" here (#18).
  const listed = new Set(books.map((b) => b.document))
  const read = (activity?.books ?? []).filter((b) => listed.has(b.document))

  return (
    <div className="px-4 pt-6 pb-4 md:px-8 md:pt-6 lg:px-12">
      <p className="mb-1 inline-block -rotate-1 pr-12 font-hand text-2xl/7 text-brand-600">{greeting()}</p>
      <h1 className="pr-12 font-display text-3xl font-semibold tracking-tight text-stone-900 md:text-4xl">Your library</h1>

      {(hasReadingTime(summary) || activity) && (
        <div className="mt-4 grid grid-cols-3 divide-x divide-stone-200 rounded-xl bg-surface py-3 text-center ring-1 ring-stone-950/5">
          {(hasReadingTime(summary)
            ? [
                [readingStreak(summary, activity), 'day streak'],
                [duration(summary.seconds).split(' ')[0], 'read'],
                [counts.finished, 'finished'],
              ]
            : [
                [counts.reading, 'reading'],
                [read.reduce((n, b) => n + (b.pages_read ?? 0), 0).toLocaleString(), 'pages read'],
                [counts.finished, 'finished'],
              ]
          ).map(([v, l]) => (
            <div key={l}>
              <p className="font-display text-xl font-semibold text-stone-900">{v}</p>
              <p className="text-xs text-stone-500">{l}</p>
            </div>
          ))}
        </div>
      )}

      {dupe && (
        <a href={`#/book/${dupe.document}`} className="mt-4 flex items-center gap-2 rounded-xl bg-brand-50 px-4 py-3 text-sm text-brand-800 active:bg-brand-100">
          <Merge className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-semibold">{dupe.title}</span> appears more than once. Merge the copies to keep progress together.
          </span>
          <ChevronRight className="size-4 shrink-0" />
        </a>
      )}

      <div className="-mx-4 mt-5 md:mx-0 md:mt-8 md:px-0 flex gap-5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {STATUS.map((s) => (
          <button
            key={s.id}
            onClick={() => setTab(s.id)}
            aria-pressed={tab === s.id}
            className={`flex min-h-11 shrink-0 items-center gap-1.5 border-b-2 py-2 text-sm font-medium transition ${
              tab === s.id ? 'border-brand-500 text-brand-700' : 'border-transparent text-stone-500'
            }`}
          >
            {s.label} <span className="ml-0.5 text-xs tabular-nums">{counts[s.id]}</span>
          </button>
        ))}
      </div>

      {tab === 'reading' && shown.map((book) => <ReadingCard key={book.document} session={session} book={book} />)}

      <div className="mt-4">
        {tab !== 'reading' && shown.length > 0 && (
          <div className="divide-y divide-stone-200 md:mt-8 md:grid md:grid-cols-4 md:gap-x-6 md:gap-y-8 md:divide-y-0 lg:grid-cols-5 xl:grid-cols-6">
            {shown.map((b) => (
              <Row key={b.document} session={session} book={b} />
            ))}
          </div>
        )}
        {shown.length === 0 && <LibraryEmpty tab={tab} hasBooks={books.length > 0} />}
      </div>

    </div>
  )
}

// What each Library tab says when it's empty, and where to go instead.
const EMPTY = {
  reading: {
    note: 'Your shelf is waiting',
    title: 'Nothing in progress',
    body: 'Open a book on your CrossPoint and it shows up here as it syncs.',
    action: isApp ? ['#/browse', 'Find a book'] : null,
  },
  paused: {
    note: 'Taking a breather?',
    title: 'No paused books',
    body: 'Set a book aside from its page and it waits here until you pick it back up.',
  },
  finished: {
    note: 'The best part is ahead',
    title: 'No finished books yet',
    body: 'Books you finish land here, along with how long each one took.',
    action: ['#/stats', 'See your stats'],
  },
  dnf: {
    note: 'Life is too short',
    title: 'Nothing abandoned',
    body: 'Books you stop reading go here, guilt-free. Not every book is for everyone.',
  },
}

function LibraryEmpty({ tab, hasBooks }) {
  if (!hasBooks) {
    return (
      <EmptyState
        icon={BookOpen}
        note="Let's get reading"
        title="No books synced yet"
        action={isApp ? <EmptyAction href="#/send">Send a book to your reader</EmptyAction> : null}
      >
        Turn on CrossPoint Sync in your reader&apos;s settings and your books appear here as you read.
      </EmptyState>
    )
  }
  const e = EMPTY[tab]
  const status = STATUS.find((s) => s.id === tab)
  return (
    <EmptyState icon={status?.icon} note={e.note} title={e.title} action={e.action && <EmptyAction href={e.action[0]}>{e.action[1]}</EmptyAction>}>
      {e.body}
    </EmptyState>
  )
}
