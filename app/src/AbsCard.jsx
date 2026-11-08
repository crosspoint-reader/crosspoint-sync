import { useState } from 'react'
import { Headphones } from 'lucide-react'
import { api } from './api.js'
import { Calibrate, clock } from './SpotifyCard.jsx'
import { Card, pct, useLoad } from './ui.jsx'

// The audiobook's place on Audiobookshelf next to the reader's, with the same
// "Not the right spot?" calibration as Spotify. Shown only when ABS has this book.
export default function AbsCard({ session, book, revision = 0 }) {
  const [services] = useLoad(() => api.bookMatches(session, book.document), [book.document, revision], `matches ${book.document}`)
  const linked = !!services?.some((s) => s.id === 'audiobookshelf' && s.matched)
  const [data, , reload] = useLoad(() => (linked ? api.absTracks(session, book.document) : Promise.resolve(null)), [book.document, linked, revision])
  const [calibrating, setCalibrating] = useState(false)
  if (!data?.matched) return null
  const at = data.position_ms ?? 0
  const current = data.tracks.findLast((t) => t.start_ms <= at) ?? data.tracks[0]
  const service = {
    name: 'Audiobookshelf',
    tracks: () => Promise.resolve(data),
    save: (s, doc, track, ms) => api.setAbsAnchor(s, doc, track, ms),
    clear: (s, doc) => api.clearAbsAnchor(s, doc),
  }

  return (
    <Card className="mt-4 p-4">
      <p className="flex items-center gap-1.5 text-xs font-medium text-stone-500">
        <Headphones className="size-3.5" strokeWidth={2} /> Audiobookshelf
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-3">
        <div>
          <dt className="text-xs text-stone-500">Reader</dt>
          <dd className="font-mono text-sm font-semibold text-stone-900">{pct(book.percentage)}</dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">Audiobookshelf</dt>
          <dd className="font-mono text-sm font-semibold text-stone-900">
            {data.finished ? 'Finished' : data.listened_pct == null ? 'Not started' : pct(data.listened_pct)}
          </dd>
          {data.position_ms != null && (
            <dd className="truncate text-xs text-stone-500">
              {current.name} / {clock(at - current.start_ms)}
            </dd>
          )}
        </div>
      </dl>
      <button type="button" onClick={() => setCalibrating(!calibrating)} className="mt-2 w-full text-center text-xs font-medium text-stone-500">
        {calibrating ? 'Cancel' : data.anchor ? 'Lined up with your reader · Adjust' : 'Not the right spot?'}
      </button>
      {calibrating && (
        <Calibrate
          session={session}
          book={book}
          data={data}
          service={service}
          track={current.index}
          onDone={() => {
            setCalibrating(false)
            reload()
          }}
        />
      )}
    </Card>
  )
}
