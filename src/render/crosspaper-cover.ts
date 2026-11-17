import jpeg from 'jpeg-js';
import { SleepGraphics } from './sleep-graphics.js';

/**
 * The front page of a CrossPaper issue, as the EPUB's cover.
 *
 * The reader shows covers two ways: reduced to 1-bit (lists, fast sleep
 * screens) and in its four greys. Type and rules are solid black on white, so
 * they read the same in both. Grey is used only as a flat field with no text
 * on it, at one of the panel's native levels: in four greys it is an even tone,
 * and in 1-bit it either drops to white or becomes a halftone, never noise
 * behind lettering.
 * The page is laid out on a 480x800 grid and drawn at three times that size,
 * like a normal book cover: the reader scales covers down to its own screen, so
 * edges arrive smooth at any resolution, where a screen-sized image shows every
 * antialiased edge as dither speckle. Baseline JPEG, because the firmware's
 * decoder does not read progressive files.
 */

// The layout grid, and how many pixels each grid unit is drawn with.
const COVER_WIDTH = 480, COVER_HEIGHT = 800;
export const COVER_SCALE = 3;

/** Draws in layout units onto a canvas COVER_SCALE times larger: every shape passes through fill(). */
class Canvas extends SleepGraphics {
  constructor() { super(COVER_WIDTH * COVER_SCALE, COVER_HEIGHT * COVER_SCALE, true); }
  override fill(contours: { x: number; y: number }[][], gray = 0) {
    super.fill(contours.map((points) => points.map((p) => ({ x: p.x * COVER_SCALE, y: p.y * COVER_SCALE }))), gray);
  }
}

// One cover per date, the same for everyone; drawing it takes a moment, so recent ones are kept.
const drawn = new Map<string, Buffer>();
const MARGIN = 44;
// One of the panel's four native levels (0, 85, 170, 255), so it shows as a flat tone.
const DARK = 85;

export interface CoverInput { name: string; date: string }

