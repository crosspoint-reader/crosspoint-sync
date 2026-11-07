import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import { journalLayout } from '../src/render/sleep-journal.js';
import { renderSleepImage } from '../src/render/sleep-image.js';
import { parseSleepOptions } from '../src/models/sleep-image.js';

const stats = { year: 2026, finished: 12, target: 24, currentPercent: 42, streak: 7 };

describe('reading journal composition', () => {
  it('overlaps the compact bookplate with a tilted annual-goal seal', () => {
    const layout = journalLayout(stats, parseSleepOptions({}));
    expect(layout.card.y).toBeGreaterThan(500);
    expect(layout.seal!.angle).toBeCloseTo(-10 * Math.PI / 180);
    expect(layout.seal!.cy - layout.seal!.radius).toBeLessThan(layout.card.y);
    expect(layout.seal!.cy + layout.seal!.radius).toBeGreaterThan(layout.card.y);
    expect(layout.cells.map(cell => cell.value)).toEqual(['12', '42%', '7']);
    expect(layout.art).toBeUndefined();
  });

  it('uses a framed artwork region for full-page Custom and retains paper margins', () => {
    const options = parseSleepOptions({ mode: 'custom', preview: '1' });
    const layout = journalLayout(stats, options);
    expect(layout.fullPage).toBe(true);
    expect(layout.art!.height).toBeGreaterThan(160);
    expect(layout.art!.y + layout.art!.height).toBeLessThan(layout.card.y);
    const background = new PNG({ width: 240, height: 240 });
    for (let p = 0; p < background.data.length; p += 4) background.data.set([85,85,85,255], p);
    const png = PNG.sync.read(renderSleepImage(stats, options, PNG.sync.write(background)).bytes);
    expect([...png.data.subarray(0, 4)]).toEqual([255,255,255,255]);
    const art = layout.art!;
    const center = ((Math.floor(art.y + art.height / 2) * png.width) + Math.floor(art.x + art.width / 2)) * 4;
    expect([...png.data.subarray(center, center + 4)]).toEqual([85,85,85,255]);
  });

  it('hides absent and disabled metrics including their seal', () => {
    const layout = journalLayout({ ...stats, target: null, currentPercent: null }, parseSleepOptions({ metrics: 'goal,current,streak' }));
    expect(layout.seal).toBeUndefined();
    expect(layout.cells.map(cell => cell.value)).toEqual(['7']);
    const reached = journalLayout({ ...stats, finished: 30 }, parseSleepOptions({}));
    expect(reached.seal!.reached).toBe(true);
    expect(reached.seal!.count).toBe('30 / 24');
  });

  it('makes the headline and goal ring reflect the remaining books', () => {
    const options = parseSleepOptions({});
    const progress = journalLayout({ ...stats, finished: 4, target: 6 }, options);
    expect(progress.headline).toBe('2 books to go.');
    expect(progress.seal!.fraction).toBeCloseTo(2 / 3);
    expect(progress.card.height).toBeLessThan(190);
    expect(journalLayout({ ...stats, finished: 5, target: 6 }, options).headline).toBe('1 book to go.');
    const exceeded = journalLayout({ ...stats, finished: 7, target: 6 }, options);
    expect(exceeded.headline).toBe('You did it!');
    expect(exceeded.seal!.fraction).toBe(1);
    expect(journalLayout(stats, parseSleepOptions({ metrics: 'books,current' })).headline).toBe('Between chapters');
    expect(journalLayout({ ...stats, target: null }, options).headline).toBe('Between chapters');
  });

  it('keeps a clear band of paper between goal text and the inner ring', () => {
    const sample = { ...stats, finished: 4, target: 6 };
    const options = parseSleepOptions({});
    const { seal, scale } = journalLayout(sample, options);
    const png = PNG.sync.read(renderSleepImage(sample, options).bytes);
    const innerEdge = seal!.radius - 9.5 * scale;
    let ink = 0;
    for (let y = Math.floor(seal!.cy - seal!.radius); y <= seal!.cy + seal!.radius; y++) {
      for (let x = Math.floor(seal!.cx - seal!.radius); x <= seal!.cx + seal!.radius; x++) {
        const distance = Math.hypot(x + .5 - seal!.cx, y + .5 - seal!.cy);
        if (distance >= innerEdge - 4 * scale && distance <= innerEdge - scale) {
          const p = (y * png.width + x) * 4;
          if (png.data[p+3] > 0 && png.data[p] < 170) ink++;
        }
      }
    }
    expect(ink).toBe(0);
  });

  it('keeps cards and stamps in bounds at supported sizes and placements', () => {
    for (const [width, height] of [[240,320], [480,800], [1200,1600], [1200,240]]) {
      for (const mode of ['overlay','custom']) for (const placement of ['top','bottom']) {
        const layout = journalLayout(stats, parseSleepOptions({ width: String(width), height: String(height), mode, placement }));
        const card = layout.card;
        expect(card.x).toBeGreaterThanOrEqual(1);
        expect(card.y).toBeGreaterThanOrEqual(1);
        expect(card.x + card.width).toBeLessThan(width);
        expect(card.y + card.height).toBeLessThan(height);
        if (layout.seal) {
          const { cx, cy, radius } = layout.seal;
          expect(cx - radius).toBeGreaterThanOrEqual(1);
          expect(cy - radius).toBeGreaterThanOrEqual(1);
          expect(cx + radius).toBeLessThan(width);
          expect(cy + radius).toBeLessThan(height);
        }
      }
    }
  });
});
