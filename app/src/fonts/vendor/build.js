// Browser-side .cpfont generator.
//
// Port of scripts/font-builder/fontconvert_sdcard.py (rasterize_font_style,
// pack_style_sections, generate_cpfont_multistyle, main). The Python script is
// still the reference implementation and the parity test
// (scripts/font-builder/parity.mjs) compares this output against it byte for
// byte — change both together.

import {
  FtFace, FT_LOAD_FORCE_AUTOHINT, FT_LOAD_NO_BITMAP, FT_LOAD_RENDER, loadFreeType,
} from './freetype.js'
import { deriveKernClasses, extractKerning, extractLigatures, openFont } from './opentype.js'
import { CPFONT_VERSION, FontBuildError } from './intervals.js'

const STYLE_NAMES = { 0: 'regular', 1: 'bold', 2: 'italic', 3: 'bolditalic' }

const MAGIC = [0x43, 0x50, 0x46, 0x4f, 0x4e, 0x54, 0x00, 0x00] // "CPFONT\0\0"
const HEADER_SIZE = 32
const STYLE_TOC_ENTRY_SIZE = 32
const GLYPH_STRUCT_SIZE = 16

// One loaded font file: the FreeType face (rasterizing, cmap) and the fontkit
// font (kern/GPOS/GSUB tables), both over the same bytes.
class FontSource {
  constructor(mod, bytes, label) {
    this.bytes = bytes
    this.label = label
    this.face = new FtFace(mod, bytes, label)
    this._font = null
    this._charmap = null
  }

  get font() {
    if (!this._font) this._font = openFont(this.bytes, this.label)
    return this._font
  }

  get charmap() {
    if (!this._charmap) this._charmap = this.face.charmap()
    return this._charmap
  }

  free() {
    this.face.free()
  }
}

// Resolves intervals against primary coverage, then the fallback chain. Each
// fallback only fills holes left by earlier faces, so the primary family stays
// authoritative.
function resolveStyleCoverage(primary, fallbacks, intervals) {
  const validatedIntervals = []
  const codepointSources = new Map()
  const sourceCodepoints = [new Set(), ...fallbacks.map(() => new Set())]

  for (const [intervalStart, intervalEnd] of intervals) {
    const coverages = [primary, ...fallbacks].map(
      (source) => source.face.coverageRange(intervalStart, intervalEnd))

    let runStart = null
    let runEnd = null
    for (let codePoint = intervalStart; codePoint <= intervalEnd; codePoint++) {
      const offset = codePoint - intervalStart
      let sourceIndex = null
      for (let i = 0; i < coverages.length; i++) {
        if (coverages[i][offset]) { sourceIndex = i; break }
      }

      if (sourceIndex === null) {
        if (runStart !== null) {
          validatedIntervals.push([runStart, runEnd])
          runStart = null
          runEnd = null
        }
        continue
      }

      sourceCodepoints[sourceIndex].add(codePoint)
      codepointSources.set(codePoint, sourceIndex)

      if (runStart === null) runStart = codePoint
      runEnd = codePoint
    }

    if (runStart !== null) validatedIntervals.push([runStart, runEnd])
  }

  return { intervals: validatedIntervals, codepointSources, sourceCodepoints }
}

