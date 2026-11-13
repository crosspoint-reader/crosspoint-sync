import { buildCpfonts } from './vendor/build.js'
import { resolveIntervals } from './vendor/intervals.js'

// Standard reader sizes and the converter's default "reading" coverage. No bundled
// fallback fonts: glyphs the Google family lacks fall back to the reader's own font.
self.onmessage = async ({ data }) => {
  try {
    const files = await buildCpfonts({ family: data.family, styles: data.styles, sizes: [12, 14, 16, 18], intervals: resolveIntervals('reading') })
    self.postMessage({ files }, files.map((f) => f.data.buffer))
  } catch (e) {
    self.postMessage({ error: e?.message || 'Font conversion failed' })
  }
}
