import { http } from '../api.js'

// Google Fonts catalog via Fontsource's keyless API; the TTFs come from Google's CSS2 API,
// which serves full (unsubsetted) TrueType files to clients without a browser user agent.
let catalog
export function googleFonts() {
  catalog ??= http('https://api.fontsource.org/v1/fonts?type=google')
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`Font list failed (${res.status})`))))
    .catch((e) => {
      catalog = null
      throw e
    })
  return catalog
}

export const familyName = (family) => family.replace(/[^A-Za-z0-9_-]+/g, '')

// The four styles the reader uses, as [ital, weight] pairs this font actually has.
export function pickFaces({ weights, styles }) {
  const near = (w) => weights.reduce((a, b) => (Math.abs(b - w) < Math.abs(a - w) ? b : a))
  const reg = near(400)
  const bold = near(700) > reg ? near(700) : null
  const italic = styles.includes('italic')
  return Object.fromEntries(
    [
      ['regular', [0, reg]],
      ['bold', bold && [0, bold]],
      ['italic', italic && [1, reg]],
      ['bolditalic', italic && bold && [1, bold]],
    ].filter(([, v]) => v)
  )
}

async function css(family, faces) {
  const tuples = [...new Set(Object.values(faces).map((f) => f.join(',')))].sort()
  const res = await http(`https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:ital,wght@${tuples.join(';')}`)
  return res.ok ? res.text() : null
}

// { regular: Uint8Array, bold?, italic?, bolditalic? }
export async function downloadFamily(font) {
  let faces = pickFaces(font)
  let text = await css(font.family, faces)
  if (!text) {
    // Some families list italics that don't exist at every weight: fall back to upright only.
    faces = Object.fromEntries(Object.entries(faces).filter(([, [ital]]) => !ital))
    text = await css(font.family, faces)
  }
  if (!text) throw new Error(`Google Fonts doesn't have ${font.family}`)
  const urls = {}
  for (const block of text.split('@font-face').slice(1)) {
    const ital = /font-style:\s*italic/.test(block) ? 1 : 0
    const weight = Number(/font-weight:\s*(\d+)/.exec(block)?.[1])
    const url = /url\(([^)]+\.ttf)\)/.exec(block)?.[1]
    if (url) urls[`${ital},${weight}`] = url
  }
  const out = {}
  for (const [style, face] of Object.entries(faces)) {
    const url = urls[face.join(',')]
    if (!url) continue
    const res = await http(url)
    if (!res.ok) throw new Error(`Couldn't download ${font.family} ${style}`)
    out[style] = new Uint8Array(await res.arrayBuffer())
  }
  if (!out.regular) throw new Error(`Google Fonts didn't send a TrueType file for ${font.family}`)
  return out
}

// Rasterize to .cpfont in a worker (FreeType wasm). Resolves to [{ name, data }].
export function convert(family, styles) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
    worker.onmessage = ({ data }) => {
      worker.terminate()
      data.error ? reject(new Error(data.error)) : resolve(data.files)
    }
    worker.onerror = (e) => {
      worker.terminate()
      reject(new Error(e.message || 'Font conversion failed'))
    }
    worker.postMessage({ family, styles })
  })
}

// Font files picked on this device, grouped as one family by filename: "Lora-BoldItalic.ttf" -> bolditalic.
const STYLE = [
  ['bolditalic', /[-_ ]?bold[-_ ]?(italic|oblique)$/i],
  ['bold', /[-_ ]?bold$/i],
  ['italic', /[-_ ]?(italic|oblique)$/i],
  ['regular', /[-_ ]?(regular|normal|book|roman)$/i],
]
export async function localFamily(files) {
  const styles = {}
  let family = ''
  for (const file of files) {
    const stem = file.name.replace(/\.(ttf|otf)$/i, '')
    const [style, re] = STYLE.find(([, re]) => re.test(stem)) ?? ['regular', /$^/]
    styles[style] ??= new Uint8Array(await file.arrayBuffer())
    if (style === 'regular' || !family) family = stem.replace(re, '')
  }
  styles.regular ??= styles.bold ?? styles.italic ?? styles.bolditalic
  return { family, styles }
}

export const trueTypeFiles = (family, styles) =>
  Object.entries(styles).map(([style, data]) => ({ name: `${family}-${{ regular: 'Regular', bold: 'Bold', italic: 'Italic', bolditalic: 'BoldItalic' }[style]}.${String.fromCharCode(...data.slice(0, 4)) === 'OTTO' ? 'otf' : 'ttf'}`, data }))
