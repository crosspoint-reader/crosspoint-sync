// Thin wrapper over the FreeType wasm module built by
// scripts/font-builder/wasm/build.sh.
//
// Rasterization and 2-bit packing live in C (see cpfont_ft.c) so a CJK build
// crosses the JS/wasm boundary once per glyph instead of once per pixel.

import createFreeTypeModule from './wasm/freetype.mjs'

export const FT_LOAD_RENDER = 1 << 2
export const FT_LOAD_NO_BITMAP = 1 << 3
export const FT_LOAD_FORCE_AUTOHINT = 1 << 5

// Scratch space for one rendered glyph. A 2-bit bitmap needs width*rows/4
// bytes; 1 MiB covers anything the format can describe (glyph dimensions are
// capped at 255 downstream) without reallocating per glyph.
const BITMAP_SCRATCH_BYTES = 1 << 20
const INFO_SLOTS = 6

let modulePromise = null

// emscripten's malloc returns 0 when it cannot grow the heap, and address 0 in
// wasm is ordinary linear memory — an unchecked pointer would silently corrupt
// the heap instead of failing. A CJK family allocates tens of megabytes, so
// this is reachable on a memory-starved tab.
function alloc(mod, bytes) {
  const ptr = mod._malloc(bytes)
  if (!ptr) throw new Error('Out of memory while converting the font')
  return ptr
}

// The emscripten glue would resolve freetype.wasm relative to its own URL,
// which Vite rewrites and hashes, so the path is supplied here instead: a
// `?url` asset import in the browser (dev server and production chunk alike),
// and a filesystem read under node for the tests and the parity harness.
async function moduleOptions() {
  // process.getBuiltinModule instead of `import('node:fs')`: a bundler would
  // try to resolve the import specifier even on a branch the browser never
  // takes, and externalizing node builtins breaks the client build.
  const nodeFs = typeof process !== 'undefined' && process.getBuiltinModule
    ? process.getBuiltinModule('fs')
    : null
  if (nodeFs) {
    return { wasmBinary: nodeFs.readFileSync(new URL('./wasm/freetype.wasm', import.meta.url)) }
  }
  const { default: wasmUrl } = await import('./wasm-url.js')
  return { locateFile: (file) => (file.endsWith('.wasm') ? wasmUrl : file) }
}

export function loadFreeType() {
  if (!modulePromise) {
    modulePromise = moduleOptions()
      .then((options) => createFreeTypeModule(options))
      .then((mod) => {
        if (mod._cp_init() !== 0) throw new Error('FreeType failed to initialize')
        return mod
      })
      .catch((error) => {
        // Only successful loads are worth caching. Caching the rejection would
        // make a single dropped freetype.wasm fetch break every later build in
        // the tab, with no way back short of a reload.
        modulePromise = null
        throw error
      })
  }
  return modulePromise
}

export class FtFace {
  // `bytes` is copied into the wasm heap; FreeType reads from that copy for the
  // lifetime of the face, so the copy is only released by free().
  constructor(mod, bytes, label = 'font') {
    this.mod = mod
    this.label = label

    this.dataPtr = mod._malloc(bytes.byteLength)
    if (!this.dataPtr) throw new Error(`Out of memory loading ${label}`)
    mod.HEAPU8.set(bytes, this.dataPtr)

    this.id = mod._cp_face_new(this.dataPtr, bytes.byteLength)
    if (this.id < 0) {
      mod._free(this.dataPtr)
      this.dataPtr = 0
      throw new Error(
        `'${label}' could not be read as a TTF/OTF font file. ` +
        'Try re-exporting the font or uploading a different file.')
    }

    this.infoPtr = mod._malloc(INFO_SLOTS * 4)
    this.bitmapPtr = mod._malloc(BITMAP_SCRATCH_BYTES)
    if (!this.infoPtr || !this.bitmapPtr) {
      // cp_face_new() already owns the font data, and the caller only records
      // the source once the constructor returns — so release the face here or
      // the slot (one of 32) and its megabytes stay held for the session.
      this.free()
      throw new Error('Out of memory while converting the font')
    }
  }