// Rasterizes all glyphs for one font style.
function rasterizeFontStyle(primary, size, intervals, options) {
  const { styleId = 0, forceAutohint = false, fallbacks = [], darkenAa = false, log } = options
  const styleLabel = STYLE_NAMES[styleId] ?? String(styleId)

  const sources = [primary, ...fallbacks]
  for (const source of sources) source.face.setSize(size)

  let loadFlags = FT_LOAD_RENDER | FT_LOAD_NO_BITMAP
  if (forceAutohint) loadFlags |= FT_LOAD_FORCE_AUTOHINT

  log(`  [${styleLabel}] Validating intervals against font coverage...`)
  const coverage = resolveStyleCoverage(primary, fallbacks, intervals)
  const validatedIntervals = coverage.intervals
  const totalGlyphs = validatedIntervals.reduce((sum, [start, end]) => sum + end - start + 1, 0)
  log(`  [${styleLabel}] Validated: ${validatedIntervals.length} intervals, ${totalGlyphs} glyphs`)

  const coverageParts = [`${coverage.sourceCodepoints[0].size} primary`]
  for (let i = 1; i < coverage.sourceCodepoints.length; i++) {
    coverageParts.push(`${coverage.sourceCodepoints[i].size} fallback${i} (${fallbacks[i - 1].label})`)
  }
  log(`  [${styleLabel}] Coverage split: ${coverageParts.join(', ')}`)

  // Rasterize all glyphs
  let totalBitmapSize = 0
  const allGlyphs = []

  for (const [intervalStart, intervalEnd] of validatedIntervals) {
    for (let codePoint = intervalStart; codePoint <= intervalEnd; codePoint++) {
      const source = sources[coverage.codepointSources.get(codePoint) ?? 0]
      const rendered = source.face.renderGlyph(codePoint, loadFlags, darkenAa)
      if (rendered === null) {
        allGlyphs.push({
          width: 0, height: 0, advanceX: 0, left: 0, top: 0,
          dataLength: 0, dataOffset: totalBitmapSize, codePoint, bitmap: null,
        })
        continue
      }

      // The on-device EpdGlyph struct stores width/height as uint8, advance as
      // uint16 and data_length as uint16. Decorative or malformed fonts can
      // render past those limits; ship them blank instead of failing the build.
      const { width, rows, advanceX, bitmap } = rendered
      if (width > 0xff || rows > 0xff || bitmap.length > 0xffff
          || advanceX < 0 || advanceX > 0xffff) {
        log(`  [${styleLabel}] WARNING: glyph U+${codePoint.toString(16).toUpperCase().padStart(4, '0')} ` +
            `(${width}x${rows}, ${bitmap.length} bytes) exceeds cpfont format limits; emitting blank glyph`)
        allGlyphs.push({
          width: 0, height: 0, advanceX: Math.max(0, Math.min(advanceX, 0xffff)),
          left: 0, top: 0, dataLength: 0, dataOffset: totalBitmapSize, codePoint, bitmap: null,
        })
        continue
      }

      allGlyphs.push({
        width,
        height: rows,
        advanceX,
        left: rendered.left,
        top: rendered.top,
        dataLength: bitmap.length,
        dataOffset: totalBitmapSize,
        codePoint,
        bitmap,
      })
      totalBitmapSize += bitmap.length
    }
  }

  // Line metrics come from the primary font so they stay stable for the
  // selected family even when a fallback contributes glyphs.
  const { advanceY, ascender, descender } = primary.face.metrics()
  log(`  [${styleLabel}] Metrics: advanceY=${advanceY}, ascender=${ascender}, descender=${descender}`)
  log(`  [${styleLabel}] Bitmap: ${totalBitmapSize} bytes (${(totalBitmapSize / 1024).toFixed(1)} KB)`)

  // --- Kerning and ligatures ---
  const ppem = size * 150.0 / 72.0

  let kernMap = new Map()
  for (let i = 0; i < coverage.sourceCodepoints.length; i++) {
    const codepoints = coverage.sourceCodepoints[i]
    if (codepoints.size === 0) continue
    const source = sources[i]
    const cps = [...codepoints]
    const gids = source.face.charIndices(cps)
    const charIndices = new Map()
    for (let j = 0; j < cps.length; j++) {
      if (gids[j] > 0) charIndices.set(cps[j], gids[j])
    }
    const extracted = extractKerning(source.font, cps, ppem, charIndices, log)
    for (const [key, value] of extracted) kernMap.set(key, value)
  }

  // Codepoints above U+FFFF cannot be stored in the uint16 kern codepoint
  // field; drop them before class derivation.
  kernMap = new Map([...kernMap].filter(([key]) => {
    const [leftCp, rightCp] = key.split(',').map(Number)
    return leftCp <= 0xffff && rightCp <= 0xffff
  }))
  log(`  [${styleLabel}] Kerning: ${kernMap.size} pairs extracted`)

  const kernClasses = deriveKernClasses(kernMap, log)
  if (kernMap.size > 0) {
    const matrixSize = kernClasses.kernLeftClassCount * kernClasses.kernRightClassCount
    const entriesSize = (kernClasses.kernLeftClasses.length + kernClasses.kernRightClasses.length) * 3
    log(`  [${styleLabel}] Kerning classes: ${kernClasses.kernLeftClassCount} left, ` +
        `${kernClasses.kernRightClassCount} right, ${matrixSize + entriesSize} bytes`)
  }

  let ligaturePairs = []
  for (let i = 0; i < coverage.sourceCodepoints.length; i++) {
    const codepoints = coverage.sourceCodepoints[i]
    if (codepoints.size === 0) continue
    const source = sources[i]
    ligaturePairs.push(...extractLigatures(source.font, codepoints, source.charmap, log))
  }
  ligaturePairs.sort((a, b) => a[0] - b[0])
  if (ligaturePairs.length > 255) {
    log(`  [${styleLabel}] WARNING: ${ligaturePairs.length} ligature pairs exceeds uint8_t max (255), truncating`)
    ligaturePairs = ligaturePairs.slice(0, 255)
  }
  log(`  [${styleLabel}] Ligatures: ${ligaturePairs.length} pairs`)

  return {
    styleId,
    intervals: validatedIntervals,
    allGlyphs,
    totalBitmapSize,
    advanceY,
    ascender,
    descender,
    ...kernClasses,
    ligaturePairs,
  }
}

