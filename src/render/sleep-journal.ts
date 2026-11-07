import { PNG } from 'pngjs';
import type { SleepMetrics, SleepOptions } from '../models/sleep-image.js';
import { SleepGraphics } from './sleep-graphics.js';

interface Rect { x: number; y: number; width: number; height: number }
interface Cell { value: string; label: string; fraction?: number }
interface Seal { cx: number; cy: number; radius: number; angle: number; count: string; reached: boolean; fraction: number }
export interface JournalLayout { scale: number; headline: string; card: Rect; art?: Rect; fullPage: boolean; cells: Cell[]; seal?: Seal }

export function journalLayout(stats: SleepMetrics, options: SleepOptions): JournalLayout {
  const { width, height, metrics } = options;
  const scale = Math.max(.5, Math.min(width / 480, height / 360));
  const margin = Math.max(10, 22 * scale), padding = 20 * scale;
  const cells: Cell[] = [];
  if (metrics.includes('books')) cells.push({ value: String(stats.finished), label: 'books this year' });
  if (metrics.includes('current') && stats.currentPercent !== null) cells.push({ value: `${Math.floor(stats.currentPercent)}%`, label: 'current book', fraction: stats.currentPercent / 100 });
  if (metrics.includes('streak')) cells.push({ value: String(stats.streak), label: 'day streak' });
  const hasSeal = metrics.includes('goal') && stats.target !== null;
  const radius = Math.max(42, 64 * scale), rise = hasSeal ? radius * .72 : 0;
  const cardHeight = Math.max(128, (cells.length ? 178 : 116) * scale);
  const fullPage = options.mode === 'custom' && height >= width * 1.25 && height >= 480;
  const inset = fullPage ? 12 * scale : 0;
  const card: Rect = { x: margin + inset, y: 0, width: width - 2 * (margin + inset), height: cardHeight };
  const bottom = height - margin - inset;
  card.y = options.placement === 'bottom' ? bottom - cardHeight : margin + (fullPage ? 108 * scale : 0) + rise;
  const seal: Seal | undefined = hasSeal ? {
    cx: card.x + card.width - padding - radius,
    cy: card.y + radius - rise - 8 * scale,
    radius, angle: -10 * Math.PI / 180, count: `${stats.finished} / ${stats.target}`,
    reached: stats.finished >= stats.target!,
    fraction: Math.max(0, Math.min(1, stats.finished / stats.target!)),
  } : undefined;
  let art: Rect | undefined;
  if (fullPage) {
    const top = options.placement === 'bottom' ? margin + 108 * scale : card.y + card.height + 24 * scale;
    const end = options.placement === 'bottom' ? card.y - 24 * scale : bottom;
    art = { x: card.x + 4 * scale, y: top, width: card.width - 8 * scale, height: end - top };
  }
  const remaining = seal ? Math.max(0, stats.target! - stats.finished) : 0;
  const headline = seal ? (seal.reached ? 'You did it!' : `${remaining} ${remaining === 1 ? 'book' : 'books'} to go.`) : 'Between chapters';
  return { scale, headline, card, art, fullPage, cells, seal };
}

function star(g: SleepGraphics, cx: number, cy: number, size: number, gray = 0) {
  g.line(cx-size,cy,cx+size,cy,2.4,gray); g.line(cx,cy-size,cx,cy+size,2.4,gray);
  g.line(cx-size*.45,cy-size*.45,cx+size*.45,cy+size*.45,1.7,gray);
  g.line(cx+size*.45,cy-size*.45,cx-size*.45,cy+size*.45,1.7,gray);
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
      g.line(cx+direction*width*.1,y,edge-direction*width*.1,y-height*.06,stroke*.8,0);
    }
  }
}