export function renderCover({ name, date }: CoverInput): Buffer {
  const key = `${name}\n${date}`, kept = drawn.get(key);
  if (kept) return kept;
  const g = new Canvas();
  const right = COVER_WIDTH - MARGIN, inner = right - MARGIN;
  const rule = (y: number, thickness: number, from = MARGIN, to = right) => g.line(from, y, to, y, thickness);

  // A dark grey field fills the top, echoed by a band along the bottom edge. Everything with text stays on white.
  const band = (top: number, bottom: number) => g.fill([[{ x: 0, y: top }, { x: COVER_WIDTH, y: top }, { x: COVER_WIDTH, y: bottom }, { x: 0, y: bottom }]], DARK);
  const field = 388;
  band(0, field);
  band(COVER_HEIGHT - 24, COVER_HEIGHT);

  // Halftone art on the field: an open newspaper, described as a tone from 0
  // to 1 and printed as white dots on a hexagonal grid whose size follows the
  // tone, the way a newspaper picture carries shading. Dots are flat white, so
  // it survives 1-bit.
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  // An open newspaper seen from the front, like a book lying open: two pages
  // meeting at a shadowed fold, each arching up from the fold and falling away
  // to its outer edge. It runs off the bottom and right of the field.
  const tilt = -6 * Math.PI / 180, sx = 404, sy = 84, page = 244, ink = 0.2;
  const between = (v: number, from: number, to: number) => v >= from && v < to;
  // One page's printing, laid out on a 176-wide page: 1 is bare paper.
  const printed = (right: boolean, qx: number, qy: number): number => {
    if (qx < 14 || qx > 162 || qy < 16) return 1; // margins
    const typeAt = (top: number) => qy >= top && (qy - top) % 14 < 7 && between((qx - 14) % 78, 0, 70) ? ink : 1;
    if (!right) {
      if (between(qy, 16, 40)) return between(qx, 30, 146) ? ink : 1; // masthead
      if (between(qy, 46, 50) || between(qy, 54, 56)) return ink; // double rule
      if (between(qy, 68, 81)) return ink; // headline
      if (between(qy, 89, 102)) return qx < 112 ? ink : 1;
      if (between(qy, 116, 208)) { // a picture: sky over two hills
        const hill = Math.max(60 - Math.abs(qx - 60) * 0.95, 44 - Math.abs(qx - 122) * 0.8);
        return 208 - qy < hill ? 0.2 : 0.62;
      }
      return typeAt(222);
    }
    if (between(qy, 16, 29)) return qx < 136 ? ink : 1; // headline
    if (between(qy, 37, 50)) return qx < 96 ? ink : 1;
    if (between(qy, 148, 236) && qx > 92) return 0.5; // a second picture
    return typeAt(66);
  };
  const paperTone = (x: number, y: number) => {
    const dx = x - sx, dy = y - sy;
    const px = dx * Math.cos(tilt) + dy * Math.sin(tilt), py = -dx * Math.sin(tilt) + dy * Math.cos(tilt);
    const right = px > 0, t = Math.abs(px) / page; // 0 at the fold, 1 at the page's outer edge
    if (t > 1) return 0;
    // The top edge of an open page: down in the fold, up over the arch, easing down to the edge.
    const qy = py - (24 * (1 - t) ** 3 - 20 * Math.sin(Math.PI * t) + 13 * t * t);
    if (qy < 0) return 0;
    const fold = 0.4 + 0.6 * clamp(t / 0.22);
    const arch = 0.88 + 0.12 * Math.sin(Math.PI * t);
    const k = 176 / page;
    return Math.max(0.14, (right ? 1 : 0.92) * fold * arch * printed(right, (right ? px : page + px) * k, qy * k));
  };

  const pitch = 6, taps = [-0.34, 0, 0.34];
  for (let row = 0, y = 6; y < field - 6; row++, y += pitch * 0.866) {
    for (let x = (row % 2) * pitch / 2; x < COVER_WIDTH; x += pitch) {
      let tone = 0;
      for (const dx of taps) for (const dy of taps) tone += paperTone(x + dx * pitch, y + dy * pitch);
      if (tone > 0.3) g.disc(x, y, pitch * 0.5 * Math.sqrt(tone / 9), 255);
    }
  }

  // The large type is set on a separate sheet first, then printed onto the page
  // as a halftone: black dots sized by how much of each cell the letter covers.
  const type = new SleepGraphics(COVER_WIDTH, COVER_HEIGHT, true);

  // The paper's name in blackletter, over a newspaper double rule.
  type.text(name, MARGIN, 478, 130, { weight: 'masthead', maxWidth: inner });
  rule(504, 5);
  rule(513, 1.5);

  // The date, set like a numero: the month's initial large, the rest of it small
  // and underlined on the same baseline, then the day.
  const when = new Date(`${date}T00:00:00Z`);
  const part = (options: Intl.DateTimeFormatOptions) => when.toLocaleDateString('en-US', { timeZone: 'UTC', ...options });
  const month = part({ month: 'short' }), day = part({ day: 'numeric' });
  const initial = month.slice(0, 1), rest = month.slice(1);
  // Shrink the whole line together when a wide month and a two-digit day would overrun.
  const width = (k: number) => g.measure(initial, 150 * k, 'bold') + 6 + g.measure(rest, 66 * k, 'semibold') + 12 + g.measure(day, 150 * k, 'bold');
  const k = Math.min(1, inner / width(1));
  const base = 665, big = 150 * k, small = 66 * k; // centred between the double rule and the year's rule
  let x = MARGIN - 4;
  type.text(initial, x, base, big, { weight: 'bold' });
  x += g.measure(initial, big, 'bold') + 6;
  const tail = g.measure(rest, small, 'semibold');
  type.text(rest, x, base - 16, small, { weight: 'semibold' });
  type.line(x, base - 3, x + tail, base - 3, 6);
  x += tail + 12;
  type.text(day, x, base, big, { weight: 'bold' });

  const dot = 4, cell = [-0.33, 0, 0.33];
  const dark = (px: number, py: number) => 1 - type.image.data[(Math.round(py) * COVER_WIDTH + Math.round(px)) * 4] / 255;
  for (let row = 0, y = field + 8; y < 708; row++, y += dot * 0.866) {
    for (let dx = (row % 2) * dot / 2; dx < COVER_WIDTH - 1; dx += dot) {
      let cover = 0;
      for (const ox of cell) for (const oy of cell) cover += dark(Math.max(0, dx + ox * dot), y + oy * dot);
      if (cover > 0.5) g.disc(dx, y, dot * 0.56 * Math.sqrt(cover / 9), 0);
    }
  }

  // The year, small, under a thin rule.
  rule(712, 1.5);
  g.text(part({ year: 'numeric' }), MARGIN, 744, 22, { weight: 'semibold', tracking: 80 });

  const cover = jpeg.encode({ data: g.image.data, width: g.width, height: g.height }, 80).data;
  if (drawn.size >= 8) drawn.delete(drawn.keys().next().value!);
  drawn.set(key, cover);
  return cover;
}