// --- Binary packing ---

// Packs one style's raster data into the on-disk sections, in file order.
function packStyleSections(styleData) {
  const intervalsData = new DataView(new ArrayBuffer(styleData.intervals.length * 12))
  let offset = 0
  styleData.intervals.forEach(([start, end], index) => {
    intervalsData.setUint32(index * 12, start, true)
    intervalsData.setUint32(index * 12 + 4, end, true)
    intervalsData.setUint32(index * 12 + 8, offset, true)
    offset += end - start + 1
  })

  const glyphsData = new DataView(new ArrayBuffer(styleData.allGlyphs.length * GLYPH_STRUCT_SIZE))
  styleData.allGlyphs.forEach((glyph, index) => {
    const base = index * GLYPH_STRUCT_SIZE
    glyphsData.setUint8(base, glyph.width)
    glyphsData.setUint8(base + 1, glyph.height)
    glyphsData.setUint16(base + 2, glyph.advanceX, true)
    glyphsData.setInt16(base + 4, glyph.left, true)
    glyphsData.setInt16(base + 6, glyph.top, true)
    glyphsData.setUint16(base + 8, glyph.dataLength, true)
    // bytes 10-11 are padding in the EpdGlyph struct
    glyphsData.setUint32(base + 12, glyph.dataOffset, true)
  })

  const packClassEntries = (entries) => {
    const view = new DataView(new ArrayBuffer(entries.length * 3))
    entries.forEach(([codePoint, classId], index) => {
      view.setUint16(index * 3, codePoint, true)
      view.setUint8(index * 3 + 2, classId)
    })
    return new Uint8Array(view.buffer)
  }

  const kernMatrixData = new Int8Array(styleData.kernMatrix)

  const ligatureData = new DataView(new ArrayBuffer(styleData.ligaturePairs.length * 8))
  styleData.ligaturePairs.forEach(([packedPair, ligCp], index) => {
    ligatureData.setUint32(index * 8, packedPair, true)
    ligatureData.setUint32(index * 8 + 4, ligCp, true)
  })

  const bitmapData = new Uint8Array(styleData.totalBitmapSize)
  let bitmapOffset = 0
  for (const glyph of styleData.allGlyphs) {
    if (!glyph.bitmap || glyph.bitmap.length === 0) continue
    bitmapData.set(glyph.bitmap, bitmapOffset)
    bitmapOffset += glyph.bitmap.length
  }
  if (bitmapOffset !== styleData.totalBitmapSize) {
    throw new FontBuildError('internal error: bitmap section size mismatch')
  }

  return [
    new Uint8Array(intervalsData.buffer),
    new Uint8Array(glyphsData.buffer),
    packClassEntries(styleData.kernLeftClasses),
    packClassEntries(styleData.kernRightClasses),
    new Uint8Array(kernMatrixData.buffer, kernMatrixData.byteOffset, kernMatrixData.byteLength),
    new Uint8Array(ligatureData.buffer),
    bitmapData,
  ]
}

