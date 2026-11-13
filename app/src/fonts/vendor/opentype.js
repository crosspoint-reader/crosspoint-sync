// Kerning and ligature extraction, ported from the fontTools paths in
// scripts/font-builder/fontconvert_sdcard.py. fontkit replaces fontTools as the
// table decoder; everything else follows the Python logic step for step so both
// generators emit the same bytes.
//
// One deliberate difference: fontTools keys kerning by glyph *name*, while
// fontkit decodes to glyph *ids*. Ids are what FreeType hands us from the same
// cmap it rasterizes from, so the mapping stays consistent end to end.

import * as fontkit from 'fontkit'

// Standard Unicode ligature codepoints for known input sequences. Used when the
// GSUB substitute glyph has no cmap entry.
const STANDARD_LIGATURE_MAP = new Map([
  ['102,102', 0xfb00],      // ff
  ['102,105', 0xfb01],      // fi
  ['102,108', 0xfb02],      // fl
  ['102,102,105', 0xfb03],  // ffi
  ['102,102,108', 0xfb04],  // ffl
  ['383,116', 0xfb05],      // long-s + t
  ['115,116', 0xfb06],      // st
])

export function openFont(bytes, label = 'font') {
  try {
    // fontkit wants a Buffer/Uint8Array; `create` avoids its fs entry points.
    return fontkit.create(bytes)
  } catch (error) {
    throw new Error(
      `The font file '${label}' appears to be corrupt or malformed and could ` +
      `not be processed (${error.message}). Try re-exporting the font or ` +
      'uploading a different file.')
  }
}

// Python's round() is round-half-to-even; JS Math.round is half-up. Kerning
// values land exactly on .5 often enough that the difference shows up in
// output bytes.
function pyRound(value) {
  const floor = Math.floor(value)
  const diff = value - floor
  if (diff > 0.5) return floor + 1
  if (diff < 0.5) return floor
  return floor % 2 === 0 ? floor : floor + 1
}

// Design units -> 4.4 signed fixed-point, clamped to int8_t.
function fp4FromDesignUnits(designUnits, scale) {
  const raw = pyRound(designUnits * scale * 16)
  return Math.max(-128, Math.min(127, raw))
}

function lazyGet(array, index) {
  return array.get ? array.get(index) : array[index]
}

// fontTools normalizes both coverage formats to an ordered glyph list; fontkit
// exposes the raw table, so expand format 2 ranges by coverage index.
function coverageGlyphs(coverage) {
  if (!coverage) return []
  if (coverage.version === 1) return Array.from(coverage.glyphs)

  const records = Array.from(coverage.rangeRecords ?? [])
  records.sort((a, b) => a.startCoverageIndex - b.startCoverageIndex)
  const glyphs = []
  for (const record of records) {
    for (let glyph = record.start; glyph <= record.end; glyph++) glyphs.push(glyph)
  }
  return glyphs
}

// fontTools exposes ClassDef as a {glyph: class} dict with 0 as the default.
function classOfGlyph(classDef, glyph) {
  if (!classDef) return 0
  if (classDef.version === 1) {
    const index = glyph - classDef.startGlyph
    const values = classDef.classValueArray
    if (index < 0 || index >= values.length) return 0
    return lazyGet(values, index) ?? 0
  }
  const records = classDef.classRangeRecord ?? []
  for (let i = 0; i < records.length; i++) {
    const record = lazyGet(records, i)
    if (glyph >= record.start && glyph <= record.end) return record.class
  }
  return 0
}

function xAdvanceOf(record) {
  if (!record || !record.value1) return 0
  return record.value1.xAdvance || 0
}

function addKern(rawKern, left, right, value) {
  const key = `${left},${right}`
  rawKern.set(key, (rawKern.get(key) || 0) + value)
}

