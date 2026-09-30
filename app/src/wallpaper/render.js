// Photo -> CrossPoint sleep-screen wallpaper: rotate, crop or fit to the reader,
// tone-map, dither to the panel's four greys, and encode a native-palette BMP.
// The tone, dither and BMP code is ported unchanged from crosspoint-pxc-converter
// by zgredex (github.com/zgredex).
import { ditherToIndexedGray } from './dither.ts'
import { encodeGrayBmp } from './bmpGray.ts'
import { GRAY_DISP, getQuantProfile } from './quantize.ts'
import { buildLuminanceBuffer, buildToneLut, computeAutoLevels } from './tone.ts'

export const DEVICES = { X4: [480, 800], X3: [528, 792] }

export const DITHERS = [
  ['zhou-fang', 'Zhou-Fang'],
  ['fs', 'Floyd-Steinberg'],
  ['atk', 'Atkinson'],
  ['jjn', 'Jarvis'],
  ['stucki', 'Stucki'],
  ['burkes', 'Burkes'],
  ['bayer', 'Bayer'],
  ['blue-noise', 'Blue noise'],
  ['off', 'No dithering'],
]

export const DEFAULTS = {
  device: 'X4',
  mode: 'fill', // fill = crop to the screen, fit = letterbox
  zoom: 1,
  cx: 0.5, // crop centre in the rotated source, 0..1
  cy: 0.5,
  rotation: 0,
  background: 'white',
  blackPoint: 0,
  whitePoint: 255,
  gammaValue: 1,
  contrastValue: 0,
  invert: false,
  dither: 'zhou-fang',
}

// Halved copies of the rotated source, so each final draw is a single <=2x
// downscale (a one-step browser downscale of a 12MP photo aliases badly).
const chains = new WeakMap()
function mipChain(img, rotation) {
  let byRot = chains.get(img)
  if (!byRot) chains.set(img, (byRot = new Map()))
  if (byRot.has(rotation)) return byRot.get(rotation)
  const turned = rotation % 180 !== 0
  const base = document.createElement('canvas')
  base.width = turned ? img.naturalHeight : img.naturalWidth
  base.height = turned ? img.naturalWidth : img.naturalHeight
  const ctx = base.getContext('2d')
  ctx.translate(base.width / 2, base.height / 2)
  ctx.rotate((rotation * Math.PI) / 180)
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2)
  const levels = [base]
  while (levels.at(-1).width > 256 && levels.at(-1).height > 256) {
    const prev = levels.at(-1)
    const next = document.createElement('canvas')
    next.width = Math.round(prev.width / 2)
    next.height = Math.round(prev.height / 2)
    const nctx = next.getContext('2d')
    nctx.imageSmoothingQuality = 'high'
    nctx.drawImage(prev, 0, 0, next.width, next.height)
    levels.push(next)
  }
  byRot.set(rotation, levels)
  return levels
}

// Where the rotated source lands on the w x h screen.
export function placement(img, s) {
  const [w, h] = DEVICES[s.device]
  const turned = s.rotation % 180 !== 0
  const sw = turned ? img.naturalHeight : img.naturalWidth
  const sh = turned ? img.naturalWidth : img.naturalHeight
  if (s.mode === 'fit') {
    const scale = Math.min(w / sw, h / sh)
    return { w, h, sw, sh, scale, dx: (w - sw * scale) / 2, dy: (h - sh * scale) / 2 }
  }
  const scale = Math.max(w / sw, h / sh) * s.zoom
  // Keep the crop inside the source.
  const halfW = w / scale / 2
  const halfH = h / scale / 2
  const cx = Math.min(Math.max(s.cx * sw, halfW), sw - halfW)
  const cy = Math.min(Math.max(s.cy * sh, halfH), sh - halfH)
  return { w, h, sw, sh, scale, dx: w / 2 - cx * scale, dy: h / 2 - cy * scale }
}

// Colour pixels at screen size, before tone and dithering.
function scaled(img, s) {
  const p = placement(img, s)
  const canvas = document.createElement('canvas')
  canvas.width = p.w
  canvas.height = p.h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  ctx.fillStyle = s.background === 'black' ? '#000' : '#fff'
  ctx.fillRect(0, 0, p.w, p.h)
  const levels = mipChain(img, s.rotation)
  const needW = p.sw * p.scale
  const src = levels.findLast((c) => c.width >= needW) ?? levels[0]
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, p.dx, p.dy, p.sw * p.scale, p.sh * p.scale)
  return ctx.getImageData(0, 0, p.w, p.h)
}

/** Black/white points from the luminance of the current framing. */
export function autoLevels(img, s) {
  const lum = buildLuminanceBuffer(scaled(img, s).data)
  const hist = new Uint32Array(256)
  for (const v of lum) hist[Math.min(255, Math.round(v))]++
  return computeAutoLevels(hist, lum.length)
}

/** Render to four-grey indices plus a preview ImageData. */
export function renderWallpaper(img, s) {
  const pixels = scaled(img, s)
  const { width: w, height: h } = pixels
  const lum = buildLuminanceBuffer(pixels.data)
  const lut = buildToneLut(s)
  for (let i = 0; i < lum.length; i++) lum[i] = lut[Math.min(255, Math.round(lum[i]))]
  const off = s.dither === 'off'
  const q = ditherToIndexedGray(lum, w, h, !off, off ? 'fs' : s.dither, getQuantProfile('pr1614'))
  const preview = new ImageData(w, h)
  for (let i = 0; i < q.length; i++) {
    const g = GRAY_DISP[q[i]]
    preview.data[i * 4] = preview.data[i * 4 + 1] = preview.data[i * 4 + 2] = g
    preview.data[i * 4 + 3] = 255
  }
  return { q, w, h, preview }
}

export const toBmp = ({ q, w, h }) => new Blob([encodeGrayBmp(q, w, h)], { type: 'image/bmp' })