function sectionsTotalSize(sections) {
  return sections.reduce((sum, section) => sum + section.byteLength, 0)
}

// Generates one multi-style v4 .cpfont for a single point size.
function generateCpfontMultistyle(styleFonts, size, intervals, options) {
  const { forceAutohint = false, fallbackStyleFonts = null, darkenAa = false, log } = options
  const flags = 1 // always 2-bit greyscale
  const styleIds = [...styleFonts.keys()].sort((a, b) => a - b)
  const styleCount = styleIds.length

  const rasterData = new Map()
  for (const styleId of styleIds) {
    const fallbacks = []
    if (fallbackStyleFonts) {
      if (styleId !== 0) fallbacks.push(...(fallbackStyleFonts.get(styleId) ?? []))
      fallbacks.push(...(fallbackStyleFonts.get(0) ?? []))
    }
    log(`  Rasterizing style ${styleId}...`)
    rasterData.set(styleId, rasterizeFontStyle(styleFonts.get(styleId), size, intervals, {
      styleId, forceAutohint, fallbacks, darkenAa, log,
    }))
  }

  const packedSections = new Map()
  for (const styleId of styleIds) {
    packedSections.set(styleId, packStyleSections(rasterData.get(styleId)))
  }

  const dataStart = HEADER_SIZE + styleCount * STYLE_TOC_ENTRY_SIZE
  let currentOffset = dataStart
  const styleOffsets = new Map()
  for (const styleId of styleIds) {
    styleOffsets.set(styleId, currentOffset)
    currentOffset += sectionsTotalSize(packedSections.get(styleId))
  }

  // V4 header: magic(8) + version(2) + flags(2) + styleCount(1) + reserved(19)
  const header = new DataView(new ArrayBuffer(HEADER_SIZE))
  MAGIC.forEach((byte, index) => header.setUint8(index, byte))
  header.setUint16(8, CPFONT_VERSION, true)
  header.setUint16(10, flags, true)
  header.setUint8(12, styleCount)

  // Style TOC entry: styleId(1) + pad(3) + intervalCount(4) + glyphCount(4) +
  //   advanceY(1) + ascender(2) + descender(2) + kernL(2) + kernR(2) +
  //   kernLCls(1) + kernRCls(1) + ligCount(1) + dataOffset(4) + reserved(4)
  const toc = new DataView(new ArrayBuffer(styleCount * STYLE_TOC_ENTRY_SIZE))
  styleIds.forEach((styleId, index) => {
    const sd = rasterData.get(styleId)
    if (sd.advanceY > 255) {
      throw new FontBuildError(
        `advanceY (${sd.advanceY}) exceeds uint8 range for style ${styleId} size ${size}. ` +
        'This likely means the font size is too large for this format.')
    }
    const base = index * STYLE_TOC_ENTRY_SIZE
    toc.setUint8(base, styleId)
    toc.setUint32(base + 4, sd.intervals.length, true)
    toc.setUint32(base + 8, sd.allGlyphs.length, true)
    toc.setUint8(base + 12, sd.advanceY)
    toc.setInt16(base + 13, sd.ascender, true)
    toc.setInt16(base + 15, sd.descender, true)
    toc.setUint16(base + 17, sd.kernLeftClasses.length, true)
    toc.setUint16(base + 19, sd.kernRightClasses.length, true)
    toc.setUint8(base + 21, sd.kernLeftClassCount)
    toc.setUint8(base + 22, sd.kernRightClassCount)
    toc.setUint8(base + 23, sd.ligaturePairs.length)
    toc.setUint32(base + 24, styleOffsets.get(styleId), true)
  })

  const totalSize = currentOffset
  const output = new Uint8Array(totalSize)
  output.set(new Uint8Array(header.buffer), 0)
  output.set(new Uint8Array(toc.buffer), HEADER_SIZE)
  let writeOffset = dataStart
  for (const styleId of styleIds) {
    for (const section of packedSections.get(styleId)) {
      output.set(section, writeOffset)
      writeOffset += section.byteLength
    }
  }

  log(`  Output: v4, ${styleCount} styles`)
  log(`    Header+TOC: ${HEADER_SIZE + toc.byteLength} bytes`)
  for (const styleId of styleIds) {
    const sd = rasterData.get(styleId)
    const styleSize = sectionsTotalSize(packedSections.get(styleId))
    log(`    ${STYLE_NAMES[styleId] ?? styleId}: ${sd.allGlyphs.length} glyphs, ` +
        `${sd.intervals.length} intervals, ${styleSize} bytes`)
  }
  log(`    Total: ${totalSize} bytes (${(totalSize / 1024 / 1024).toFixed(2)} MB)`)

  return output
}

