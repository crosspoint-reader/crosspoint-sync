import { describe, expect, it } from 'vitest';
import { decompressPalmDocRecord, MobiError, palmDocTextLength } from '../src/connectors/kindle-mobi.js';

/** Build a synthetic PalmDB file with a PalmDOC header and the given text records. */
function makeMobi(opts: {
  compression: number;
  textRecords: Buffer[];
  declaredTextLength?: number;
  encryption?: number;
}): Buffer {
  const recordCount = opts.textRecords.length + 1; // +1 for the PalmDOC header record
  const headerLen = 78;
  const tableLen = recordCount * 8;
  const firstOffset = headerLen + tableLen;

  const palmDocHeader = Buffer.alloc(16);
  palmDocHeader.writeUInt16BE(opts.compression, 0);
  palmDocHeader.writeUInt32BE(
    opts.declaredTextLength ?? opts.textRecords.reduce((n, r) => n + r.length, 0),
    4
  );
  palmDocHeader.writeUInt16BE(opts.textRecords.length, 8);
  palmDocHeader.writeUInt16BE(4096, 10);
  palmDocHeader.writeUInt16BE(opts.encryption ?? 0, 12);

  const records = [palmDocHeader, ...opts.textRecords];
  const offsets: number[] = [];
  let cursor = firstOffset;
  for (const r of records) {
    offsets.push(cursor);
    cursor += r.length;
  }

  const out = Buffer.alloc(cursor);
  out.writeUInt16BE(recordCount, 76);
  offsets.forEach((off, i) => out.writeUInt32BE(off, headerLen + i * 8));
  records.forEach((r, i) => r.copy(out, offsets[i]));
  return out;
}

describe('decompressPalmDocRecord', () => {
  it('passes through literal bytes (0x00 and 0x09..0x7F)', () => {
    expect(decompressPalmDocRecord(Buffer.from([0x00, 0x41, 0x42]))).toEqual(Buffer.from([0x00, 0x41, 0x42]));
  });

  it('expands a literal run (0x01..0x08: copy next c bytes)', () => {
    expect(decompressPalmDocRecord(Buffer.from([0x03, 0x61, 0x62, 0x63]))).toEqual(Buffer.from('abc'));
  });

  it('expands space+char tokens (>= 0xC0)', () => {
    // 0xC1 -> space + 'A'
    expect(decompressPalmDocRecord(Buffer.from([0xc1])).toString()).toBe(' A');
  });

  it('follows back-references, including overlapping copies', () => {
    // "ABC" then copy 3 bytes from distance 3 -> "ABCABC"
    // encoding: c = 0x80 | hi, next = lo; distance = ((c&0x3F)<<8|next) >> 3, length = (next&7)+3
    const dist3len3 = [0x80, (3 << 3) | (3 - 3)];
    expect(decompressPalmDocRecord(Buffer.from([0x41, 0x42, 0x43, ...dist3len3])).toString()).toBe('ABCABC');
    // Overlapping copy: "a" then copy(dist 1, len 5) -> "aaaaaa"
    const dist1len5 = [0x80, (1 << 3) | (5 - 3)];
    expect(decompressPalmDocRecord(Buffer.from([0x61, ...dist1len5])).toString()).toBe('aaaaaa');
  });

  it('rejects truncated back-references', () => {
    expect(() => decompressPalmDocRecord(Buffer.from([0x80]))).toThrow(MobiError);
  });
});

describe('palmDocTextLength', () => {
  it('returns the declared length for uncompressed text', () => {
    const mobi = makeMobi({ compression: 1, textRecords: [Buffer.from('hello world')] });
    expect(palmDocTextLength(mobi)).toBe(11);
  });

  it('decompresses PalmDOC records and sums the text length', () => {
    // record 1: "ABC" + backref(dist 3, len 3) = "ABCABC"; record 2: literal run "def"
    const rec1 = Buffer.from([0x41, 0x42, 0x43, 0x80, 3 << 3]);
    const rec2 = Buffer.from([0x03, 0x64, 0x65, 0x66]);
    const mobi = makeMobi({ compression: 2, textRecords: [rec1, rec2], declaredTextLength: 9 });
    expect(palmDocTextLength(mobi)).toBe(9);
  });

  it('trusts the declared length for HUFF/CDIC (position space, no decompression)', () => {
    const mobi = makeMobi({ compression: 17480, textRecords: [Buffer.from('x')], declaredTextLength: 45055 });
    expect(palmDocTextLength(mobi)).toBe(45055);
  });

  it('trusts the declared length for DRM-encrypted content (store purchases)', () => {
    // Live-verified against a DRM'd store book: pos values fit this declared length.
    const mobi = makeMobi({ compression: 2, encryption: 2, textRecords: [Buffer.from([0x41])], declaredTextLength: 45055 });
    expect(palmDocTextLength(mobi)).toBe(45055);
  });

  it('rejects when the decompressed length diverges wildly from the header', () => {
    const mobi = makeMobi({
      compression: 2,
      textRecords: [Buffer.from([0x41])], // decompresses to 1 byte
      declaredTextLength: 1_000_000,
    });
    expect(() => palmDocTextLength(mobi)).toThrow(/diverges/);
  });
});
