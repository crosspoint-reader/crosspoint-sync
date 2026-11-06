import { describe, expect, it, vi } from 'vitest';
import { PNG } from 'pngjs';
import { deflateSync } from 'node:zlib';
import zlib from 'node:zlib';
import { normalizeBackground, renderSleepImage } from '../src/render/sleep-image.js';
import { journalLayout } from '../src/render/sleep-journal.js';
import { parseSleepOptions } from '../src/models/sleep-image.js';

const stats = { year: 2026, finished: 12, target: 24, currentPercent: 42, streak: 3 };
describe('sleep image rendering', () => {
  it('keeps the cover visible outside the readable panel', () => {
    const result = renderSleepImage(stats, parseSleepOptions({}));
    const png = PNG.sync.read(result.bytes);
    expect(result.contentType).toBe('image/png');
    expect([png.width, png.height]).toEqual([480, 800]);
    expect(png.data[3]).toBe(0);
    const alpha = (x: number, y: number) => png.data[(y * png.width + x) * 4 + 3];
    expect(alpha(30, 770)).toBe(255);
    const top = PNG.sync.read(renderSleepImage(stats, parseSleepOptions({ placement: 'top' })).bytes);
    expect(top.data[(200 * 480 + 240) * 4 + 3]).toBe(255);
    expect(top.data[(770 * 480 + 30) * 4 + 3]).toBe(0);
  });

  it('celebrates reached and exceeded goals and hides absent values', () => {
    const options = parseSleepOptions({});
    expect(journalLayout(stats, options).seal!.count).toBe('12 / 24');
    expect(journalLayout({ ...stats, target: 12 }, options).seal!.reached).toBe(true);
    expect(journalLayout({ ...stats, target: 10 }, options).seal!.count).toBe('12 / 10');
    const absent = journalLayout({ ...stats, target: null, currentPercent: null }, options);
    expect(absent.seal).toBeUndefined();
    expect(absent.cells.map(c => c.label)).not.toContain('current book');
    expect(journalLayout(stats, parseSleepOptions({ metrics: 'streak' })).cells.map(c => c.label)).toEqual(['day streak']);
  });

  it('encodes screen-ready 2-bit BMPs below the firmware cap even with noisy backgrounds', () => {
    const background = new PNG({ width: 480, height: 800 });
    for (let i = 0; i < background.data.length; i += 4) {
      const n = ((i * 1664525 + (i >>> 5) * 1013904223) >>> 8) & 255;
      background.data.set([n, n, n, 255], i);
    }
    for (const [width, height] of [[481, 800], [1200, 1600]]) {
      const result = renderSleepImage(stats, parseSleepOptions({ width: String(width), height: String(height), mode: 'custom' }), PNG.sync.write(background));
      expect(result.contentType).toBe('image/bmp');
      expect(result.bytes.toString('ascii', 0, 2)).toBe('BM');
      expect(result.bytes.readUInt32LE(18)).toBe(width);
      expect(result.bytes.readUInt32LE(22)).toBe(height);
      expect(result.bytes.readUInt16LE(28)).toBe(2);
      expect(result.bytes.length).toBe(70 + Math.ceil(width / 16) * 4 * height);
      expect(result.bytes.length).toBeLessThan(1048576);
      expect(result.bytes.readUInt32LE(2)).toBe(result.bytes.length);
      expect([0,1,2,3].map(index => result.bytes[54 + index * 4])).toEqual([0,85,170,255]);
    }
  });

  it('provides a browser-compatible PNG preview for custom wallpapers', () => {
    const preview = renderSleepImage(stats, parseSleepOptions({ mode: 'custom', preview: '1' }));
    expect(preview.contentType).toBe('image/png');
    expect(PNG.sync.read(preview.bytes).data[3]).toBe(255);
  });

  it('rejects invalid and oversized decoded backgrounds before allocation', () => {
    expect(() => normalizeBackground(Buffer.from('not PNG'))).toThrow(/PNG/i);
    const large = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    large.writeUInt32BE(100000, 16);
    expect(() => normalizeBackground(large)).toThrow(/dimension|pixel/i);
    const valid = PNG.sync.write(new PNG({ width: 240, height: 240 }));
    expect(PNG.sync.read(normalizeBackground(valid)).width).toBe(240);
  });

  it('keeps the entire panel inside short landscape screens', () => {
    const png = PNG.sync.read(renderSleepImage(stats, parseSleepOptions({ width: '1200', height: '240' })).bytes);
    for (let x = 0; x < png.width; x++) {
      expect(png.data[x * 4 + 3]).toBe(0);
      expect(png.data[((png.height - 1) * png.width + x) * 4 + 3]).toBe(0);
    }
  });

  it('rejects a second IHDR before the decoder can replace validated dimensions', () => {
    const first = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    const oversized = PNG.sync.write(new PNG({ width: 1601, height: 1 }));
    const attack = Buffer.concat([first.subarray(0, 33), oversized.subarray(8)]);
    expect(() => normalizeBackground(attack)).toThrow(/PNG|header|IHDR/i);
  });

  it('bounds IDAT decompression even for interlaced images with tiny headers', () => {
    // A valid CRC lets the real decoder reach the allocation that must be bounded.
    const chunk = (type: string, data: Buffer) => {
      const body = Buffer.concat([Buffer.from(type), data]);
      let crc = 0xffffffff;
      for (const byte of body) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
      const out = Buffer.alloc(data.length + 12);
      out.writeUInt32BE(data.length); body.copy(out, 4); out.writeUInt32BE((crc ^ 0xffffffff) >>> 0, out.length - 4);
      return out;
    };
    const ihdr = Buffer.from([0,0,0,1, 0,0,0,1, 8,6,0,0,1]);
    const attack = Buffer.concat([
      Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.alloc(10000))), chunk('IEND', Buffer.alloc(0)),
    ]);
    const inflate = vi.spyOn(zlib, 'inflateSync');
    try {
      expect(() => normalizeBackground(attack)).toThrow();
      expect(inflate).toHaveBeenCalledWith(expect.any(Buffer), expect.objectContaining({ maxOutputLength: 5 }));
    } finally { inflate.mockRestore(); }
    const valid = Buffer.concat([
      Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.from([0,0,0,0,255]))), chunk('IEND', Buffer.alloc(0)),
    ]);
    expect([...PNG.sync.read(normalizeBackground(valid)).data]).toEqual([0,0,0,255]);
  });
});
