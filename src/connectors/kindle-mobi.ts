/**
 * Minimal PalmDB / PalmDOC reader — just enough to measure the decompressed text
 * length of the MOBI7 file Amazon serves for a PDOC/EBOK. That length is the
 * "ruler" that converts a Whispersync byte-offset position (`last_read.pos`) into
 * a 0–1 reading fraction. See docs/design/kindle-sync.md.
 *
 * We deliberately do not parse the MOBI/KF8 layers: v1 only supports the MOBI7
 * position space (Kindle app / Android-identity deliveries).
 */

export class MobiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MobiError';
  }
}

const PALMDB_HEADER_LEN = 78;
const COMPRESSION_NONE = 1;
const COMPRESSION_PALMDOC = 2;
const COMPRESSION_HUFF_CDIC = 17480;

/**
 * Decompress one PalmDOC LZ77 record.
 * Token layout (after the initial byte c):
 *  - c >= 0xC0: emit a space, then the literal (c ^ 0x80)
 *  - c >= 0x80: read a second byte; copy ((next & 7) + 3) bytes from
 *    ((((c & 0x3F) << 8) | next) >> 3) bytes back (overlapping copies allowed)
 *  - c in 0x09..0x7F or c == 0x00: literal byte
 *  - c in 0x01..0x08: copy the next c bytes literally
 */
export function decompressPalmDocRecord(data: Buffer): Buffer {
  const out: number[] = [];
  let i = 0;
  while (i < data.length) {
    const c = data[i++];
    if (c >= 0xc0) {
      out.push(0x20, c ^ 0x80);
    } else if (c >= 0x80) {
      if (i >= data.length) throw new MobiError('truncated LZ77 back-reference');
      const next = data[i++];
      const distance = (((c & 0x3f) << 8) | next) >> 3;
      const length = (next & 0x07) + 3;
      if (distance <= 0 || distance > out.length) {
        throw new MobiError('LZ77 back-reference out of range');
      }
      for (let k = 0; k < length; k++) out.push(out[out.length - distance]);
    } else if (c >= 0x09 || c === 0x00) {
      out.push(c);
    } else {
      if (i + c > data.length) throw new MobiError('truncated LZ77 literal run');
      for (let k = 0; k < c; k++) out.push(data[i++]);
    }
  }
  return Buffer.from(out);
}

interface PalmDocInfo {
  compression: number;
  textLength: number;
  recordCount: number;
  recordOffsets: number[];
}

function readPalmDocHeader(buf: Buffer): PalmDocInfo {
  if (buf.length < PALMDB_HEADER_LEN + 8) throw new MobiError('file too small for a PalmDB header');
  const numRecords = buf.readUInt16BE(76);
  if (numRecords < 2) throw new MobiError('PalmDB has no text records');
  const tableEnd = PALMDB_HEADER_LEN + numRecords * 8;
  if (buf.length < tableEnd) throw new MobiError('truncated PalmDB record table');
  const recordOffsets: number[] = [];
  for (let r = 0; r < numRecords; r++) {
    recordOffsets.push(buf.readUInt32BE(PALMDB_HEADER_LEN + r * 8));
  }
  const first = recordOffsets[0];
  if (first + 12 > buf.length) throw new MobiError('truncated PalmDOC header');
  return {
    compression: buf.readUInt16BE(first),
    textLength: buf.readUInt32BE(first + 4),
    recordCount: buf.readUInt16BE(first + 8),
    recordOffsets,
  };
}

/**
 * Total decompressed length (bytes) of the book's text records — the position
 * space Whispersync `pos` offsets index into.
 *
 * DRM'd store purchases and HUFF/CDIC files can't be decompressed here, but
 * they don't need to be: the PalmDOC header's DECLARED text length is that same
 * decompressed-text position space (live-verified 2026-09-23 against a
 * DRM'd store purchase: pos 9880 of 45 055 = a sane 21.9%). Only files we can
 * actually decompress get the cross-check.
 */
export function palmDocTextLength(buf: Buffer): number {
  const info = readPalmDocHeader(buf);
  if (info.compression === COMPRESSION_NONE) return info.textLength;
  if (info.textLength <= 0) throw new MobiError('header declares no text length');
  if (info.compression === COMPRESSION_HUFF_CDIC) return info.textLength;
  if (info.compression !== COMPRESSION_PALMDOC) {
    throw new MobiError(`unsupported compression type ${info.compression}`);
  }
  const encryption = buf.readUInt16BE(info.recordOffsets[0] + 12);
  if (encryption !== 0) return info.textLength; // DRM'd: trust the declared length

  let total = 0;
  const textRecords = Math.min(info.recordCount, info.recordOffsets.length - 1);
  for (let r = 1; r <= textRecords; r++) {
    const start = info.recordOffsets[r];
    const end = r + 1 < info.recordOffsets.length ? info.recordOffsets[r + 1] : buf.length;
    if (start >= buf.length || end > buf.length || end <= start) continue;
    total += decompressPalmDocRecord(buf.subarray(start, end)).length;
  }
  // Cross-check against the header's declared text length; a large divergence
  // means the file is not what we think it is.
  if (Math.abs(total - info.textLength) > Math.max(4096, info.textLength * 0.01)) {
    throw new MobiError(`decompressed length ${total} diverges from header ${info.textLength}`);
  }
  return total;
}
