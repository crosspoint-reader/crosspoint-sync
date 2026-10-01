import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, ImagePlus, Loader2, RotateCcw, RotateCw, Search, Send as SendIcon, Sparkles, Wand2 } from 'lucide-react'
import { isApp } from './api.js'
import { reader, sendFile } from './catalogs.js'
import { folders, loadDevicePrefs, makeFolder } from './device.js'
import { saveImage } from './shareCard.js'
import { Card, EmptyState, Eyebrow, notify } from './ui.jsx'
import { CATEGORIES, canFilter, communityPage, fullImage } from './wallpaper/community.js'
import { DEFAULTS, DEVICES, DITHERS, autoLevels, placement, renderWallpaper, toBmp } from './wallpaper/render.js'

// Sleep-screen wallpaper creator, ported from zgredex's crosspoint-pxc-converter.
// Settings other than the picture are remembered per device.
const PREFS = 'crosspoint-wallpaper'
function loadPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS)) ?? {}
    return { ...DEFAULTS, device: saved.device ?? DEFAULTS.device, dither: saved.dither ?? DEFAULTS.dither }
  } catch {
    return DEFAULTS
  }
}

function Segmented({ value, options, onChange }) {
  return (
    <div className="grid gap-1 rounded-xl bg-stone-200/60 p-1" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`h-9 rounded-lg px-2 text-sm font-semibold whitespace-nowrap transition ${
            value === v ? 'bg-raised text-stone-900 shadow-sm' : 'text-stone-500 active:bg-stone-200'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function Slider({ label, value, min, max, step, onChange, format = (v) => v }) {
  return (
    <label className="flex items-center gap-3 text-sm text-stone-600">
      <span className="w-20 shrink-0">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className="min-w-0 flex-1 accent-brand-500" />
      <span className="w-10 text-right font-mono text-xs text-stone-700">{format(value)}</span>
    </label>
  )
}

// Grid columns for the community grid: grid-cols-3 sm:grid-cols-4 lg:grid-cols-6.
const COLUMN_QUERIES = [
  ['(min-width: 64rem)', 6],
  ['(min-width: 40rem)', 4],
]
function useColumns() {
  const current = () => COLUMN_QUERIES.find(([q]) => window.matchMedia(q).matches)?.[1] ?? 3
  const [cols, setCols] = useState(current)
  useEffect(() => {
    const lists = COLUMN_QUERIES.map(([q]) => window.matchMedia(q))
    const on = () => setCols(current())
    lists.forEach((l) => l.addEventListener('change', on))
    return () => lists.forEach((l) => l.removeEventListener('change', on))
  }, [])
  return cols
}

// Community wallpapers from readme.club: category, search and paging in the app;
// the newest 50 (search by title) in a plain browser.
function Community({ onPick }) {
  const [category, setCategory] = useState('')
  const [q, setQ] = useState('')
  const [query, setQuery] = useState('') // debounced q
  const [pages, setPages] = useState([]) // loaded pages of items
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    const t = setTimeout(() => setQuery(q), canFilter ? 400 : 0)
    return () => clearTimeout(t)
  }, [q])

  function load(page) {
    setLoading(true)
    setError(null)
    return communityPage({ category, q: query, page })
      .then((r) => {
        setPages((cur) => (page === 1 ? [r.items] : [...cur, r.items]))
        setTotal(r.total)
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    setPages([])
    load(1)
  }, [category, query])

  let items = pages.flat()
  // The RSS fallback has no server search: match titles here.
  if (!canFilter) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    items = items.filter((w) => words.every((t) => w.title.toLowerCase().includes(t)))
  }
  const more = canFilter && pages.length > 0 && pages.length * 32 < total && pages.at(-1).length > 0
  // Only whole rows while more can load; the remainder shows with the next page.
  const cols = useColumns()
  if (more && items.length >= cols) items = items.slice(0, items.length - (items.length % cols))

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="font-display text-xl font-semibold text-stone-900">Community wallpapers</h2>
        <a href="https://www.readme.club/wallpapers" target="_blank" rel="noreferrer" className="text-xs font-medium text-stone-500">
          from readme.club
        </a>
      </div>
      <div className="mt-3 flex max-w-xl gap-2">
        {canFilter && (
          <label className="flex h-11 shrink-0 items-center rounded-xl bg-surface px-3 ring-1 ring-stone-950/10">
            <span className="sr-only">Category</span>
            <select value={category} onChange={(e) => setCategory(e.target.value)} className="h-full bg-transparent text-sm text-stone-900 outline-none">
              {CATEGORIES.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-xl bg-surface px-3 ring-1 ring-stone-950/10 focus-within:ring-2 focus-within:ring-brand-500/60">
          <Search className="size-4 shrink-0 text-stone-400" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={canFilter ? 'Search wallpapers' : 'Search the newest wallpapers'}
            className="h-full min-w-0 flex-1 bg-transparent text-sm text-stone-900 outline-none placeholder:text-stone-400"
          />
        </label>
      </div>
      {canFilter && total > 0 && <p className="mt-2 font-mono text-xs text-stone-500">{total.toLocaleString()} wallpapers</p>}

      {items.length > 0 && (
        <div className="mt-4 grid grid-cols-3 gap-3 sm:grid-cols-4 lg:grid-cols-6">
          {items.map((w) => (
            <button key={w.id} type="button" onClick={() => onPick(w)} className="group min-w-0 text-left">
              <img
                src={w.thumb}
                alt=""
                loading="lazy"
                className="aspect-[3/5] w-full rounded-lg bg-stone-100 object-cover ring-1 ring-stone-950/10 transition group-active:scale-[0.97]"
              />
              <p className="mt-1 truncate text-xs text-stone-600">{w.title}</p>
            </button>
          ))}
        </div>
      )}
      {error ? (
        <p className="mt-4 text-sm text-stone-500">Couldn&apos;t load readme.club wallpapers ({error}).</p>
      ) : loading ? (
        <div className="mt-6 grid place-items-center">
          <Loader2 className="size-6 animate-spin text-stone-400" />
        </div>
      ) : !items.length ? (
        <EmptyState compact icon={Search} title="No wallpapers match">
          Try another word or category.
        </EmptyState>
      ) : (
        more && (
          <button
            type="button"
            onClick={() => load(pages.length + 1)}
            className="mx-auto mt-6 flex h-11 w-full max-w-xs items-center justify-center rounded-xl bg-surface px-6 text-sm font-semibold text-stone-800 ring-1 ring-stone-950/10 active:bg-stone-50 md:hover:bg-stone-50"
          >
            Load more
          </button>
        )
      )}
    </section>
  )
}

const baseName = (name) => name.replace(/\.[^.]+$/, '').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'wallpaper'

export default function Wallpaper() {
  const [img, setImg] = useState(null) // { el, name }
  const [s, setS] = useState(loadPrefs)
  const [auto, setAuto] = useState(false)
  const [status, setStatus] = useState(null) // { busy, text, error }
  const canvas = useRef(null)
  const result = useRef(null)
  const input = useRef(null)
  const drag = useRef(null)

  const set = (patch) => {
    setS((cur) => {
      const next = { ...cur, ...patch }
      try {
        localStorage.setItem(PREFS, JSON.stringify({ device: next.device, dither: next.dither }))
      } catch {
        // remembered for this session only
      }
      return next
    })
    setStatus(null)
  }
  // Manual tone changes drop the auto-levels lock, like the web converter.
  const tone = (patch) => {
    setAuto(false)
    set(patch)
  }

  function load(src, name, failure) {
    const el = new Image()
    el.crossOrigin = 'anonymous' // community images: keep the canvas readable
    el.onload = () => {
      setImg({ el, name })
      set({ zoom: 1, cx: 0.5, cy: 0.5, rotation: 0 })
      setAuto(true)
      window.scrollTo(0, 0)
    }
    el.onerror = () => setStatus({ error: true, text: failure })
    setStatus(null)
    el.src = src
  }
  const open = (file) => file && load(URL.createObjectURL(file), file.name, "That file isn't an image this device can open.")
  const pick = async (w) => {
    const failed = "Couldn't download that wallpaper. Check your connection and try again."
    setStatus({ busy: true, text: 'Loading wallpaper…' })
    try {
      load(await fullImage(w), w.title, failed)
    } catch {
      setStatus({ error: true, text: failed })
    }
  }

  // Re-run auto levels when the framing changes while it's on.
  const framing = `${s.device}|${s.mode}|${s.zoom}|${s.cx}|${s.cy}|${s.rotation}|${s.background}`
  useEffect(() => {
    if (!img || !auto) return
    const t = setTimeout(() => setS((cur) => ({ ...cur, ...autoLevels(img.el, cur), gammaValue: 1 })), 150)
    return () => clearTimeout(t)
  }, [img, auto, framing])

  // Render on the next frame so slider drags stay smooth.
  useEffect(() => {
    if (!img) return
    const id = requestAnimationFrame(() => {
      const r = renderWallpaper(img.el, s)
      result.current = r
      const c = canvas.current
      if (!c) return
      c.width = r.w
      c.height = r.h
      c.getContext('2d').putImageData(r.preview, 0, 0)
    })
    return () => cancelAnimationFrame(id)
  }, [img, s])

  // Drag the preview to move the crop.
  const onPointerDown = (e) => {
    if (s.mode !== 'fill') return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, cx: s.cx, cy: s.cy }
  }
  const onPointerMove = (e) => {
    const d = drag.current
    if (!d) return
    const p = placement(img.el, s)
    const perScreenPx = p.w / e.currentTarget.getBoundingClientRect().width // device px per CSS px
    const clamp = (v) => Math.min(1, Math.max(0, v))
    set({
      cx: clamp(d.cx - ((e.clientX - d.x) * perScreenPx) / p.scale / p.sw),
      cy: clamp(d.cy - ((e.clientY - d.y) * perScreenPx) / p.scale / p.sh),
    })
  }
  const endDrag = () => {
    // Store the clamped centre so the next drag starts where the crop visibly is.
    if (drag.current) {
      const p = placement(img.el, s)
      set({ cx: (p.w / 2 - p.dx) / p.scale / p.sw, cy: (p.h / 2 - p.dy) / p.scale / p.sh })
    }
    drag.current = null
  }

  const fileName = () => `${baseName(img.name)}-${s.device}-${Date.now().toString(36).slice(-4)}.bmp`

  async function send() {
    setStatus({ busy: true, text: 'Sending to reader…' })
    const prefs = { ...loadDevicePrefs(), optimize: false, renameFromMetadata: false }
    const file = new File([toBmp(result.current)], fileName(), { type: 'image/bmp' })
    try {
      const base = await reader(prefs)
      let folder = '/.sleep'
      try {
        await sendFile(file, { ...prefs, folder })
      } catch {
        // No /.sleep yet, and the reader won't create dot folders over Wi-Fi: use /sleep,
        // which CrossPoint reads whenever /.sleep has no wallpapers.
        folder = '/sleep'
        if (!(await folders(base)).includes('sleep')) await makeFolder(base, '/', 'sleep')
        await sendFile(file, { ...prefs, folder })
      }
      setStatus(null)
      notify({ title: 'Wallpaper sent to your reader', detail: `${file.name} in ${folder}` })
    } catch (e) {
      setStatus(null)
      notify({ error: true, title: "Couldn't send the wallpaper", detail: String(e?.message ?? e) })
    }
  }

  async function save() {
    setStatus({ busy: true, text: 'Saving…' })
    try {
      const name = fileName()
      const saved = await saveImage(toBmp(result.current), { fileName: name })
      setStatus(null)
      notify({ title: saved.photos ? 'Saved to your photos' : isApp ? 'Saved to Downloads' : 'Downloaded', detail: name })
    } catch (e) {
      setStatus(null)
      notify({ error: true, title: "Couldn't save the wallpaper", detail: String(e?.message ?? e) })
    }
  }

  const [w, h] = DEVICES[s.device]
  const actionBase = 'flex h-12 items-center justify-center gap-2 rounded-2xl text-sm font-semibold transition active:scale-[0.98] disabled:opacity-50'

  return (
    <div className="px-4 pt-6 pb-4 md:px-8 md:pt-6 lg:px-12">
      <div className="flex h-11 items-center">
        <a
          href="#/send"
          className="-ml-2 flex h-11 items-center gap-1.5 rounded-full pr-4 pl-2 text-lg font-semibold text-brand-600 transition active:bg-stone-200/70 md:hover:bg-stone-100"
        >
          <ArrowLeft className="size-6" strokeWidth={2} /> Send
        </a>
      </div>
      <Eyebrow className="mt-4">Sleep screen</Eyebrow>
      <h1 className="mt-1 font-display text-3xl font-semibold tracking-tight text-stone-900 md:text-4xl">Wallpaper</h1>
      <p className="mt-2 max-w-xl text-sm/6 text-stone-500">
        Turn a photo into a sleep screen, dithered to your reader&apos;s four shades of grey.
      </p>

      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          open(e.target.files?.[0])
          e.target.value = ''
        }}
      />

      {!img ? (
        <button
          onClick={() => input.current?.click()}
          className="mt-6 flex w-full max-w-xl flex-col items-center gap-2 rounded-xl border-2 border-dashed border-stone-300 bg-surface/60 px-4 py-10 text-center transition active:scale-[0.99]"
        >
          <ImagePlus className="size-8 text-brand-500" strokeWidth={1.5} />
          <span className="font-semibold text-stone-900">Choose a photo</span>
          <span className="text-xs text-stone-500">PNG, JPG, WebP, GIF or BMP</span>
        </button>
      ) : null}
      {!img && status?.text && <p className={`mt-3 text-sm ${status.error ? 'text-red-700' : 'text-stone-600'}`}>{status.text}</p>}
      {!img && <Community onPick={pick} />}
      {!img ? null : (
        <div className="mt-6 md:grid md:grid-cols-[minmax(0,22rem)_1fr] md:items-start md:gap-8">
          <div className="md:sticky md:top-6">
            <canvas
              ref={canvas}
              width={w}
              height={h}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              style={{ imageRendering: 'pixelated' }}
              className={`mx-auto block h-auto max-h-[60vh] w-auto max-w-full rounded-xl bg-surface shadow-sm ring-1 ring-stone-950/10 ${
                s.mode === 'fill' ? 'cursor-grab touch-none active:cursor-grabbing' : ''
              }`}
            />
            <p className="mt-2 text-center font-mono text-[0.65rem] text-stone-400">
              {w}×{h}
              {s.mode === 'fill' && ' · drag to move the crop'}
            </p>
          </div>

          <div className="mt-4 space-y-4 md:mt-0">
            <Card className="space-y-4 p-4">
              <Segmented value={s.device} options={Object.keys(DEVICES).map((d) => [d, d])} onChange={(device) => set({ device })} />
              <Segmented
                value={s.mode}
                options={[
                  ['fill', 'Fill screen'],
                  ['fit', 'Fit whole photo'],
                ]}
                onChange={(mode) => set({ mode })}
              />
              {s.mode === 'fill' ? (
                <Slider label="Zoom" value={s.zoom} min={1} max={4} step={0.05} onChange={(zoom) => set({ zoom })} format={(v) => `${v.toFixed(1)}×`} />
              ) : (
                <Segmented
                  value={s.background}
                  options={[
                    ['white', 'White edges'],
                    ['black', 'Black edges'],
                  ]}
                  onChange={(background) => set({ background })}
                />
              )}
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => set({ rotation: (s.rotation + 270) % 360 })}
                  className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-stone-100 text-sm font-medium text-stone-700 active:bg-stone-200"
                >
                  <RotateCcw className="size-4" /> Rotate left
                </button>
                <button
                  type="button"
                  onClick={() => set({ rotation: (s.rotation + 90) % 360 })}
                  className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-stone-100 text-sm font-medium text-stone-700 active:bg-stone-200"
                >
                  <RotateCw className="size-4" /> Rotate right
                </button>
              </div>
            </Card>

            <Card className="space-y-4 p-4">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-lg font-semibold text-stone-900">Tone</h2>
                <button
                  type="button"
                  onClick={() => setAuto(true)}
                  className={`flex h-9 items-center gap-1.5 rounded-full px-3 text-sm font-semibold transition ${
                    auto ? 'bg-brand-50 text-brand-600 ring-1 ring-brand-200' : 'text-stone-600 active:bg-stone-100'
                  }`}
                >
                  <Wand2 className="size-4" /> Auto
                </button>
              </div>
              <Slider label="Blacks" value={s.blackPoint} min={0} max={254} step={1} onChange={(v) => tone({ blackPoint: Math.min(v, s.whitePoint - 1) })} />
              <Slider label="Whites" value={s.whitePoint} min={1} max={255} step={1} onChange={(v) => tone({ whitePoint: Math.max(v, s.blackPoint + 1) })} />
              <Slider label="Gamma" value={s.gammaValue} min={0.3} max={3} step={0.05} onChange={(gammaValue) => tone({ gammaValue })} format={(v) => v.toFixed(2)} />
              <Slider label="Contrast" value={s.contrastValue} min={-100} max={100} step={1} onChange={(contrastValue) => tone({ contrastValue })} />
              <div className="flex items-center justify-between gap-3">
                <label className="flex items-center gap-2 text-sm text-stone-600">
                  <input type="checkbox" checked={s.invert} onChange={(e) => tone({ invert: e.target.checked })} className="size-4 accent-brand-500" />
                  Invert
                </label>
                <button
                  type="button"
                  onClick={() => tone({ blackPoint: 0, whitePoint: 255, gammaValue: 1, contrastValue: 0, invert: false })}
                  className="text-sm font-medium text-stone-500 active:text-stone-800"
                >
                  Reset
                </button>
              </div>
              <label className="block text-xs font-medium text-stone-500">
                Dithering
                <div className="mt-1 flex h-11 items-center gap-2 rounded-xl bg-stone-50 px-3 ring-1 ring-stone-950/10">
                  <Sparkles className="size-4 text-stone-400" />
                  <select value={s.dither} onChange={(e) => set({ dither: e.target.value })} className="h-full min-w-0 flex-1 bg-transparent text-sm text-stone-900 outline-none">
                    {DITHERS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
              </label>
            </Card>

            <div className="grid grid-cols-2 gap-2">
              {isApp && (
                <button onClick={send} disabled={status?.busy} className={`${actionBase} col-span-2 bg-brand-500 text-white shadow-sm`}>
                  {status?.busy ? <Loader2 className="size-5 animate-spin" /> : <SendIcon className="size-5" />} Send to reader
                </button>
              )}
              <button onClick={save} disabled={status?.busy} className={`${actionBase} bg-surface text-stone-800 ring-1 ring-stone-950/10`}>
                <Download className="size-4" /> Save image
              </button>
              <button onClick={() => setImg(null)} className={`${actionBase} bg-surface text-stone-800 ring-1 ring-stone-950/10`}>
                <ImagePlus className="size-4" /> Start over
              </button>
            </div>
            {status?.text && <p className={`text-sm ${status.error ? 'text-red-700' : 'text-stone-600'}`}>{status.text}</p>}
            <p className="text-xs/5 text-stone-500">
              On your reader, set Sleep Screen Cover Filter to No Filter to keep all four shades. A /sleep.bmp at the top of the SD card overrides
              the rotating sleep screens.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}