function celebration(g: SleepGraphics, rect: Rect, scale: number, finished: number) {
  const { x, y, width, height } = rect;
  const cx = x + width / 2, cy = y + height * .40;
  const radius = Math.min(width * .29, height * .21);
  // A burst of ink around the book turns the quiet journal into an award page.
  for (let i = 0; i < 20; i++) {
    const angle = i * Math.PI / 10;
    const inner = radius * 1.15, outer = radius * (i % 2 ? 1.34 : 1.52);
    g.line(cx + Math.cos(angle) * inner, cy + Math.sin(angle) * inner,
      cx + Math.cos(angle) * outer, cy + Math.sin(angle) * outer, Math.max(2, 3.8 * scale));
  }
  g.ring(cx, cy, radius, Math.max(2, 4 * scale));
  book(g, cx, cy - radius * .24, radius * 1.35, radius * .73, Math.max(2, 4 * scale));
  for (const [dx, dy, size] of [[-.39,-.32,9],[.39,-.27,7],[-.37,.25,6],[.38,.28,10]]) {
    star(g, cx + width * dx, cy + height * dy, size * scale);
  }
  g.text('GOAL COMPLETE!', cx, y + height * .79, 25 * scale,
    { align: 'center', weight: 'bold', maxWidth: width - 24 * scale });
  g.text(`${finished} books. A year of stories.`, cx, y + height * .88, 16 * scale,
    { weight: 'bold', align: 'center', maxWidth: width - 24 * scale });
}

function artwork(g: SleepGraphics, rect: Rect, scale: number, background?: Buffer) {
  const { x,y,width,height } = rect;
  const radius = 12 * scale;
  g.roundRect(x-2*scale,y-2*scale,width+4*scale,height+4*scale,radius,255,Math.max(2,3*scale));
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
    book(g,cx,cy-bh*.25,bw,bh,Math.max(2,3*scale));
    star(g,cx+width*.25,cy-height*.23,8*scale);
    star(g,cx-width*.22,cy-height*.18,5*scale,0);
    star(g,cx+width*.08,cy-height*.31,4*scale,0);
    for (const direction of [-1,1]) g.line(cx+direction*bw*.53,cy+bh*.73,cx+direction*bw*.63,cy+bh*.73,1.6*scale,0);
    g.text('Good stories, quiet moments.',cx,y+height-26*scale,Math.max(11,14*scale),{ align:'center',weight:'bold',maxWidth:width-24*scale });
  }
}

