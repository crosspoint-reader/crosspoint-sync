import { PNG } from 'pngjs';
import type { SleepMetrics, SleepOptions } from '../models/sleep-image.js';
import { SleepGraphics } from './sleep-graphics.js';

interface Rect { x: number; y: number; width: number; height: number }
interface Cell { value: string; label: string; fraction?: number }
interface Seal { cx: number; cy: number; radius: number; angle: number; count: string; reached: boolean }
export interface JournalLayout { scale: number; card: Rect; art?: Rect; fullPage: boolean; cells: Cell[]; seal?: Seal }

export function journalLayout(stats: SleepMetrics, options: SleepOptions): JournalLayout {
  const { width, height, metrics } = options;
  const scale = Math.max(.5, Math.min(width / 480, height / 360));
  const margin = Math.max(10, 22 * scale), padding = 20 * scale;
  const cells: Cell[] = [];
  if (metrics.includes('books')) cells.push({ value: String(stats.finished), label: 'books this year' });
  if (metrics.includes('current') && stats.currentPercent !== null) cells.push({ value: `${Math.floor(stats.currentPercent)}%`, label: 'current book', fraction: stats.currentPercent / 100 });
  if (metrics.includes('streak')) cells.push({ value: String(stats.streak), label: 'day streak' });
  const hasSeal = metrics.includes('goal') && stats.target !== null;
  const radius = Math.max(34, 55 * scale), rise = hasSeal ? radius * .72 : 0;
  const cardHeight = Math.max(128, (cells.length ? 190 : 116) * scale);
  const fullPage = options.mode === 'custom' && height >= width * 1.25 && height >= 480;
  const inset = fullPage ? 12 * scale : 0;
  const card: Rect = { x: margin + inset, y: 0, width: width - 2 * (margin + inset), height: cardHeight };
  const bottom = height - margin - inset;
  card.y = options.placement === 'bottom' ? bottom - cardHeight : margin + (fullPage ? 108 * scale : 0) + rise;
  const seal: Seal | undefined = hasSeal ? {
    cx: card.x + card.width - padding - radius,
    cy: card.y + radius - rise,
    radius, angle: -10 * Math.PI / 180, count: `${stats.finished} / ${stats.target}`,
    reached: stats.finished >= stats.target!,
  } : undefined;
  let art: Rect | undefined;
  if (fullPage) {
    const top = options.placement === 'bottom' ? margin + 108 * scale : card.y + card.height + 24 * scale;
    const end = options.placement === 'bottom' ? card.y - 24 * scale : bottom;
    art = { x: card.x + 4 * scale, y: top, width: card.width - 8 * scale, height: end - top };
  }
  return { scale, card, art, fullPage, cells, seal };
}

function star(g: SleepGraphics, cx: number, cy: number, size: number, gray = 0) {
  g.line(cx-size,cy,cx+size,cy,1,gray); g.line(cx,cy-size,cx,cy+size,1,gray);
  g.line(cx-size*.45,cy-size*.45,cx+size*.45,cy+size*.45,.7,gray);
  g.line(cx+size*.45,cy-size*.45,cx-size*.45,cy+size*.45,.7,gray);
}

function book(g: SleepGraphics, cx: number, cy: number, width: number, height: number, stroke: number) {
  // Two bowed pages form an original open-book motif.
  for (const direction of [-1,1]) {
    const edge = cx + direction * width / 2;
    g.path([
      { type:'M',x:cx,y:cy },
      { type:'Q',x1:cx+direction*width*.25,y1:cy-height*.26,x:edge,y:cy-height*.13 },
      { type:'L',x:edge,y:cy+height*.68 },
      { type:'Q',x1:cx+direction*width*.25,y1:cy+height*.53,x:cx,y:cy+height*.83 },
      { type:'Z' },
    ], 0);
    g.path([
      { type:'M',x:cx+direction*stroke,y:cy+stroke },
      { type:'Q',x1:cx+direction*width*.25,y1:cy-height*.22+stroke,x:edge-direction*stroke,y:cy-height*.13+stroke },
      { type:'L',x:edge-direction*stroke,y:cy+height*.68-stroke },
      { type:'Q',x1:cx+direction*width*.25,y1:cy+height*.53-stroke,x:cx+direction*stroke,y:cy+height*.83-stroke },
      { type:'Z' },
    ], 255);
    for (let row = 0; row < 4; row++) {
      const y = cy + height * (.15 + row * .12);
      g.line(cx+direction*width*.1,y,edge-direction*width*.1,y-height*.06,stroke*.65,85);
    }
  }
}