// Extracts kerning from a PairPos subtable (Format 1 or 2).
function extractPairPosSubtable(subtable, glyphToCps, rawKern, log) {
  if (subtable.version === 1) {
    // Individual pairs
    const glyphs = coverageGlyphs(subtable.coverage)
    for (let i = 0; i < glyphs.length; i++) {
      const coverageGlyph = glyphs[i]
      if (!glyphToCps.has(coverageGlyph)) continue
      const pairSet = lazyGet(subtable.pairSets, i)
      if (!pairSet) continue
      for (let j = 0; j < pairSet.length; j++) {
        const pvr = lazyGet(pairSet, j)
        if (!glyphToCps.has(pvr.secondGlyph)) continue
        const xa = xAdvanceOf(pvr)
        if (xa !== 0) addKern(rawKern, coverageGlyph, pvr.secondGlyph, xa)
      }
    }
    return
  }

  if (subtable.version !== 2) return

  // Class-based pairs — iterate by class, not by glyph, to avoid an
  // O(glyphs^2) explosion for CJK fonts with many requested glyphs.
  const coverageSet = new Set(coverageGlyphs(subtable.coverage))

  const leftByClass = new Map()   // only glyphs in coverage AND glyphToCps
  const rightByClass = new Map()  // all glyphs in glyphToCps
  for (const glyph of glyphToCps.keys()) {
    if (coverageSet.has(glyph)) {
      const c1 = classOfGlyph(subtable.classDef1, glyph)
      if (!leftByClass.has(c1)) leftByClass.set(c1, [])
      leftByClass.get(c1).push(glyph)
    }
    const c2 = classOfGlyph(subtable.classDef2, glyph)
    if (!rightByClass.has(c2)) rightByClass.set(c2, [])
    rightByClass.get(c2).push(glyph)
  }

  for (let c1 = 0; c1 < subtable.class1Count; c1++) {
    const lefts = leftByClass.get(c1)
    if (!lefts) continue
    const row = lazyGet(subtable.classRecords, c1)
    if (!row) continue
    for (let c2 = 0; c2 < subtable.class2Count; c2++) {
      const xa = xAdvanceOf(lazyGet(row, c2))
      if (xa === 0) continue
      const rights = rightByClass.get(c2)
      if (!rights) continue
      for (const left of lefts) {
        for (const right of rights) addKern(rawKern, left, right, xa)
      }
    }
  }
  if (log && coverageSet.size === 0) log('  Debug: PairPos format 2 subtable has empty coverage')
}

function featureLookupIndexes(table, tags) {
  const indexes = new Set()
  if (!table || !table.featureList) return indexes
  for (const record of table.featureList) {
    if (tags.includes(record.tag)) {
      for (const index of record.feature.lookupListIndexes) indexes.add(index)
    }
  }
  return indexes
}

// Unwraps Extension subtables (GPOS lookup type 9 / GSUB lookup type 7). After
// unwrapping, the outer lookupType is still the extension type, so the
// effective type has to come from the extension subtable itself — modern fonts
// ship kerning this way and checking only the outer type misses all of it.
function unwrapSubtable(lookup, subtable, extensionType) {
  if (lookup.lookupType === extensionType && subtable.extension) {
    return { actual: subtable.extension, effectiveType: subtable.lookupType }
  }
  return { actual: subtable, effectiveType: lookup.lookupType }
}

// Returns a Map of "leftCp,rightCp" -> 4.4 fixed-point adjustment for the given
// codepoints. `charIndices` maps a codepoint to its glyph id (FreeType's cmap).
export function extractKerning(font, codepoints, ppem, charIndices, log) {
  const unitsPerEm = font.unitsPerEm

  // glyph id -> [codepoints]; preserves aliases where several codepoints share
  // one glyph (e.g. space/nbsp), which both get kern pairs below.
  const glyphToCps = new Map()
  for (const cp of codepoints) {
    const glyph = charIndices.get(cp)
    if (!glyph) continue
    if (!glyphToCps.has(glyph)) glyphToCps.set(glyph, [])
    glyphToCps.get(glyph).push(cp)
  }

  const rawKern = new Map() // "leftGlyph,rightGlyph" -> design units

  // 1. Legacy kern table. fontTools only decodes format 0 subtables (others
  //    carry no kernTable attribute), so only format 0 is read here too.
  if (font.kern) {
    for (const table of font.kern.tables ?? []) {
      // fontkit keys the subtable's VersionedStruct on the parent's `format`
      // field, so the format lives on the table and only `pairs` on the
      // subtable. Reading format off the subtable silently drops every legacy
      // kern pair, which halves kerning for fonts that ship both tables.
      if (table.format !== 0 || !table.subtable) continue
      for (const pair of table.subtable.pairs ?? []) {
        if (!glyphToCps.has(pair.left) || !glyphToCps.has(pair.right)) continue
        addKern(rawKern, pair.left, pair.right, pair.value)
      }
    }
  }

  // 2. GPOS 'kern' feature
  if (font.GPOS) {
    for (const lookupIndex of featureLookupIndexes(font.GPOS, ['kern'])) {
      const lookup = lazyGet(font.GPOS.lookupList, lookupIndex)
      if (!lookup) continue
      for (const subtable of lookup.subTables) {
        const { actual, effectiveType } = unwrapSubtable(lookup, subtable, 9)
        if (actual.version === undefined) continue
        // Other lookup types reachable through the kern feature (cursive
        // attachment, mark-to-mark, contextual, ...) have a different shape;
        // skip them with a note rather than aborting the build.
        if (effectiveType === 2) {
          extractPairPosSubtable(actual, glyphToCps, rawKern, log)
        } else if (log) {
          log(`  Debug: skipping unsupported GPOS kern lookupType=${effectiveType} ` +
              `(outer=${lookup.lookupType}, Format=${actual.version})`)
        }
      }
    }
  }

  // Scale design units to 4.4 fixed-point pixels and expand glyph aliases.
  const scale = ppem / unitsPerEm
  const result = new Map()
  for (const [key, designUnits] of rawKern) {
    const adjust = fp4FromDesignUnits(designUnits, scale)
    if (adjust === 0) continue
    const [leftGlyph, rightGlyph] = key.split(',').map(Number)
    for (const leftCp of glyphToCps.get(leftGlyph)) {
      for (const rightCp of glyphToCps.get(rightGlyph)) {
        result.set(`${leftCp},${rightCp}`, adjust)
      }
    }
  }
  return result
}