export function drawJournal(stats: SleepMetrics, options: SleepOptions, background?: Buffer): PNG {
  const g = new SleepGraphics(options.width,options.height,options.mode==='custom');
  const layout = journalLayout(stats,options);
  const { scale:s,card,seal,cells } = layout;
  const pad = 20*s, stroke = Math.max(2,3*s);
  if (layout.fullPage) {
    const m = Math.max(10,22*s);
    g.roundRect(m-7*s,m-7*s,options.width-2*m+14*s,options.height-2*m+14*s,16*s,255,stroke);
    book(g,options.width/2,m+7*s,26*s,14*s,Math.max(1,1.4*s));
    g.text('THE READING JOURNAL',options.width/2,m+48*s,Math.max(11,13*s),{ align:'center',weight:'bold',tracking:100,maxWidth:options.width-2*m });
    g.text(seal?.reached ? 'You did it!' : 'One more chapter.',options.width/2,m+81*s,29*s,{ weight:'bold',align:'center',maxWidth:options.width-2*m-16*s });
    if (layout.art && layout.art.height > 0) {
      if (seal?.reached && !background) celebration(g,layout.art,s,stats.finished);
      else artwork(g,layout.art,s,background);
    }
  } else if (options.mode==='custom') {
    artwork(g,{ x:12*s,y:12*s,width:options.width-24*s,height:options.height-24*s },s,background);
  }
  if (!cells.length && !seal) return g.image;
  g.roundRect(card.x,card.y,card.width,card.height,12*s,255,stroke);
  if (seal?.reached) {
    g.roundRect(card.x,card.y,card.width,card.height * .47,12*s,0);
  }
  const titleWidth = seal ? seal.cx-seal.radius-card.x-pad-6*s : card.width-2*pad;
  g.text('YOUR READING YEAR',card.x+pad,card.y+27*s,Math.max(11,13*s),{ weight:'bold',tracking:40,maxWidth:titleWidth,gray:seal?.reached ? 255 : 0 });
  g.text(layout.headline,card.x+pad,card.y+64*s,Math.max(19,27*s),{ maxWidth:titleWidth,weight:'bold',gray:seal?.reached ? 255 : 0 });
  if (cells.length) {
    const divider = card.y+card.height*.47;
    g.line(card.x+pad,divider,card.x+card.width-pad,divider,Math.max(1.8,2.7*s),0);
    const cellWidth = (card.width-2*pad)/cells.length;
    cells.forEach((cell,index) => {
      const cx = card.x+pad+cellWidth*(index+.5);
      const numberY = divider+(card.height-(divider-card.y))*.43;
      g.text(cell.value,cx,numberY,Math.max(22,38*s),{ align:'center',weight:'bold',maxWidth:cellWidth-8*s });
      g.text(cell.label,cx,numberY+23*s,Math.max(11,14.5*s),{ align:'center',weight:'bold',maxWidth:cellWidth-4*s });
      if (index) g.line(card.x+pad+cellWidth*index,divider+18*s,card.x+pad+cellWidth*index,card.y+card.height-27*s,Math.max(1.5,2.2*s),0);
      if (cell.fraction !== undefined) {
        const w = Math.min(cellWidth-14*s,88*s), y = card.y+card.height-15*s;
        g.roundRect(cx-w/2,y-2.5*s,w,5*s,1*s,255,Math.max(.8,s));
        if (cell.fraction > 0) g.line(cx-w/2,y,cx-w/2+w*cell.fraction,y,3.5*s,0);
      }
    });
  }
  if (seal) {
    const { cx,cy,radius:r,angle } = seal;
    g.disc(cx,cy,r+2*s);
    if (seal.reached) g.disc(cx,cy,r,0);
    const ink = seal.reached ? 255 : 0;
    g.ring(cx,cy,r,Math.max(1.2,1.6*s),ink);
    // The heavier arc is the year's actual progress, starting at the tilted top.
    const points = [], steps = Math.max(1,Math.ceil(seal.fraction*120));
    for (let i=0;i<=steps;i++) {
      const a = -Math.PI/2+angle+i/steps*seal.fraction*Math.PI*2;
      points.push({x:cx+Math.cos(a)*r,y:cy+Math.sin(a)*r});
    }
    for (let i=steps;i>=0;i--) {
      const a = -Math.PI/2+angle+i/steps*seal.fraction*Math.PI*2;
      points.push({x:cx+Math.cos(a)*(r-5.5*s),y:cy+Math.sin(a)*(r-5.5*s)});
    }
    if (seal.fraction>0) g.fill([points],ink);
    g.ring(cx,cy,r-8*s,Math.max(1.2,1.5*s),ink);
    const rotate = { cx,cy,angle };
    g.text(seal.reached?'GOAL COMPLETE!':'YEARLY GOAL',cx,cy-14*s,Math.max(9.5,11*s),{ align:'center',weight:'bold',tracking:30,maxWidth:r*1.32,gray:ink,rotate });
    g.text(seal.count,cx,cy+8*s,Math.max(16,25*s),{ align:'center',weight:'bold',maxWidth:r*1.5,gray:ink,rotate });
    g.text(String(stats.year),cx,cy+29*s,Math.max(11,13*s),{ align:'center',weight:'bold',tracking:100,gray:ink,rotate });
    if (seal.reached) {
      for (let i = 0; i < 12; i++) {
        const a = i * Math.PI / 6;
        g.line(cx+Math.cos(a)*(r+4*s),cy+Math.sin(a)*(r+4*s),
          cx+Math.cos(a)*(r+9*s),cy+Math.sin(a)*(r+9*s),Math.max(2,3.2*s));
      }
      star(g,cx-r*.55,cy-r*.53,4*s,255);
      star(g,cx+r*.55,cy+r*.53,4*s,255);
    }
  }
  return g.image;
}
