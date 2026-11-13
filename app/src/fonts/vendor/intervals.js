// Unicode interval presets, ported 1:1 from
// scripts/font-builder/fontconvert_sdcard.py (resolve_intervals / parse_hex_range).
// The Python script stays the reference implementation; keep both in step.

export const CPFONT_VERSION = 4

const BASE_INTERVALS = [[0x0000, 0x007f], [0x2000, 0x206f]]

const DEFAULT_INTERVALS = [
  [0x0080, 0x00ff], [0x0100, 0x017f],
  [0x01a0, 0x01a1], [0x01af, 0x01b0], [0x01c4, 0x021f],
  [0x0300, 0x036f], [0x0400, 0x04ff], [0x1ea0, 0x1ef9],
  [0x20a0, 0x20cf], [0x2070, 0x209f], [0x2190, 0x21ff],
  [0x2200, 0x22ff], [0xfb00, 0xfb06],
]

export const INTERVAL_PRESETS = {
  // Minimum readable coverage. This is included in every generated .cpfont.
  base: BASE_INTERVALS,
  // Broad CrossPoint-style reading coverage. Users can add this on top of base.
  default: DEFAULT_INTERVALS,
  'latin-ext': [[0x0020, 0x007e], [0x0080, 0x00ff], [0x0100, 0x024f],
    [0x1e00, 0x1eff], [0x2000, 0x206f], [0xfb00, 0xfb06]],
  greek: [[0x0370, 0x03ff], [0x1f00, 0x1fff]],
  cyrillic: [[0x0400, 0x04ff], [0x0500, 0x052f]],
  hebrew: [[0x0590, 0x05ff], [0xfb1d, 0xfb4f]],
  arabic: [[0x0600, 0x06ff], [0x0750, 0x077f], [0x08a0, 0x08ff], [0xfb50, 0xfdf9], [0xfe70, 0xfeff]],
  georgian: [[0x10a0, 0x10ff], [0x2d00, 0x2d2f]],
  armenian: [[0x0530, 0x058f]],
  ethiopic: [[0x1200, 0x137f], [0x1380, 0x139f], [0x2d80, 0x2ddf]],
  vietnamese: [[0x01a0, 0x01b0], [0x1ea0, 0x1ef9]],
  'cjk-sc': [[0x3000, 0x303f], [0x4e00, 0x9fff],
    [0xf900, 0xfaff], [0xff00, 0xffef]],
  // Traditional Chinese: cjk-sc plus Bopomofo (zhuyin) and CJK Extension A,
  // which TC texts draw on noticeably more than SC.
  'cjk-tc': [[0x3000, 0x303f], [0x3100, 0x312f], [0x31a0, 0x31bf],
    [0x3400, 0x4dbf], [0x4e00, 0x9fff],
    [0xf900, 0xfaff], [0xff00, 0xffef]],
  'cjk-jp': [[0x3000, 0x303f], [0x3040, 0x309f], [0x30a0, 0x30ff],
    [0x4e00, 0x9fff], [0xf900, 0xfaff], [0xff00, 0xffef]],
  hangul: [[0xac00, 0xd7af], [0x1100, 0x11ff], [0x3130, 0x318f]],
  cherokee: [[0x13a0, 0x13ff], [0xab70, 0xabbf]],
  tifinagh: [[0x2d30, 0x2d7f]],
  thai: [[0x0e00, 0x0e7f]],
  // Bengali block plus the shared Devanagari danda/double-danda punctuation.
  bengali: [[0x0964, 0x0965], [0x0980, 0x09ff]],
  // Symbol blocks commonly seen in scifi/popsci/literary fiction.
  symbols: [[0x2070, 0x209f], [0x20a0, 0x20cf], [0x2150, 0x218f],
    [0x2190, 0x21ff], [0x2200, 0x22ff], [0x2500, 0x257f],
    [0x25a0, 0x25ff], [0x2600, 0x26ff], [0x2700, 0x27bf]],
  // Composite preset for English-language literary fiction including scifi/popsci.
  // Includes default coverage so selecting reading preserves the old behavior.
  reading: DEFAULT_INTERVALS.concat([
    [0x0180, 0x019f], [0x01a2, 0x01ae], [0x01b1, 0x01c3],
    [0x0220, 0x024f], [0x0370, 0x03ff], [0x1e00, 0x1e9f],
    [0x1efa, 0x1eff], [0x2150, 0x218f], [0x2500, 0x257f],
    [0x25a0, 0x25ff], [0x2600, 0x26ff], [0x2700, 0x27bf],
    [0x2900, 0x29ff], [0x2e00, 0x2e7f], [0x3000, 0x303f]]),
  // IPA characters
  'ipa-chars': [[0x0250, 0x02af], [0x02b0, 0x02ff]],
}

// Every generated .cpfont gets this minimum first; user-selected presets and
// custom ranges are additive.
const BASE_INTERVAL_PRESETS = ['base']

export class FontBuildError extends Error {}

// Canonical form is (0xSTART-0xEND), but users type these by hand on the
// website, so bare ranges and single codepoints are accepted too.
const HEX_RANGE_PATTERN = /^\(?\s*0x([0-9a-fA-F]+)\s*(?:-\s*0x([0-9a-fA-F]+)\s*)?\)?$/

export function parseHexRange(token) {
  const match = HEX_RANGE_PATTERN.exec(token)
  if (!match) return null

  const start = parseInt(match[1], 16)
  const end = match[2] !== undefined ? parseInt(match[2], 16) : start

  if (start > end || end > 0x10ffff) return null
  return [start, end]
}

// Resolves comma-separated preset names into a merged, sorted, deduplicated
// interval list. Base coverage is always prepended.
export function resolveIntervals(presetStr) {
  const parsedTokens = BASE_INTERVAL_PRESETS.map((name) => [name, null])

  const tokens = String(presetStr || '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0)

  for (const name of tokens) {
    const unnamedInterval = parseHexRange(name)
    if (!(name in INTERVAL_PRESETS) && unnamedInterval === null) {
      throw new FontBuildError(
        `Unknown Unicode coverage entry '${name}'. Use a preset name or a hex ` +
        'range like (0x2100-0x214F); single codepoints like 0x2122 also work.')
    }
    parsedTokens.push([name, unnamedInterval])
  }

  const allIntervals = []
  for (const [name, unnamedInterval] of parsedTokens) {
    if (unnamedInterval !== null) allIntervals.push(unnamedInterval)
    else allIntervals.push(...INTERVAL_PRESETS[name])
  }

  // Always add replacement character
  allIntervals.push([0xfffd, 0xfffd])

  // Sort and merge overlapping/adjacent intervals
  allIntervals.sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const merged = []
  for (const [start, end] of allIntervals) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1] + 1) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}