// Derives class-based kerning from a pair map. Returns the left/right class
// entry lists, the flat int8 matrix, and both class counts.
export function deriveKernClasses(kernMap, log) {
  const empty = {
    kernLeftClasses: [], kernRightClasses: [], kernMatrix: [],
    kernLeftClassCount: 0, kernRightClassCount: 0,
  }
  if (kernMap.size === 0) return empty

  const allLeftCps = new Set()
  const allRightCps = new Set()
  const pairs = []
  for (const [key, adjust] of kernMap) {
    const [leftCp, rightCp] = key.split(',').map(Number)
    allLeftCps.add(leftCp)
    allRightCps.add(rightCp)
    pairs.push([leftCp, rightCp, adjust])
  }

  const sortedLeftCps = [...allLeftCps].sort((a, b) => a - b)
  const sortedRightCps = [...allRightCps].sort((a, b) => a - b)

  // Group left codepoints by identical adjustment row
  const leftProfileToClass = new Map()
  const leftClassMap = new Map()
  let leftClassId = 1
  for (const leftCp of sortedLeftCps) {
    const row = sortedRightCps.map((rightCp) => kernMap.get(`${leftCp},${rightCp}`) || 0).join(',')
    if (!leftProfileToClass.has(row)) leftProfileToClass.set(row, leftClassId++)
    leftClassMap.set(leftCp, leftProfileToClass.get(row))
  }

  // Group right codepoints by identical adjustment column
  const rightProfileToClass = new Map()
  const rightClassMap = new Map()
  let rightClassId = 1
  for (const rightCp of sortedRightCps) {
    const column = sortedLeftCps.map((leftCp) => kernMap.get(`${leftCp},${rightCp}`) || 0).join(',')
    if (!rightProfileToClass.has(column)) rightProfileToClass.set(column, rightClassId++)
    rightClassMap.set(rightCp, rightProfileToClass.get(column))
  }

  const kernLeftClassCount = leftClassId - 1
  const kernRightClassCount = rightClassId - 1

  if (kernLeftClassCount > 255 || kernRightClassCount > 255) {
    if (log) {
      log(`WARNING: kerning class count exceeds uint8_t range ` +
          `(left=${kernLeftClassCount}, right=${kernRightClassCount}), ` +
          'dropping kerning for this style')
    }
    return empty
  }

  const kernMatrix = new Array(kernLeftClassCount * kernRightClassCount).fill(0)
  for (const [leftCp, rightCp, adjust] of pairs) {
    const lc = leftClassMap.get(leftCp) - 1
    const rc = rightClassMap.get(rightCp) - 1
    kernMatrix[lc * kernRightClassCount + rc] = adjust
  }

  return {
    kernLeftClasses: [...leftClassMap.entries()].sort((a, b) => a[0] - b[0]),
    kernRightClasses: [...rightClassMap.entries()].sort((a, b) => a[0] - b[0]),
    kernMatrix,
    kernLeftClassCount,
    kernRightClassCount,
  }
}

