import { invoke } from '@tauri-apps/api/core'
import { openUrl } from '@tauri-apps/plugin-opener'
import { http, ipcBytes, isApp } from './api.js'

// Clipping share cards: a 1080x1350 image (the portrait size feeds prefer) drawn
// on a canvas with the app's own fonts and colours, then handed to the native
// share sheet (Android bridge in MainActivity.kt, Web Share on iOS/macOS).

const W = 1080
const H = 1350
const PAD = 96
const C = {
  paper: '#f5f4ef',
  ink: '#292524',
  soft: '#78716c',
  faint: '#a8a29e',
  rule: '#d6d3d1',
  brand: '#3d6652',
  brandSoft: '#b3cfc2',
  brandRule: '#8fb9a6',
}

async function loadImage(url, viaApp) {
  try {
    // Remote covers go through Rust: a cross-origin image would taint the canvas.
    const res = await (viaApp ? http : fetch)(url)
    if (!res.ok) return null
    return await createImageBitmap(await res.blob())
  } catch {
    return null
  }
}

function wrap(ctx, text, width) {
  const lines = []
  for (const para of text.split(/\n+/)) {
    let line = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word
      if (ctx.measureText(next).width > width && line) {
        lines.push(line)
        line = word
      } else line = next
    }
    if (line) lines.push(line)
  }
  return lines
}

// Largest font size (68 down to 34) whose wrapped quote fits the box; beyond that, truncate.
function fitQuote(ctx, text, width, height) {
  for (let size = 68; size >= 34; size -= 2) {
    ctx.font = `italic 400 ${size}px Lora`
    const lh = Math.round(size * 1.42)
    const lines = wrap(ctx, text, width)
    if (lines.length * lh <= height) return { size, lh, lines }
  }
  const size = 34
  const lh = Math.round(size * 1.42)
  ctx.font = `italic 400 ${size}px Lora`
  const lines = wrap(ctx, text, width).slice(0, Math.floor(height / lh))
  lines[lines.length - 1] = lines[lines.length - 1].replace(/\s*\S*$/, '…')
  return { size, lh, lines }
}

function coverPlaceholder(ctx, x, y, w, h, title) {
  ctx.fillStyle = '#ebe7dd'
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 10)
  ctx.fill()
  ctx.fillStyle = C.ink
  ctx.font = '600 22px Lora'
  wrap(ctx, title, w - 28)
    .slice(0, 5)
    .forEach((l, i) => ctx.fillText(l, x + 14, y + 38 + i * 28))
}

export async function renderCard({ quote, title, author, chapter, coverUrl }) {
  await Promise.all(
    ['italic 400 48px Lora', '600 48px Lora', '500 34px "Inter Variable"', '500 40px Caveat', '400 24px "Geist Mono"'].map((f) =>
      document.fonts.load(f)
    )
  )
  const [cover, logo] = await Promise.all([coverUrl ? loadImage(coverUrl, isApp) : null, loadImage('/logo.png', false)])

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')

  // Paper with a faint grain, like the app's covers.
  ctx.fillStyle = C.paper
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = 'rgba(0,0,0,0.035)'
  for (let i = 0; i < 9000; i++) ctx.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5)

  ctx.textBaseline = 'alphabetic'
  ctx.fillStyle = C.brand
  ctx.font = '500 44px Caveat'
  ctx.save()
  ctx.translate(PAD, 150)
  ctx.rotate(-0.02)
  ctx.fillText('A passage worth keeping', 0, 0)
  ctx.restore()

  // The passage beside a green rule, with a big opening quote mark just above it.
  const top = 330
  const bottom = H - 450
  const textX = PAD + 44
  const { size, lh, lines } = fitQuote(ctx, quote, W - textX - PAD, bottom - top)
  const blockH = lines.length * lh
  const y0 = top + Math.max(0, (bottom - top - blockH) / 2)
  ctx.fillStyle = C.brandSoft
  ctx.font = '600 240px Lora'
  ctx.fillText('“', PAD - 18, y0 + 40)
  ctx.font = `italic 400 ${size}px Lora`
  ctx.fillStyle = C.brandRule
  ctx.fillRect(PAD, y0 + lh * 0.2, 5, blockH - lh * 0.1)
  ctx.fillStyle = C.ink
  lines.forEach((l, i) => ctx.fillText(l, textX, y0 + (i + 0.78) * lh))

  // Book: cover, title, author, chapter.
  ctx.fillStyle = C.rule
  ctx.fillRect(PAD, H - 380, W - PAD * 2, 2)
  const cx = PAD
  const cy = H - 330
  const cw = 150
  const ch = 225
  if (cover) {
    ctx.save()
    ctx.shadowColor = 'rgba(0,0,0,0.22)'
    ctx.shadowBlur = 24
    ctx.shadowOffsetY = 10
    ctx.beginPath()
    ctx.roundRect(cx, cy, cw, ch, 10)
    ctx.fillStyle = '#fff'
    ctx.fill()
    ctx.restore()
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(cx, cy, cw, ch, 10)
    ctx.clip()
    // Cover-fit crop to 2:3.
    const s = Math.max(cw / cover.width, ch / cover.height)
    ctx.drawImage(cover, cx + (cw - cover.width * s) / 2, cy + (ch - cover.height * s) / 2, cover.width * s, cover.height * s)
    ctx.restore()
  } else coverPlaceholder(ctx, cx, cy, cw, ch, title)

  const tx = cx + cw + 44
  const tw = W - tx - PAD
  ctx.fillStyle = C.ink
  ctx.font = '600 46px Lora'
  const titleLines = wrap(ctx, title, tw).slice(0, 2)
  titleLines.forEach((l, i) => ctx.fillText(l, tx, cy + 44 + i * 56))
  let y = cy + 44 + titleLines.length * 56
  if (author) {
    ctx.fillStyle = C.soft
    ctx.font = '500 32px "Inter Variable"'
    ctx.fillText(author, tx, y + 4)
    y += 50
  }
  if (chapter) {
    ctx.fillStyle = C.faint
    ctx.font = '400 24px "Geist Mono"'
    ctx.fillText(chapter.toUpperCase().slice(0, 40), tx, y + 8)
  }

  // Maker's mark.
  ctx.fillStyle = C.faint
  ctx.font = '500 26px "Inter Variable"'
  ctx.textAlign = 'right'
  ctx.fillText('CrossPoint Sync', W - PAD, H - 58)
  ctx.textAlign = 'left'
  if (logo) {
    const lw = ctx.measureText('CrossPoint Sync').width
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(W - PAD - lw - 50, H - 90, 38, 38, 9)
    ctx.clip()
    ctx.drawImage(logo, W - PAD - lw - 50, H - 90, 38, 38)
    ctx.restore()
  }

  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}