/**
 * Builds every requested size of one font family.
 *
 * @param {object} request
 * @param {string} request.family         output filename stem
 * @param {number[]} request.sizes        point sizes
 * @param {Array<[number, number]>} request.intervals  resolved coverage
 * @param {Record<string, Uint8Array>} request.styles  style name -> font bytes
 * @param {Array<Record<string, Uint8Array>>} [request.fallbacks]  user fallback families
 * @param {Array<{name: string, bytes: Uint8Array}>} [request.defaultFallbacks]
 * @param {boolean} [request.forceAutohint]
 * @param {boolean} [request.darkenAa]
 * @param {(line: string) => void} [request.log]
 * @returns {Promise<Array<{name: string, data: Uint8Array}>>}
 */
export async function buildCpfonts(request) {
  const {
    family, sizes, intervals, styles, fallbacks = [], defaultFallbacks = [],
    forceAutohint = false, darkenAa = false, log = () => {},
  } = request

  if (!styles || !styles.regular) throw new FontBuildError('A regular style is required')
  if (!sizes || sizes.length === 0) throw new FontBuildError('At least one size is required')

  const mod = await loadFreeType()
  const opened = []
  const open = (bytes, label) => {
    const source = new FontSource(mod, bytes, label)
    opened.push(source)
    return source
  }

  try {
    const styleMap = new Map()
    const styleIds = { regular: 0, bold: 1, italic: 2, bolditalic: 3 }
    for (const [styleName, styleId] of Object.entries(styleIds)) {
      const bytes = styles[styleName]
      if (bytes) styleMap.set(styleId, open(bytes, `${family} ${styleName}`))
    }

    // Fallback chain for regular: user-provided families first, then the
    // bundled defaults — they only fill codepoints nothing earlier supplies.
    const fallbackStyleFonts = new Map()
    const regularFallbacks = []
    fallbacks.forEach((fallbackFamily, index) => {
      if (fallbackFamily?.regular) {
        regularFallbacks.push(open(fallbackFamily.regular, `fallback${index + 1} regular`))
      }
    })
    for (const fallback of defaultFallbacks) {
      regularFallbacks.push(open(fallback.bytes, fallback.name))
    }
    if (regularFallbacks.length) fallbackStyleFonts.set(0, regularFallbacks)

    for (const [styleName, styleId] of Object.entries(styleIds)) {
      if (styleId === 0) continue
      const styleFallbacks = fallbacks
        .map((fallbackFamily, index) => (fallbackFamily?.[styleName]
          ? open(fallbackFamily[styleName], `fallback${index + 1} ${styleName}`)
          : null))
        .filter(Boolean)
      if (styleFallbacks.length) fallbackStyleFonts.set(styleId, styleFallbacks)
    }

    const results = []
    for (const size of sizes) {
      const name = `${family}_${size}.cpfont`
      log(`Generating ${name} (size ${size}, ${styleMap.size} style(s), v4)...`)
      results.push({
        name,
        data: generateCpfontMultistyle(styleMap, size, intervals, {
          forceAutohint, fallbackStyleFonts, darkenAa, log,
        }),
      })
    }

    const totalBytes = results.reduce((sum, file) => sum + file.data.byteLength, 0)
    log(`\nTotal: ${results.length} files, ${(totalBytes / 1024 / 1024).toFixed(2)} MB`)
    return results
  } finally {
    for (const source of opened) source.free()
  }
}
