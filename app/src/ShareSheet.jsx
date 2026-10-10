import { useEffect, useState } from 'react'
import { Copy, Download, Share2, X } from 'lucide-react'
import { PLATFORMS, canShareNatively, copyImage, postTo, saveImage, shareNatively } from './shareCard.js'
import { Spinner } from './ui.jsx'

// Preview a generated share card, then share it natively, copy/save it, or post it
// (desktop). Used for clippings and the stats card.
export default function ShareSheet({ heading, meta, render, renderKey, onClose, children }) {
  const [card, setCard] = useState(null) // { blob, url }
  const [status, setStatus] = useState(null)

  useEffect(() => {
    let url
    let live = true
    ;(async () => {
      const blob = await render()
      url = URL.createObjectURL(blob)
      if (live) setCard({ blob, url })
    })().catch(() => live && setStatus({ error: "Couldn't make the share card." }))
    return () => {
      live = false
      if (url) URL.revokeObjectURL(url)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [renderKey])

  const native = card && canShareNatively(card.blob)
  const desktop = !/android|iphone|ipad/i.test(navigator.userAgent)
  async function act(fn, done) {
    setStatus({ busy: true })
    try {
      const note = await fn()
      setStatus(note ? { note: done(note) } : null)
    } catch (e) {
      if (e?.name !== 'AbortError') setStatus({ error: "That didn't work on this device." })
      else setStatus(null)
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center md:items-center">
      <div className="absolute inset-0 bg-stone-950/40" onClick={onClose} />
      <div className="relative max-h-[92dvh] w-full overflow-y-auto rounded-t-[28px] bg-stone-50 p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))] md:max-w-md md:rounded-[28px] md:p-6">
        <div className="mx-auto mb-4 h-1.5 w-10 rounded-full bg-stone-300 md:hidden" />
        <button onClick={onClose} className="absolute top-3 right-3 grid size-10 place-items-center rounded-full text-stone-500 active:bg-stone-200" aria-label="Close">
          <X className="size-5" />
        </button>
        <h2 className="font-display text-xl font-semibold text-stone-900">{heading}</h2>
        {children}
        <div className="mx-auto mt-4 aspect-[4/5] w-full max-w-72 overflow-hidden rounded-xl shadow-lg ring-1 ring-stone-950/10">
          {card ? <img src={card.url} alt="Share card preview" className="size-full" /> : <div className="grid size-full place-items-center bg-cover"><Spinner /></div>}
        </div>

        {native && (
          <button
            disabled={status?.busy}
            onClick={() => act(() => shareNatively(card.blob, meta).then(() => null), () => null)}
            className="mt-5 flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-500 text-base font-semibold text-white shadow-sm active:scale-[0.98] disabled:opacity-60"
          >
            <Share2 className="size-5" /> Share
          </button>
        )}

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button
            disabled={!card || status?.busy}
            onClick={() => act(() => copyImage(card.blob, meta).then((ok) => (ok ? 'copied' : 'nocopy')), (r) => (r === 'copied' ? 'Image copied to the clipboard.' : "This device can't copy images; use Save instead."))}
            className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-surface text-sm font-semibold text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100 disabled:opacity-50"
          >
            <Copy className="size-4" /> Copy image
          </button>
          <button
            disabled={!card || status?.busy}
            onClick={() => act(() => saveImage(card.blob, meta).then((r) => (r.photos ? 'photos' : 'saved')), (n) => (n === 'photos' ? 'Saved to your photos.' : desktop ? 'Saved to your Downloads folder.' : 'Image saved.'))}
            className="flex h-12 items-center justify-center gap-2 rounded-2xl bg-surface text-sm font-semibold text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100 disabled:opacity-50"
          >
            <Download className="size-4" /> Save image
          </button>
        </div>

        {desktop && (
          <>
            <p className="mt-5 text-xs font-medium text-stone-500">Post to</p>
            <div className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-5">
              {PLATFORMS.map((p) => (
                <button
                  key={p.id}
                  disabled={!card || status?.busy}
                  onClick={() =>
                    act(
                      () => postTo(p, card.blob, meta).then((copied) => (copied ? 'posted' : 'posted-nocopy')),
                      (r) => (r === 'posted' ? `Image copied. Paste it into your ${p.name} post.` : `Opened ${p.name}. Save the image to attach it.`)
                    )
                  }
                  className="h-11 rounded-xl bg-surface text-sm font-semibold text-stone-700 ring-1 ring-stone-950/10 active:bg-stone-100 disabled:opacity-50 md:hover:bg-stone-100"
                >
                  {p.name}
                </button>
              ))}
            </div>
          </>
        )}

        {(status?.note || status?.error) && (
          <p className={`mt-4 text-center text-sm ${status.error ? 'text-red-600' : 'text-stone-600'}`}>{status.note ?? status.error}</p>
        )}
      </div>
    </div>
  )
}