const toBase64 = (blob) =>
  new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1])
    r.readAsDataURL(blob)
  })

const byline = ({ title, author }) => `${title}${author ? `, ${author}` : ''}`

/** "quote" — Title, Author, trimming the quote so the whole post fits `limit` characters. */
export function shareText(meta, limit = Infinity) {
  // Stats and other non-quote cards bring their own text.
  if (meta.text) return meta.text.length > limit ? `${meta.text.slice(0, limit - 1).replace(/\s+\S*$/, '')}\u2026` : meta.text
  const tail = `\u201D\n\u2014 ${byline(meta)}`
  const room = limit - tail.length - 1
  const quote = meta.quote.length > room ? `${meta.quote.slice(0, Math.max(0, room - 1)).replace(/\s+\S*$/, '')}\u2026` : meta.quote
  return `\u201C${quote}${tail}`
}

const file = (blob) => new File([blob], 'clipping.png', { type: 'image/png' })

/** A native share sheet exists: Android's bridge, or Web Share with files (iOS, some desktops). */
export const canShareNatively = (blob) => Boolean(window.CrossPointShare || navigator.canShare?.({ files: [file(blob)] }))

export async function shareNatively(blob, meta) {
  const text = shareText(meta)
  if (window.CrossPointShare) return window.CrossPointShare.share(text, await toBase64(blob), meta.title)
  await navigator.share({ files: [file(blob)], text })
}

/** Put the card on the clipboard (with the quote as text where supported). Returns false if unsupported. */
export async function copyImage(blob, meta) {
  if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined') return false
  for (const parts of [
    { 'image/png': blob, 'text/plain': new Blob([shareText(meta)], { type: 'text/plain' }) },
    { 'image/png': blob },
  ]) {
    try {
      await navigator.clipboard.write([new ClipboardItem(parts)])
      return true
    } catch {
      // some platforms refuse mixed items; try image only
    }
  }
  return false
}

/** Save the card: Downloads in the app, a file download in a browser. */
export async function saveImage(blob, meta) {
  const name = meta.fileName ?? `${meta.title} clipping.png`
  if (isApp) return invoke('save_file', await ipcBytes(blob), { headers: { 'x-name': encodeURIComponent(name) } })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = name
  a.click()
}

// Compose pages that accept prefilled text. Images can't ride along in a URL, so
// the card goes on the clipboard first and the user pastes it into the post.
export const PLATFORMS = [
  { id: 'x', name: 'X', limit: 280, url: (t) => `https://x.com/intent/post?text=${encodeURIComponent(t)}` },
  { id: 'bluesky', name: 'Bluesky', limit: 300, url: (t) => `https://bsky.app/intent/compose?text=${encodeURIComponent(t)}` },
  { id: 'threads', name: 'Threads', limit: 500, url: (t) => `https://www.threads.net/intent/post?text=${encodeURIComponent(t)}` },
  { id: 'linkedin', name: 'LinkedIn', limit: 3000, url: (t) => `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(t)}` },
  {
    id: 'reddit',
    name: 'Reddit',
    limit: 10000,
    url: (t, meta) => `https://www.reddit.com/submit?type=TEXT&title=${encodeURIComponent(meta.postTitle ?? `From ${byline(meta)}`)}&text=${encodeURIComponent(t)}`,
  },
]