function artwork(g: SleepGraphics, rect: Rect, scale: number, background?: Buffer) {
  const { x,y,width,height } = rect;
  const radius = 12 * scale;
  g.roundRect(x-2*scale,y-2*scale,width+4*scale,height+4*scale,radius,255,Math.max(1,scale));
  if (background) {
    const source = PNG.sync.read(background);
    const ratio = Math.max(width/source.width,height/source.height);
    const left = (source.width-width/ratio)/2, top = (source.height-height/ratio)/2;
    for (let yy = Math.ceil(y); yy < y+height; yy++) for (let xx = Math.ceil(x); xx < x+width; xx++) {
      const localX = xx+.5-x, localY = yy+.5-y;
      const cornerX = Math.max(radius-localX,localX-(width-radius),0), cornerY = Math.max(radius-localY,localY-(height-radius),0);
      if (cornerX*cornerX+cornerY*cornerY > radius*radius) continue;
      const sx = Math.max(0,Math.min(source.width-1,Math.floor(left+localX/ratio)));
      const sy = Math.max(0,Math.min(source.height-1,Math.floor(top+localY/ratio)));
      const p = (sy*source.width+sx)*4, alpha = source.data[p+3]/255;
      g.pixel(xx,yy,Math.round((source.data[p]*.299+source.data[p+1]*.587+source.data[p+2]*.114)*alpha+255*(1-alpha)));
    }
  } else {
    const cx = x+width/2, cy = y+height*.49;
    const bw = Math.min(width*.65,height*.73), bh = bw*.53;
    book(g,cx,cy-bh*.25,bw,bh,Math.max(1,1.4*scale));
    star(g,cx+width*.25,cy-height*.23,8*scale);
    star(g,cx-width*.22,cy-height*.18,5*scale,85);
    star(g,cx+width*.08,cy-height*.31,4*scale,85);
    for (const direction of [-1,1]) g.line(cx+direction*bw*.53,cy+bh*.73,cx+direction*bw*.63,cy+bh*.73,scale,85);
    g.text('Good stories, quiet moments.',cx,y+height-26*scale,Math.max(10,13*scale),{ align:'center',maxWidth:width-24*scale,gray:85 });
  }
}

export function drawJournal(stats: SleepMetrics, options: SleepOptions, background?: Buffer): PNG {
  const g = new SleepGraphics(options.width,options.height,options.mode==='custom');
  const layout = journalLayout(stats,options);
  const { scale:s,card,seal,cells } = layout;
  const pad = 20*s, stroke = Math.max(1,s);
  if (layout.fullPage) {
    const m = Math.max(10,22*s);
    g.roundRect(m-7*s,m-7*s,options.width-2*m+14*s,options.height-2*m+14*s,16*s,255,stroke);
    book(g,options.width/2,m+7*s,26*s,14*s,Math.max(.8,s));
    g.text('THE READING JOURNAL',options.width/2,m+48*s,Math.max(9,11*s),{ align:'center',tracking:130,maxWidth:options.width-2*m });
    g.text('One more chapter.',options.width/2,m+81*s,27*s,{ align:'center',maxWidth:options.width-2*m-16*s });
    if (layout.art && layout.art.height > 0) artwork(g,layout.art,s,background);
  } else if (options.mode==='custom') {
    artwork(g,{ x:12*s,y:12*s,width:options.width-24*s,height:options.height-24*s },s,background);
  }
  if (!cells.length && !seal) return g.image;
  g.roundRect(card.x,card.y,card.width,card.height,12*s,255,stroke);
  const titleWidth = seal ? seal.cx-seal.radius-card.x-pad-6*s : card.width-2*pad;
  g.text(`READING JOURNAL / ${stats.year}`,card.x+pad,card.y+27*s,Math.max(8.5,10*s),{ tracking:65,maxWidth:titleWidth,gray:85 });
  g.text(seal?.reached ? 'Well read.' : 'Between chapters',card.x+pad,card.y+64*s,Math.max(17,25*s),{ maxWidth:titleWidth });
  if (cells.length) {
    const divider = card.y+card.height*.47;
    g.line(card.x+pad,divider,card.x+card.width-pad,divider,Math.max(.7,.8*s),85);
    const cellWidth = (card.width-2*pad)/cells.length;
    cells.forEach((cell,index) => {
      const cx = card.x+pad+cellWidth*(index+.5);
      const numberY = divider+(card.height-(divider-card.y))*.43;
      g.text(cell.value,cx,numberY,Math.max(20,33*s),{ align:'center',weight:'semibold',maxWidth:cellWidth-8*s });
      g.text(cell.label,cx,numberY+23*s,Math.max(8,10.5*s),{ align:'center',maxWidth:cellWidth-4*s });
      if (index) g.line(card.x+pad+cellWidth*index,divider+18*s,card.x+pad+cellWidth*index,card.y+card.height-27*s,Math.max(.6,.7*s),170);
      if (cell.fraction !== undefined) {
        const w = Math.min(cellWidth-14*s,88*s), y = card.y+card.height-15*s;
        g.line(cx-w/2,y,cx+w/2,y,2*s,170);
        if (cell.fraction > 0) g.line(cx-w/2,y,cx-w/2+w*cell.fraction,y,2*s,0);
      }
    });
  }
  if (seal) {
    const { cx,cy,radius:r,angle } = seal;
    g.disc(cx,cy,r+2*s);
    g.ring(cx,cy,r,Math.max(1,1.3*s));
    g.ring(cx,cy,r-5*s,Math.max(.6,.7*s),85);
    const rotate = { cx,cy,angle };
    g.text(seal.reached?'GOAL REACHED':'YEARLY GOAL',cx,cy-17*s,Math.max(8,9*s),{ align:'center',weight:'semibold',tracking:50,maxWidth:r*1.5,rotate });
    g.text(seal.count,cx,cy+8*s,Math.max(13,21*s),{ align:'center',weight:'semibold',maxWidth:r*1.5,rotate });
    g.text(String(stats.year),cx,cy+29*s,Math.max(9,11*s),{ align:'center',tracking:140,rotate });
    if (seal.reached) {
      star(g,cx-r*.86,cy-r*.58,5*s);
      star(g,cx+r*.85,cy+r*.58,5*s);
    }
  }
  return g.image;
}
