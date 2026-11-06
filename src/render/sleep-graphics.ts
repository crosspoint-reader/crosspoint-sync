import fs from 'node:fs';
import opentype, { type Font, type PathCommand } from 'opentype.js';
import { PNG } from 'pngjs';

type Point = { x: number; y: number };
type Rotate = { cx: number; cy: number; angle: number };
const fonts = new Map<string, Font>();
function fontFor(weight: 'regular' | 'semibold'): Font {
  if (!fonts.has(weight)) {
    const bytes = fs.readFileSync(new URL(`../../assets/fonts/sleep-journal/lora-${weight}.woff`, import.meta.url));
    fonts.set(weight, opentype.parse(new Uint8Array(bytes).buffer));
  }
  return fonts.get(weight)!;
}

/** Small pure-JS vector rasterizer. Two scanlines per pixel retain fine serif edges. */
export class SleepGraphics {
  readonly image: PNG;
  constructor(width: number, height: number, paper = false) {
    this.image = new PNG({ width, height });
    if (paper) this.image.data.fill(255);
  }
  get width() { return this.image.width; }
  get height() { return this.image.height; }
  pixel(x: number, y: number, gray: number, alpha = 1) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height || alpha <= 0) return;
    const p = (y * this.width + x) * 4, oldAlpha = this.image.data[p + 3] / 255;
    const combined = alpha + oldAlpha * (1 - alpha);
    const value = Math.round((gray * alpha + this.image.data[p] * oldAlpha * (1 - alpha)) / combined);
    this.image.data[p] = this.image.data[p + 1] = this.image.data[p + 2] = value;
    this.image.data[p + 3] = Math.round(combined * 255);
  }
  fill(contours: Point[][], gray = 0) {
    const edges: [Point, Point][] = [];
    let minY = this.height, maxY = 0;
    for (const points of contours) for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if (a.y !== b.y) edges.push([a,b]);
      minY = Math.min(minY, a.y); maxY = Math.max(maxY, a.y);
    }
    for (let y = Math.max(0, Math.floor(minY)); y < Math.min(this.height, Math.ceil(maxY)); y++) {
      const coverage = new Float32Array(this.width);
      for (const dy of [.25,.75]) {
        const scan = y + dy, xs: number[] = [];
        for (const [a,b] of edges) if ((a.y <= scan && b.y > scan) || (b.y <= scan && a.y > scan)) xs.push(a.x + (scan - a.y) * (b.x - a.x) / (b.y - a.y));
        xs.sort((a,b) => a - b);
        for (let i = 0; i + 1 < xs.length; i += 2) {
          const left = Math.max(0, xs[i]), right = Math.min(this.width, xs[i + 1]);
          for (let x = Math.floor(left); x < Math.ceil(right); x++) if (x >= 0 && x < this.width) coverage[x] += .5 * Math.max(0, Math.min(x + 1, right) - Math.max(x, left));
        }
      }
      for (let x = 0; x < this.width; x++) if (coverage[x]) this.pixel(x, y, gray, Math.min(1, coverage[x]));
    }
  }
  line(x1: number, y1: number, x2: number, y2: number, thickness = 1, gray = 0) {
    const length = Math.hypot(x2 - x1, y2 - y1);
    if (!length) return;
    const dx = -(y2 - y1) / length * thickness / 2, dy = (x2 - x1) / length * thickness / 2;
    this.fill([[{ x:x1+dx,y:y1+dy },{ x:x2+dx,y:y2+dy },{ x:x2-dx,y:y2-dy },{ x:x1-dx,y:y1-dy }]], gray);
  }
  circlePoints(cx: number, cy: number, radius: number): Point[] {
    return Array.from({ length: 80 }, (_, i) => ({ x: cx + Math.cos(i / 80 * Math.PI * 2) * radius, y: cy + Math.sin(i / 80 * Math.PI * 2) * radius }));
  }
  disc(cx: number, cy: number, radius: number, gray = 255) { this.fill([this.circlePoints(cx, cy, radius)], gray); }
  ring(cx: number, cy: number, radius: number, thickness = 1, gray = 0) {
    this.fill([this.circlePoints(cx,cy,radius), this.circlePoints(cx,cy,radius-thickness)], gray);
  }
  roundRect(x: number, y: number, width: number, height: number, radius: number, gray = 255, border = 0) {
    const points: Point[] = [];
    for (const [cx,cy,start] of [[x+width-radius,y+radius,-90],[x+width-radius,y+height-radius,0],[x+radius,y+height-radius,90],[x+radius,y+radius,180]]) {
      for (let i = 0; i <= 8; i++) {
        const angle = (start + i / 8 * 90) * Math.PI / 180;
        points.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) });
      }
    }
    if (border) {
      this.fill([points], 0);
      this.roundRect(x+border,y+border,width-2*border,height-2*border,Math.max(0,radius-border),gray);
    } else this.fill([points], gray);
  }
  text(text: string, x: number, baseline: number, size: number, options: { weight?: 'regular' | 'semibold'; align?: 'left' | 'center' | 'right'; maxWidth?: number; tracking?: number; gray?: number; rotate?: Rotate } = {}) {
    const font = fontFor(options.weight ?? 'regular');
    const settings = { kerning: true, tracking: options.tracking ?? 0 };
    const measured = font.getAdvanceWidth(text, size, settings);
    if (options.maxWidth && measured > options.maxWidth) size *= options.maxWidth / measured;
    const width = font.getAdvanceWidth(text, size, settings);
    if (options.align === 'center') x -= width / 2;
    if (options.align === 'right') x -= width;
    this.path(font.getPath(text, x, baseline, size, settings).commands, options.gray ?? 0, options.rotate);
  }
  path(commands: PathCommand[], gray = 0, rotate?: Rotate) {
    const contours: Point[][] = [];
    let points: Point[] = [], previous = { x: 0, y: 0 };
    const add = (point: Point) => {
      previous = point;
      if (rotate) {
        const x = point.x - rotate.cx, y = point.y - rotate.cy;
        points.push({ x: rotate.cx + x * Math.cos(rotate.angle) - y * Math.sin(rotate.angle), y: rotate.cy + x * Math.sin(rotate.angle) + y * Math.cos(rotate.angle) });
      } else points.push(point);
    };
    for (const command of commands) {
      if (command.type === 'M') {
        if (points.length) contours.push(points);
        points = []; add({ x: command.x, y: command.y });
      } else if (command.type === 'L') add({ x: command.x, y: command.y });
      else if (command.type === 'Q' || command.type === 'C') {
        const a = previous, b = { x: command.x1, y: command.y1 }, end = { x: command.x, y: command.y };
        const c = command.type === 'C' ? { x: command.x2, y: command.y2 } : end;
        const steps = Math.max(6, Math.min(40, Math.ceil((Math.hypot(b.x-a.x,b.y-a.y)+Math.hypot(c.x-b.x,c.y-b.y)+Math.hypot(end.x-c.x,end.y-c.y))/3)));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps, u = 1 - t;
          add(command.type === 'Q'
            ? { x:u*u*a.x+2*u*t*b.x+t*t*end.x, y:u*u*a.y+2*u*t*b.y+t*t*end.y }
            : { x:u*u*u*a.x+3*u*u*t*b.x+3*u*t*t*c.x+t*t*t*end.x, y:u*u*u*a.y+3*u*u*t*b.y+3*u*t*t*c.y+t*t*t*end.y });
        }
      } else if (command.type === 'Z') { if (points.length) contours.push(points); points = []; }
    }
    if (points.length) contours.push(points);
    this.fill(contours, gray);
  }
}