  setSize(pointSize) {
    if (this.mod._cp_face_set_size(this.id, pointSize) !== 0) {
      throw new Error(`'${this.label}' rejected size ${pointSize}pt`)
    }
  }

  // 1 byte per codepoint in [start, end]; 1 where the face has a glyph.
  coverageRange(start, end) {
    const count = end - start + 1
    const ptr = alloc(this.mod, count)
    try {
      if (this.mod._cp_coverage_range(this.id, start, end, ptr) !== 0) {
        throw new Error('coverage lookup failed')
      }
      return this.mod.HEAPU8.slice(ptr, ptr + count)
    } finally {
      this.mod._free(ptr)
    }
  }

  // Codepoints -> glyph indices, in one call.
  charIndices(codepoints) {
    const count = codepoints.length
    let inPtr = 0
    let outPtr = 0
    try {
      inPtr = alloc(this.mod, count * 4)
      outPtr = alloc(this.mod, count * 4)
      this.mod.HEAPU32.set(Uint32Array.from(codepoints), inPtr >> 2)
      if (this.mod._cp_char_indices(this.id, inPtr, count, outPtr) !== 0) {
        throw new Error('cmap lookup failed')
      }
      return this.mod.HEAP32.slice(outPtr >> 2, (outPtr >> 2) + count)
    } finally {
      if (inPtr) this.mod._free(inPtr)
      if (outPtr) this.mod._free(outPtr)
    }
  }

  // The whole active charmap as a Map of codepoint -> glyph index, ascending.
  charmap() {
    let cap = 1 << 16
    for (;;) {
      const ptr = alloc(this.mod, cap * 8)
      try {
        const count = this.mod._cp_charmap_dump(this.id, ptr, cap)
        if (count < 0) {
          cap = -count + 16
          continue
        }
        const pairs = this.mod.HEAPU32.subarray(ptr >> 2, (ptr >> 2) + count * 2)
        const map = new Map()
        for (let i = 0; i < count; i++) map.set(pairs[i * 2], pairs[i * 2 + 1])
        return map
      } finally {
        this.mod._free(ptr)
      }
    }
  }

  // Returns null when the face has no glyph for `codepoint`, otherwise the
  // glyph metrics plus its packed 2-bit bitmap.
  renderGlyph(codepoint, loadFlags, darkenAa) {
    const status = this.mod._cp_render_glyph(
      this.id, codepoint, loadFlags, darkenAa ? 1 : 0,
      this.infoPtr, this.bitmapPtr, BITMAP_SCRATCH_BYTES)
    if (status === 1) return null
    if (status !== 0) {
      throw new Error(`'${this.label}' failed to render U+${codepoint.toString(16).toUpperCase()}`)
    }

    const info = this.mod.HEAP32.subarray(this.infoPtr >> 2, (this.infoPtr >> 2) + INFO_SLOTS)
    const dataLength = info[5]
    return {
      width: info[0],
      rows: info[1],
      left: info[2],
      top: info[3],
      advanceX: info[4],
      bitmap: this.mod.HEAPU8.slice(this.bitmapPtr, this.bitmapPtr + dataLength),
    }
  }

  // Scaled face metrics: advanceY, ascender, descender.
  metrics() {
    if (this.mod._cp_face_metrics(this.id, this.infoPtr) !== 0) {
      throw new Error('face metrics unavailable')
    }
    const info = this.mod.HEAP32.subarray(this.infoPtr >> 2, (this.infoPtr >> 2) + 3)
    return { advanceY: info[0], ascender: info[1], descender: info[2] }
  }

  free() {
    if (this.id >= 0) {
      // cp_face_free() releases the font-data copy too.
      this.mod._cp_face_free(this.id)
      this.id = -1
      this.dataPtr = 0
    }
    if (this.infoPtr) { this.mod._free(this.infoPtr); this.infoPtr = 0 }
    if (this.bitmapPtr) { this.mod._free(this.bitmapPtr); this.bitmapPtr = 0 }
  }
}
