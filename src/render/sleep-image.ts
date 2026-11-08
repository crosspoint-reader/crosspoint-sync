import { PNG } from 'pngjs';
import zlib from 'node:zlib';
import { MAX_BACKGROUND_BYTES, MAX_SLEEP_PIXELS, SleepImageError, type SleepMetrics, type SleepOptions } from '../models/sleep-image.js';
import { drawJournal } from './sleep-journal.js';

export function normalizeBackground(bytes: Buffer): Buffer {
  if (bytes.length > MAX_BACKGROUND_BYTES) throw new SleepImageError('Background exceeds 8 MB.');
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new SleepImageError('Upload a PNG background.');
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 1600 || height > 1600 || width * height > MAX_SLEEP_PIXELS) throw new SleepImageError('Background dimensions exceed the pixel limit.');
  validatePngStream(bytes, width, height);
  try { return PNG.sync.write(PNG.sync.read(bytes, { checkCRC: true }), { colorType: 6 }); }
  catch { throw new SleepImageError('Invalid PNG background.'); }
}

/** pngjs accepts repeated IHDRs and inflates interlaced data without a limit.
 * Validate the actual chunks and bounded scanline stream before invoking it. */
function validatePngStream(bytes: Buffer, width: number, height: number): void {
  const fail = (): never => { throw new SleepImageError('Invalid PNG structure or decompressed scanline data.'); };
  const depth = bytes[24], color = bytes[25], interlace = bytes[28];
  const allowed: Record<number, number[]> = { 0: [1,2,4,8,16], 2: [8,16], 3: [1,2,4,8], 4: [8,16], 6: [8,16] };
  if (!allowed[color]?.includes(depth) || bytes[26] !== 0 || bytes[27] !== 0 || interlace > 1) fail();
  const data: Buffer[] = [];
  let offset = 8, chunks = 0, seenData = false, endedData = false, ended = false;
  while (offset < bytes.length) {
    if (++chunks > 4096 || offset + 12 > bytes.length) fail();
    const length = bytes.readUInt32BE(offset), type = bytes.toString('ascii', offset + 4, offset + 8);
    if (offset + 12 + length > bytes.length) fail();
    if (chunks === 1 ? type !== 'IHDR' || length !== 13 : type === 'IHDR') fail();
    if (type === 'IDAT') {
      if (endedData) fail();
      seenData = true; data.push(bytes.subarray(offset + 8, offset + 8 + length));
    } else if (seenData) endedData = true;
    offset += 12 + length;
    if (type === 'IEND') {
      if (length !== 0 || offset !== bytes.length || !seenData) fail();
      ended = true; break;
    }
  }
  if (!ended) fail();
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const bpp = channels[color] * depth;
  const passes = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const budget = passes.reduce((sum, [x, y, dx, dy]) => {
    const w = Math.max(0, Math.ceil((width - x) / dx)), h = Math.max(0, Math.ceil((height - y) / dy));
    return sum + (w && h ? (Math.ceil(w * bpp / 8) + 1) * h : 0);
  }, 0);
  try {
    if (zlib.inflateSync(Buffer.concat(data), { maxOutputLength: budget }).length !== budget) fail();
  } catch { fail(); }
}

export function renderSleepImage(stats: SleepMetrics, options: SleepOptions, background?: Buffer): { bytes: Buffer; contentType: 'image/png' | 'image/bmp' } {
  const png = drawJournal(stats, options, background);
  if (options.mode === 'custom') {
    // Match the display's native four shades and bypass firmware conversion caches.
    for (let p = 0; p < png.data.length; p += 4) png.data[p] = png.data[p + 1] = png.data[p + 2] = Math.round(png.data[p] / 85) * 85;
  }
  const asPng = options.mode === 'overlay' || options.preview;
  const bytes = asPng ? PNG.sync.write(png, { colorType: 6 }) : grayBmp(png);
  if (bytes.length >= 1024 * 1024) throw new SleepImageError('Rendered image exceeds the reader download limit.');
  return { bytes, contentType: asPng ? 'image/png' : 'image/bmp' };
}

function grayBmp(png: PNG): Buffer {
  const stride = Math.ceil(png.width / 16) * 4;
  const offset = 54 + 4 * 4;
  const out = Buffer.alloc(offset + stride * png.height);
  out.write('BM'); out.writeUInt32LE(out.length, 2); out.writeUInt32LE(offset, 10);
  out.writeUInt32LE(40, 14); out.writeInt32LE(png.width, 18); out.writeInt32LE(png.height, 22);
  out.writeUInt16LE(1, 26); out.writeUInt16LE(2, 28); out.writeUInt32LE(stride * png.height, 34); out.writeUInt32LE(4, 46);
  for (let i = 0; i < 4; i++) out.fill(i * 85, 54 + i * 4, 54 + i * 4 + 3);
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const value = Math.round(png.data[(y * png.width + x) * 4] / 85);
    out[offset + (png.height - y - 1) * stride + (x >> 2)] |= value << (6 - (x % 4) * 2);
  }
  return out;
}