// Returns [packedPair, ligatureCodepoint] entries for the given codepoints.
// Multi-character ligatures are decomposed into chained pairs.
export function extractLigatures(font, codepoints, charmap, log) {
  // glyph id -> codepoint over the *whole* cmap, so a ligature's output glyph
  // resolves even when its codepoint was not requested. Ascending codepoint
  // order means the highest codepoint wins an alias, matching fontTools.
  const glyphToCp = new Map()
  for (const [cp, glyph] of charmap) glyphToCp.set(glyph, cp)

  const rawLigatures = new Map() // "cp,cp,..." -> ligature codepoint

  if (font.GSUB) {
    for (const lookupIndex of featureLookupIndexes(font.GSUB, ['liga', 'rlig'])) {
      const lookup = lazyGet(font.GSUB.lookupList, lookupIndex)
      if (!lookup) continue
      for (const subtable of lookup.subTables) {
        const { actual } = unwrapSubtable(lookup, subtable, 7)
        // LigatureSubst (lookup type 4) is the only shape with ligature sets.
        if (!actual.ligatureSets) continue

        const glyphs = coverageGlyphs(actual.coverage)
        for (let i = 0; i < glyphs.length; i++) {
          const firstGlyph = glyphs[i]
          if (!glyphToCp.has(firstGlyph)) continue
          const firstCp = glyphToCp.get(firstGlyph)
          const ligatureSet = lazyGet(actual.ligatureSets, i)
          if (!ligatureSet) continue

          for (let j = 0; j < ligatureSet.length; j++) {
            const ligature = lazyGet(ligatureSet, j)
            const sequence = [firstCp]
            let valid = true
            for (const component of ligature.components) {
              if (!glyphToCp.has(component)) { valid = false; break }
              sequence.push(glyphToCp.get(component))
            }
            if (!valid) continue

            const seqKey = sequence.join(',')
            let ligCp
            if (glyphToCp.has(ligature.glyph)) {
              ligCp = glyphToCp.get(ligature.glyph)
            } else if (STANDARD_LIGATURE_MAP.has(seqKey)) {
              ligCp = STANDARD_LIGATURE_MAP.get(seqKey)
            } else {
              if (log) {
                const seqStr = sequence.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`).join(', ')
                log(`ligatures: WARNING: dropping ligature (${seqStr}) -> glyph ` +
                    `'${ligature.glyph}': output glyph has no cmap entry and input ` +
                    'sequence is not in STANDARD_LIGATURE_MAP')
              }
              continue
            }
            rawLigatures.set(seqKey, ligCp)
          }
        }
      }
    }
  }

  // Keep only ligatures whose inputs and output are all in the generated glyph
  // set and fit in 16 bits — the on-disk format packs each component as uint16.
  const codepointsSet = codepoints instanceof Set ? codepoints : new Set(codepoints)
  const filtered = new Map()
  for (const [seqKey, ligCp] of rawLigatures) {
    if (!codepointsSet.has(ligCp) || ligCp > 0xffff) continue
    const sequence = seqKey.split(',').map(Number)
    if (sequence.some((cp) => cp > 0xffff)) continue
    if (sequence.every((cp) => codepointsSet.has(cp))) filtered.set(seqKey, ligCp)
  }

  const pairs = []
  // First pass: 2-codepoint ligatures
  for (const [seqKey, ligCp] of filtered) {
    const sequence = seqKey.split(',').map(Number)
    if (sequence.length !== 2) continue
    pairs.push([(sequence[0] * 0x10000) + sequence[1], ligCp])
  }

  // Second pass: decompose 3+ codepoint ligatures into chained pairs
  for (const [seqKey, ligCp] of filtered) {
    const sequence = seqKey.split(',').map(Number)
    if (sequence.length < 3) continue
    const prefixKey = sequence.slice(0, -1).join(',')
    const lastCp = sequence[sequence.length - 1]
    if (filtered.has(prefixKey)) {
      pairs.push([(filtered.get(prefixKey) * 0x10000) + lastCp, ligCp])
    } else if (log) {
      const seqStr = sequence.map((cp) => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`).join(', ')
      log(`ligatures: skipping ${sequence.length}-char ligature (${seqStr}) -> ` +
          `U+${ligCp.toString(16).toUpperCase().padStart(4, '0')}: no intermediate ligature for prefix`)
    }
  }

  // Sorted by packed pair key — on-device lookup uses binary search.
  pairs.sort((a, b) => a[0] - b[0])
  return pairs
}
