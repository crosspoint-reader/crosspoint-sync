import { PNG } from 'pngjs';
import { MAX_BACKGROUND_BYTES, MAX_SLEEP_PIXELS, SleepImageError, type SleepMetrics, type SleepOptions } from '../models/sleep-image.js';
import { sleepGlyph } from './sleep-font.js';

export function normalizeBackground(bytes: Buffer): Buffer {
  if (bytes.length > MAX_BACKGROUND_BYTES) throw new SleepImageError('Background exceeds 8 MB.');
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) || bytes.toString('ascii', 12, 16) !== 'IHDR') {
    throw new SleepImageError('Upload a PNG background.');
  }
  const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
  if (!width || !height || width > 1600 || height > 1600 || width * height > MAX_SLEEP_PIXELS) throw new SleepImageError('Background dimensions exceed the pixel limit.');
  try { return PNG.sync.write(PNG.sync.read(bytes, { checkCRC: true }), { colorType: 6 }); }
  catch { throw new SleepImageError('Invalid PNG background.'); }
}

type PanelLine = { text: string; fraction?: number; large?: boolean };
export function panelLines(stats: SleepMetrics, options: SleepOptions): PanelLine[] {
  const lines: PanelLine[] = [];
  if (options.metrics.includes('books')) lines.push({ text: `${stats.finished} BOOK${stats.finished === 1 ? '' : 'S'} IN ${stats.year}`, large: true });
  if (options.metrics.includes('goal') && stats.target !== null) {
    lines.push({ text: stats.finished >= stats.target ? '* GOAL REACHED! *' : 'YOUR READING GOAL' });
    lines.push({ text: `${stats.finished} / ${stats.target} BOOKS`, fraction: Math.min(1, stats.finished / stats.target) });
  }
  if (options.metrics.includes('current') && stats.currentPercent !== null) lines.push({ text: `CURRENT BOOK ${Math.floor(stats.currentPercent)}%`, fraction: stats.currentPercent / 100 });
  if (options.metrics.includes('streak')) lines.push({ text: `${stats.streak} DAY${stats.streak === 1 ? '' : 'S'} READING STREAK` });
  return lines;
}

export function renderSleepImage(stats: SleepMetrics, options: SleepOptions, background?: Buffer): { bytes: Buffer; contentType: 'image/png' | 'image/bmp' } {
  const { width, height } = options;
  const png = new PNG({ width, height });
  const pixel = (x: number, y: number, value: number, alpha = 255) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = (y * width + x) * 4;
    png.data[p] = png.data[p + 1] = png.data[p + 2] = value;
    png.data[p + 3] = alpha;
  };
  const rect = (x: number, y: number, w: number, h: number, value: number) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) pixel(xx, yy, value);
  };
  if (options.mode === 'custom') {
    png.data.fill(255);
    if (background) {
      const source = PNG.sync.read(background);
      const scale = Math.max(width / source.width, height / source.height);
      const left = (source.width - width / scale) / 2, top = (source.height - height / scale) / 2;
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const p = (Math.min(source.height - 1, Math.floor(top + y / scale)) * source.width + Math.min(source.width - 1, Math.floor(left + x / scale))) * 4;
        const alpha = source.data[p + 3] / 255;
        const gray = Math.round((source.data[p] * .299 + source.data[p + 1] * .587 + source.data[p + 2] * .114) * alpha + 255 * (1 - alpha));
        pixel(x, y, gray);
      }
    }
  }
  const lines = panelLines(stats, options);
  if (lines.length) {
    const scale = Math.max(1, Math.floor(width / 240));
    const margin = 8 * scale, padding = 10 * scale, lineHeight = 16 * scale;
    const panelHeight = padding * 2 + lines.reduce((sum, l) => sum + lineHeight + (l.fraction !== undefined ? 8 * scale : 0), 0);
    const y0 = options.placement === 'top' ? margin : height - margin - panelHeight;
    rect(margin, y0, width - margin * 2, panelHeight, 0);
    rect(margin + scale, y0 + scale, width - margin * 2 - 2 * scale, panelHeight - 2 * scale, 255);
    let y = y0 + padding;
    for (const line of lines) {
      const available = width - 2 * (margin + padding);
      const fontScale = Math.max(1, Math.min(line.large ? scale + 1 : scale, Math.floor(available / (line.text.length * 6))));
      let x = margin + padding;
      for (const ch of line.text) {
        sleepGlyph(ch).forEach((row, yy) => [...row].forEach((bit, xx) => {
          if (bit === '1') rect(x + xx * fontScale, y + yy * fontScale, fontScale, fontScale, 0);
        }));
        x += 6 * fontScale;
      }
      y += lineHeight;
      if (line.fraction !== undefined) {
        const barWidth = available, barHeight = 4 * scale;
        rect(margin + padding, y - 3 * scale, barWidth, barHeight, 0);
        rect(margin + padding + scale, y - 2 * scale, barWidth - scale * 2, barHeight - scale * 2, 255);
        rect(margin + padding, y - 3 * scale, Math.round(barWidth * line.fraction), barHeight, 0);
        y += 8 * scale;
      }
    }
  }
  const bytes = options.mode === 'overlay' ? PNG.sync.write(png, { colorType: 6 }) : grayBmp(png);
  if (bytes.length >= 1024 * 1024) throw new SleepImageError('Rendered image exceeds the reader download limit.');
  return { bytes, contentType: options.mode === 'overlay' ? 'image/png' : 'image/bmp' };
}

function grayBmp(png: PNG): Buffer {
  const stride = Math.ceil(png.width / 8) * 4;
  const offset = 54 + 16 * 4;
  const out = Buffer.alloc(offset + stride * png.height);
  out.write('BM'); out.writeUInt32LE(out.length, 2); out.writeUInt32LE(offset, 10);
  out.writeUInt32LE(40, 14); out.writeInt32LE(png.width, 18); out.writeInt32LE(png.height, 22);
  out.writeUInt16LE(1, 26); out.writeUInt16LE(4, 28); out.writeUInt32LE(stride * png.height, 34); out.writeUInt32LE(16, 46);
  for (let i = 0; i < 16; i++) out.fill(i * 17, 54 + i * 4, 54 + i * 4 + 3);
  for (let y = 0; y < png.height; y++) for (let x = 0; x < png.width; x++) {
    const value = Math.round(png.data[(y * png.width + x) * 4] / 17);
    out[offset + (png.height - y - 1) * stride + (x >> 1)] |= value << (x % 2 ? 0 : 4);
  }
  return out;
}
