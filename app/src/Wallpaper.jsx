import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Download, ImagePlus, Loader2, RotateCcw, RotateCw, Send as SendIcon, Sparkles, Wand2 } from 'lucide-react'
import { isApp } from './api.js'
import { reader, sendFile } from './catalogs.js'
import { folders, loadDevicePrefs, makeFolder } from './device.js'
import { saveImage } from './shareCard.js'
import { Card, Eyebrow } from './ui.jsx'
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

  function open(file) {
    if (!file) return
    const el = new Image()
    el.onload = () => {
      setImg({ el, name: file.name })
      set({ zoom: 1, cx: 0.5, cy: 0.5, rotation: 0 })
      setAuto(true)
    }
    el.onerror = () => setStatus({ error: true, text: "That file isn't an image this device can open." })
    el.src = URL.createObjectURL(file)
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
      try {
        await sendFile(file, { ...prefs, folder: '/.sleep' })
        setStatus({ text: 'Added to your sleep screens (/.sleep).' })
      } catch {
        // No /.sleep yet, and the reader won't create dot folders over Wi-Fi: use /sleep,
        // which CrossPoint reads whenever /.sleep has no wallpapers.
        if (!(await folders(base)).includes('sleep')) await makeFolder(base, '/', 'sleep')
        await sendFile(file, { ...prefs, folder: '/sleep' })
        setStatus({ text: 'Added to your sleep screens (/sleep).' })
      }
    } catch (e) {
      setStatus({ error: true, text: String(e?.message ?? e) })
    }
  }

  async function save() {
    setStatus({ busy: true, text: 'Saving…' })
    try {
      const name = fileName()
      await saveImage(toBmp(result.current), { fileName: name })
      setStatus({ text: isApp ? `Saved ${name} to Downloads.` : `Downloaded ${name}.` })
    } catch (e) {
      setStatus({ error: true, text: String(e?.message ?? e) })
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
        Turn a photo into a sleep screen, dithered to your reader&apos;s four shades of grey. Based on the{' '}
        <a href="https://github.com/itsthisjustin/crosspoint-pxc-converter" target="_blank" rel="noreferrer" className="font-medium text-brand-600">
          CrossPoint wallpaper converter
        </a>{' '}
        by{' '}
        <a href="https://github.com/zgredex" target="_blank" rel="noreferrer" className="font-medium text-brand-600">
          zgredex
        </a>
        .
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
          className="mt-6 flex w-full max-w-xl flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-stone-300 bg-surface/60 px-4 py-10 text-center transition active:scale-[0.99]"
        >
          <ImagePlus className="size-8 text-brand-500" strokeWidth={1.5} />
          <span className="font-semibold text-stone-900">Choose a photo</span>
          <span className="text-xs text-stone-500">PNG, JPG, WebP, GIF or BMP</span>
        </button>
      ) : null}
      {!img && status?.text && <p className="mt-3 text-sm text-red-700">{status.text}</p>}
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
              <button onClick={() => input.current?.click()} className={`${actionBase} bg-surface text-stone-800 ring-1 ring-stone-950/10`}>
                <ImagePlus className="size-4" /> New photo
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
