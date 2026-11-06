import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { normalizeBackground, panelLines, renderSleepImage } from '../src/render/sleep-image.js';
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
    expect(top.data[(30 * 480 + 30) * 4 + 3]).toBe(255);
    expect(top.data[(770 * 480 + 30) * 4 + 3]).toBe(0);
  });

  it('celebrates reached and exceeded goals and hides absent values', () => {
    const options = parseSleepOptions({});
    expect(panelLines(stats, options).map(l => l.text).join(' ')).toContain('12 / 24');
    expect(panelLines({ ...stats, target: 12 }, options).some(l => l.text.includes('GOAL REACHED'))).toBe(true);
    expect(panelLines({ ...stats, target: 10 }, options).map(l => l.text).join(' ')).toContain('12 / 10');
    const absent = panelLines({ ...stats, target: null, currentPercent: null }, options).map(l => l.text).join(' ');
    expect(absent).not.toMatch(/GOAL|CURRENT/);
    expect(panelLines(stats, parseSleepOptions({ metrics: 'streak' })).map(l => l.text).join(' ')).not.toMatch(/BOOKS|CURRENT|GOAL/);
  });

  it('encodes padded 4-bit BMPs below the firmware cap even with noisy backgrounds', () => {
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
      expect(result.bytes.readUInt16LE(28)).toBe(4);
      expect(result.bytes.length).toBe(118 + Math.ceil(width / 8) * 4 * height);
      expect(result.bytes.length).toBeLessThan(1048576);
      expect(result.bytes.readUInt32LE(2)).toBe(result.bytes.length);
    }
  });

  it('rejects invalid and oversized decoded backgrounds before allocation', () => {
    expect(() => normalizeBackground(Buffer.from('not PNG'))).toThrow(/PNG/i);
    const large = PNG.sync.write(new PNG({ width: 1, height: 1 }));
    large.writeUInt32BE(100000, 16);
    expect(() => normalizeBackground(large)).toThrow(/dimension|pixel/i);
    const valid = PNG.sync.write(new PNG({ width: 240, height: 240 }));
    expect(PNG.sync.read(normalizeBackground(valid)).width).toBe(240);
  });
});