export async function postTo(platform, blob, meta) {
  const copied = await copyImage(blob, meta)
  const url = platform.url(shareText(meta, platform.limit), meta)
  if (isApp) await openUrl(url)
  else window.open(url, '_blank', 'noopener')
  return copied
}

// Reading stats card: headline numbers, recently finished covers, and a 12-week
// pages chart. `tiles` are [label, value] pairs (value already formatted).
export async function renderStatsCard({ heading, tiles, covers, weeks }) {
  await Promise.all(['600 48px Lora', '500 34px "Inter Variable"', '500 40px Caveat', '400 24px "Geist Mono"'].map((f) => document.fonts.load(f)))
  const [logo, ...images] = await Promise.all([loadImage('/logo.png', false), ...covers.slice(0, 5).map((u) => loadImage(u, isApp))])

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = C.paper
  ctx.fillRect(0, 0, W, H)
  ctx.fillStyle = 'rgba(0,0,0,0.035)'
  for (let i = 0; i < 9000; i++) ctx.fillRect(Math.random() * W, Math.random() * H, 1.5, 1.5)

  ctx.fillStyle = C.brand
  ctx.font = '500 44px Caveat'
  ctx.save()
  ctx.translate(PAD, 150)
  ctx.rotate(-0.02)
  ctx.fillText('My reading', 0, 0)
  ctx.restore()
  ctx.fillStyle = C.ink
  ctx.font = '600 84px Lora'
  ctx.fillText(heading, PAD, 250)

  // Headline numbers, two per row.
  const colW = (W - PAD * 2) / 2
  tiles.slice(0, 4).forEach(([label, value], i) => {
    const x = PAD + (i % 2) * colW
    const y = 400 + Math.floor(i / 2) * 170
    ctx.fillStyle = C.ink
    ctx.font = '600 76px Lora'
    ctx.fillText(String(value), x, y)
    ctx.fillStyle = C.soft
    ctx.font = '500 30px "Inter Variable"'
    ctx.fillText(label, x, y + 48)
  })

  // Recently finished covers.
  const shown = images.filter(Boolean)
  const coverTop = 400 + Math.ceil(Math.min(tiles.length, 4) / 2) * 170 + 10
  if (shown.length) {
    const cw = 150
    const chh = 225
    const gap = (W - PAD * 2 - cw * 5) / 4
    shown.forEach((img, i) => {
      const x = PAD + i * (cw + gap)
      ctx.save()
      ctx.shadowColor = 'rgba(0,0,0,0.2)'
      ctx.shadowBlur = 18
      ctx.shadowOffsetY = 8
      ctx.beginPath()
      ctx.roundRect(x, coverTop, cw, chh, 8)
      ctx.fillStyle = '#fff'
      ctx.fill()
      ctx.restore()
      ctx.save()
      ctx.beginPath()
      ctx.roundRect(x, coverTop, cw, chh, 8)
      ctx.clip()
      const s = Math.max(cw / img.width, chh / img.height)
      ctx.drawImage(img, x + (cw - img.width * s) / 2, coverTop + (chh - img.height * s) / 2, img.width * s, img.height * s)
      ctx.restore()
    })
  }

  // Pages per week, oldest to newest.
  const chartTop = shown.length ? coverTop + 290 : coverTop + 40
  const chartH = H - 150 - chartTop
  if (chartH > 60 && weeks.some((w) => w.pages)) {
    ctx.fillStyle = C.faint
    ctx.font = '400 22px "Geist Mono"'
    ctx.fillText('PAGES PER WEEK', PAD, chartTop)
    const max = Math.max(...weeks.map((w) => w.pages), 1)
    const bw = (W - PAD * 2) / weeks.length
    weeks.forEach((w, i) => {
      const h = Math.max(w.pages ? 4 : 0, ((chartH - 40) * w.pages) / max)
      ctx.fillStyle = i === weeks.length - 1 ? C.brand : C.brandRule
      ctx.beginPath()
      ctx.roundRect(PAD + i * bw + 6, chartTop + chartH - h, bw - 12, h, 5)
      ctx.fill()
    })
    ctx.fillStyle = C.rule
    ctx.fillRect(PAD, chartTop + chartH + 2, W - PAD * 2, 2)
  }

  ctx.fillStyle = C.faint
  ctx.font = '500 26px "Inter Variable"'
  ctx.textAlign = 'right'
  ctx.fillText('CrossPoint Sync', W - PAD, H - 58)
  ctx.textAlign = 'left'
  if (logo) {
    const lw = ctx.measureText('CrossPoint Sync').width
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(W - PAD - lw - 50, H - 90, 38, 38, 9)
    ctx.clip()
    ctx.drawImage(logo, W - PAD - lw - 50, H - 90, 38, 38)
    ctx.restore()
  }
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
}
