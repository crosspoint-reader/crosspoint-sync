import { useState } from 'react'
import { STATUS, Card, Cover, Eyebrow, ProgressBar, ago, duration, pct } from './ui.jsx'

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
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

export default function Library({ session, books, summary, activity }) {
  const [tab, setTab] = useState('reading')
  const counts = Object.fromEntries(STATUS.map((s) => [s.id, books.filter((b) => b.status === s.id).length]))
  const shown = books.filter((b) => b.status === tab)
  const [hero, ...rest] = tab === 'reading' ? shown : [null, ...shown]

  return (
    <div className="px-4 pt-6 pb-4 md:px-8 md:pt-10 lg:px-12">
      <div className="md:flex md:items-end md:justify-between md:gap-8">
      <div>
      <Eyebrow>{greeting()}</Eyebrow>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-stone-900 md:text-4xl">Your library</h1>
      </div>

      {(summary?.devices?.length > 0 || activity) && (
        <div className="mt-4 grid grid-cols-3 divide-x divide-stone-200 rounded-xl bg-white py-3 text-center ring-1 ring-stone-950/5 md:mt-0 md:w-96 md:shrink-0">
          {(summary?.devices?.length > 0
            ? [
                [summary.current_streak, 'day streak'],
                [duration(summary.seconds).split(' ')[0], 'read'],
                [summary.completed, 'finished'],
              ]
            : [
                [counts.reading, 'reading'],
                [activity.pages_total.toLocaleString(), 'pages read'],
                [activity.books.filter((b) => b.finished_at).length, 'finished'],
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

      <div className="-mx-4 mt-5 md:mx-0 md:mt-8 md:px-0 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none]">
        {STATUS.map((s) => (
          <button
            key={s.id}
            onClick={() => setTab(s.id)}
            className={`flex shrink-0 items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
              tab === s.id ? 'bg-brand-500 text-white shadow-sm' : 'bg-white text-stone-600 ring-1 ring-stone-950/10'
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
        {shown.length === 0 && (
          <p className="py-16 text-center text-sm text-stone-500">
            {books.length ? 'Nothing here yet.' : 'No synced books yet. Sync progress from your reader to see it here.'}
          </p>
        )}
      </div>

    </div>
  )
}
