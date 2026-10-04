import { useState } from 'react'
import { BookOpen, ChevronRight, Merge } from 'lucide-react'
import { isApp } from './api.js'
import { looksLikeSame } from './Book.jsx'
import { STATUS, Card, Cover, EmptyAction, EmptyState, Eyebrow, ProgressBar, ago, duration, pct } from './ui.jsx'

function greeting() {
  const now = new Date()
  const h = now.getHours() + now.getMinutes() / 60
  // 5am-noon morning, noon-4:30pm afternoon, 4:30-10pm evening; the small hours get their own.
  if (h >= 5 && h < 12) return 'Good morning'
  if (h >= 12 && h < 16.5) return 'Good afternoon'
  if (h >= 16.5 && h < 22) return 'Good evening'
  return 'Hello, night owl'
}

function Hero({ session, book }) {
  return (
    <a href={`#/book/${book.document}`} className="block">
      <Card className="relative flex gap-4 overflow-hidden p-4 md:gap-6 md:p-6">
        <div className="dot-field-sm pointer-events-none absolute inset-y-0 right-0 w-1/2 text-stone-200 [mask-image:linear-gradient(to_left,black,transparent)]" />
        <Cover session={session} book={book} className="w-24 md:w-36" />
        <div className="relative flex min-w-0 flex-1 flex-col">
          <p className="font-mono text-[0.65rem] font-medium tracking-wider text-stone-400 uppercase">Continue reading</p>
          <h2 className="mt-1 line-clamp-2 font-display text-lg/snug font-semibold text-stone-900 md:text-2xl/snug">{book.title || book.filename}</h2>
          <p className="truncate text-sm text-stone-500 md:text-base">{book.author}</p>
          <div className="mt-auto pt-3 md:max-w-md">
            <div className="mb-1.5 flex justify-between font-mono text-xs text-stone-500">
              <span className="font-semibold text-brand-600">{pct(book.percentage)}</span>
              <span>{ago(book.timestamp)}</span>
            </div>
            <ProgressBar value={book.percentage} />
          </div>
        </div>
      </Card>
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
        <div className="mt-2 flex items-center gap-2">
          <ProgressBar value={book.percentage} className="flex-1" />
          <span className="w-9 text-right font-mono text-[0.7rem] text-stone-500">{pct(book.percentage)}</span>
        </div>
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
  const dupe = books.find((b) => books.some((o) => looksLikeSame(b, o)))
  const [hero, ...rest] = tab === 'reading' ? shown : [null, ...shown]
  // Totals count only books the library shows, as Stats does: metadata-less
  // syncs are hidden everywhere, so they mustn't add a "finished" here (#18).
  const listed = new Set(books.map((b) => b.document))
  const read = (activity?.books ?? []).filter((b) => listed.has(b.document))

  return (
    <div className="px-4 pt-6 pb-4 md:px-8 md:pt-6 lg:px-12">
      <div className="md:flex md:items-start md:justify-between md:gap-8">
      <div>
      <Eyebrow className="md:hidden">{greeting()}</Eyebrow>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-stone-900 md:mt-0 md:flex md:h-11 md:items-center md:text-4xl">Your library</h1>
      </div>

      {(summary?.devices?.length > 0 || activity) && (
        <div className="mt-4 grid grid-cols-3 divide-x divide-stone-200 rounded-xl bg-surface py-3 text-center ring-1 ring-stone-950/5 md:mt-0 md:w-96 md:shrink-0">
          {(summary?.devices?.length > 0
            ? [
                [summary.current_streak, 'day streak'],
                [duration(summary.seconds).split(' ')[0], 'read'],
                [summary.completed, 'finished'],
              ]
            : [
                [counts.reading, 'reading'],
                [read.reduce((n, b) => n + (b.pages_read ?? 0), 0).toLocaleString(), 'pages read'],
                [read.filter((b) => b.finished_at).length, 'finished'],
              ]
          ).map(([v, l]) => (
            <div key={l}>
              <p className="font-display text-xl font-semibold text-stone-900">{v}</p>
              <p className="text-[0.7rem] text-stone-500">{l}</p>
            </div>
          ))}
        </div>
      )}
      </div>

      {dupe && (
        <a href={`#/book/${dupe.document}`} className="mt-4 flex items-center gap-2 rounded-xl bg-brand-50 px-4 py-3 text-sm text-brand-800 active:bg-brand-100">
          <Merge className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">
            <span className="font-semibold">{dupe.title}</span> appears more than once. Merge the copies to keep progress together.
          </span>
          <ChevronRight className="size-4 shrink-0" />
        </a>
      )}

      <div className="-mx-4 mt-5 md:mx-0 md:mt-8 md:px-0 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {STATUS.map((s) => (
          <button
            key={s.id}
            onClick={() => setTab(s.id)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
              tab === s.id ? 'bg-brand-500 text-white shadow-sm' : 'bg-surface text-stone-600 ring-1 ring-stone-950/10'
            }`}
          >
            <s.icon className="size-4" strokeWidth={2} />
            {s.label} <span className="ml-0.5 font-mono text-xs opacity-70">{counts[s.id]}</span>
          </button>
        ))}
      </div>

      <div className="mt-4">
        {hero && <Hero session={session} book={hero} />}
        {rest.length > 0 && (
          <Card className="mt-4 divide-y divide-stone-100 px-4 md:mt-8 md:grid md:grid-cols-4 md:gap-x-6 md:gap-y-8 md:divide-y-0 md:bg-transparent md:px-0 md:ring-0 lg:grid-cols-5 xl:grid-cols-6">
            {rest.map((b) => (
              <Row key={b.document} session={session} book={b} />
            ))}
          </Card>
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
