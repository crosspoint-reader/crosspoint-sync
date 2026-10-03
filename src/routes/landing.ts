/**
 * The public landing page (served at / unless LEGACY_WEB=1). Static HTML in the
 * app's own visual language: Lora headlines, Inter text, Caveat accents, stone
 * neutrals and forest green, light and dark. The screenshots in assets/landing
 * are the real app, captured with a seeded demo account.
 */
const GITHUB = 'https://github.com/crosspoint-reader/crosspoint-sync';

// A screenshot with its dark twin, swapped by the visitor's color scheme.
const shot = (name: string, alt: string, eager = false) =>
  `<picture><source srcset="/landing/${name}-dark.webp" media="(prefers-color-scheme: dark)">` +
  `<img src="/landing/${name}-light.webp" alt="${alt}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"></picture>`;

const phone = (name: string, alt: string, cls = '', eager = false) =>
  `<div class="phone ${cls}">${shot(name, alt, eager)}</div>`;
const browser = (name: string, alt: string, cls = '', eager = false) =>
  `<div class="browser ${cls}"><div class="bar"><span>sync.crosspointreader.com</span></div>${shot(name, alt, eager)}</div>`;
const tablet = (name: string, alt: string, cls = '') => `<div class="tablet ${cls}">${shot(name, alt)}</div>`;

const SERVICES: [string, string, string, 'ready' | 'beta'][] = [
  ['hardcover', 'Hardcover', 'Your shelf and progress stay up to date as you read.', 'ready'],
  ['bookfusion', 'BookFusion', 'Reading positions both ways for books from BookFusion.', 'ready'],
  ['kosync', 'Another KOSync server', 'Mirror your place to sync.koreader.rocks or your own server.', 'ready'],
  ['readwise', 'Readwise', 'Send the passages you highlight to Readwise.', 'ready'],
  ['readwise', 'Readwise Reader', 'Archive finished books and bring Reader progress back.', 'ready'],
  ['microblog', 'Micro.blog', 'Keep your Currently reading and Finished shelves current.', 'ready'],
  ['audiobookshelf', 'Audiobookshelf', 'Switch between the ebook and the audiobook without losing your place.', 'ready'],
  ['bookorbit', 'BookOrbit', 'Two-way progress with your own library, clippings as highlights.', 'beta'],
];

const STYLE = `
:root{
  color-scheme:light dark;
  --page:#fafaf9;--surface:#ffffff;--ink:#1c1917;--text:#44403c;--soft:#78716c;--line:#e7e5e4;--wash:#f5f5f4;
  --brand:#4a7a62;--brand-ink:#3d6652;--brand-wash:#f0f5f3;--brand-line:#d6e5de;--bezel:#1c1917;
  --shadow:0 30px 60px -24px rgba(41,37,36,.35),0 12px 24px -16px rgba(41,37,36,.25);
}
@media (prefers-color-scheme:dark){:root{
  --page:#121110;--surface:#1b1917;--ink:#f3f0ed;--text:#d3cec9;--soft:#a09993;--line:#2e2a27;--wash:#221f1d;
  --brand:#4f8268;--brand-ink:#8fb9a6;--brand-wash:#16211c;--brand-line:#284738;--bezel:#2e2a27;
  --shadow:0 30px 60px -24px rgba(0,0,0,.7),0 12px 24px -16px rgba(0,0,0,.6);
}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
body{margin:0;background:var(--page);color:var(--text);font:16px/1.6 "InterVariable",ui-sans-serif,system-ui,sans-serif;
  font-feature-settings:"cv02","cv03","cv04","cv11";-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit;text-decoration:none}
img{display:block;width:100%;height:auto}
.wrap{max-width:72rem;margin:0 auto;padding:0 20px}
h1,h2,h3{font-family:"Lora",ui-serif,serif;color:var(--ink);font-weight:600;letter-spacing:-.015em;margin:0}
.hand{font-family:"Caveat",cursive;font-weight:600;color:var(--brand-ink)}

/* header */
header{position:sticky;top:0;z-index:20;background:color-mix(in srgb,var(--page) 85%,transparent);backdrop-filter:blur(12px);
  border-bottom:1px solid color-mix(in srgb,var(--line) 70%,transparent)}
header .wrap{display:flex;align-items:center;justify-content:space-between;height:64px}
.mark{display:flex;align-items:center;gap:10px;font:600 17px "Lora",serif;color:var(--ink);white-space:nowrap}
@media (max-width:520px){nav a.link{display:none}}
.mark img{width:30px;height:30px;border-radius:8px}
nav{display:flex;align-items:center;gap:6px}
nav a.link{padding:8px 12px;border-radius:999px;font-size:14px;font-weight:500;color:var(--soft)}
nav a.link:hover{color:var(--ink);background:var(--wash)}

.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 20px;border-radius:999px;
  font-size:15px;font-weight:600;white-space:nowrap;transition:transform .15s,background .15s}
.btn:active{transform:scale(.98)}
.btn.primary{background:var(--brand);color:#fff}
.btn.primary:hover{background:var(--brand-ink)}
/* The light-theme green in both themes: the dark theme's lifted green is under 4.5:1 with white text. */
@media (prefers-color-scheme:dark){.btn.primary{background:#4a7a62}.btn.primary:hover{background:#3a6451}}
.btn.ghost{color:var(--ink);box-shadow:inset 0 0 0 1px var(--line);background:var(--surface)}
.btn.ghost:hover{background:var(--wash)}
nav .btn{height:38px;padding:0 16px;font-size:14px}

/* device frames */
.phone{background:var(--bezel);border-radius:24px;padding:6px;box-shadow:var(--shadow),inset 0 0 0 1px rgba(255,255,255,.06)}
.phone img{border-radius:18px;aspect-ratio:390/844;object-fit:cover;object-position:top}
.tablet{background:var(--bezel);border-radius:20px;padding:10px;box-shadow:var(--shadow)}
.tablet img{border-radius:10px;aspect-ratio:1100/820;object-fit:cover;object-position:top}
.browser{border-radius:14px;overflow:hidden;background:var(--surface);box-shadow:var(--shadow),0 0 0 1px var(--line)}
.browser .bar{display:flex;align-items:center;justify-content:center;height:34px;padding:0 14px;background:var(--wash);border-bottom:1px solid var(--line)}
.browser .bar span{padding:2px 12px;border-radius:999px;background:var(--surface);font:12px "Geist Mono",monospace;color:var(--soft)}
.browser img{aspect-ratio:1280/800;object-fit:cover;object-position:top}
.browser.short img{aspect-ratio:1280/660}

/* hero */
.hero{display:grid;grid-template-columns:1fr;gap:48px;padding-block:56px 72px;align-items:center}
.hero .eyebrow{font-size:24px;transform:rotate(-2deg);display:inline-block}
.hero h1{font-size:clamp(40px,5vw,58px);line-height:1.05;margin-top:6px}
.hero h1 .u{position:relative;white-space:nowrap}
.hero h1 .u::after{content:"";position:absolute;left:-2%;right:-2%;bottom:-6px;height:14px;
  background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 12' preserveAspectRatio='none'%3E%3Cpath d='M2 8 C 45 2, 80 11, 120 6 S 188 3, 198 7' stroke='%234a7a62' stroke-width='3' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") bottom/100% 100% no-repeat}
.hero p.sub{font-size:19px;line-height:1.55;color:var(--soft);max-width:30rem;margin:22px 0 0}
.hero .cta{display:flex;gap:12px;margin-top:32px;flex-wrap:wrap}
.hero .stage{position:relative;padding:0 0 40px}
.hero .stage .browser{display:none}
.hero .stage .phone{width:min(300px,78vw);margin:0 auto}
@media (min-width:900px){
  .hero{grid-template-columns:1fr 1.1fr;padding-block:72px 96px}
  .hero .stage{padding:0 0 60px 60px}
  .hero .stage .browser{display:block}
  .hero .stage .phone{position:absolute;left:0;bottom:0;width:27%;margin:0}
}

/* sections */
section{padding:88px 0}
section.tight{padding-top:24px}
.lead h2{font-size:clamp(30px,4vw,44px);line-height:1.1}
.lead p{font-size:18px;color:var(--soft);max-width:34rem;margin:16px 0 0}
.steps{display:grid;gap:32px;margin-top:8px}
.step{border-top:1px solid var(--line);padding-top:20px}
.step h3{font-size:21px;margin-top:2px}
.step p{margin:8px 0 0;color:var(--soft)}
@media (min-width:800px){.steps{grid-template-columns:repeat(3,1fr)}}

.split{display:grid;gap:56px;align-items:center}
.split .points{list-style:none;padding:0;margin:28px 0 0;display:grid;gap:14px}
.split .points li{display:flex;gap:12px;color:var(--text)}
.split .points li::before{content:"";flex:0 0 18px;height:18px;margin-top:4px;border-radius:50%;
  /* Lucide's check glyph. */
  background:var(--brand-wash) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%234a7a62' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/11px no-repeat;
  box-shadow:inset 0 0 0 1px var(--brand-line)}
.duo{position:relative;padding:0 0 48px}
.duo .phone{width:min(280px,72vw);margin:0 auto}
.duo .tablet{display:none}
@media (min-width:900px){
  .split{grid-template-columns:1fr 1.2fr}
  .split.flip{grid-template-columns:1.2fr 1fr}
  .split.flip .copy{order:2}
  .duo .tablet{display:block}
  .duo.with-tablet .phone{position:absolute;right:-12px;bottom:0;width:34%;margin:0}
}
.solo .phone{width:min(300px,76vw);margin:0 auto}

.wide{position:relative;margin-top:48px}
.wide .browser{display:none}
.wide .phone{width:min(300px,76vw);margin:0 auto}
@media (min-width:900px){
  .wide{padding-right:120px}
  .wide .browser{display:block}
  .wide .phone{position:absolute;right:0;bottom:-48px;width:23%;margin:0}
}

/* services */
.services{display:grid;gap:12px;margin-top:40px}
@media (min-width:760px){.services{grid-template-columns:1fr 1fr}}
.svc{display:flex;gap:14px;align-items:flex-start;padding:18px;border-radius:12px;background:var(--surface);box-shadow:0 0 0 1px var(--line)}
.svc img{width:40px;height:40px;border-radius:10px;flex:0 0 auto;background:#fff}
.svc .name{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--ink)}
.svc .desc{font-size:14px;color:var(--soft);margin-top:2px;line-height:1.5}
.pill{font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em;
  color:#8a6a1c;background:#faf5e6;box-shadow:inset 0 0 0 1px #ecdcae}
@media (prefers-color-scheme:dark){.pill{color:#e5c97a;background:#2a2412;box-shadow:inset 0 0 0 1px #4a3f1c}}

/* closing */
.closing{text-align:center;padding-block:96px 72px}
.closing h2{font-size:clamp(32px,4.5vw,48px)}
.closing p{color:var(--soft);font-size:18px;margin:14px auto 0;max-width:30rem}
.closing .cta{display:flex;gap:12px;justify-content:center;margin-top:28px;flex-wrap:wrap}
footer{border-top:1px solid var(--line);padding:28px 0 40px;color:var(--soft);font-size:14px}
footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
footer a:hover{color:var(--ink)}

@media (prefers-reduced-motion:no-preference){
  .hero .copy,.hero .stage{animation:rise .7s cubic-bezier(.16,1,.3,1) both}
  .hero .stage{animation-delay:.12s}
  @keyframes rise{from{opacity:0;transform:translateY(16px)}}
}
`;

export function landingPage(fontFaces: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CrossPoint Sync: your reading, in sync everywhere</title>
<meta name="description" content="A KOReader-compatible sync server for your e-reader, with an app for your library, clippings and reading stats.">
<meta name="theme-color" content="#fafaf9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#121110" media="(prefers-color-scheme: dark)">
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="preload" href="/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/lora-latin-600-normal.woff2" as="font" type="font/woff2" crossorigin>
<style>${fontFaces}${STYLE}</style></head>
<body>
<header><div class="wrap">
  <a class="mark" href="/"><img src="/logo.png" alt="">CrossPoint Sync</a>
  <nav><a class="link" href="${GITHUB}">Self-host</a><a class="btn primary" href="/app/">Get started</a></nav>
</div></header>

<main>
<div class="wrap hero">
  <div class="copy">
    <span class="hand eyebrow">read on every device</span>
    <h1>Your reading, in sync <span class="u">everywhere</span></h1>
    <p class="sub">Your e-reader's progress, clippings and stats on your phone and the web, and in the services you already use.</p>
    <div class="cta"><a class="btn primary" href="/app/">Get started</a><a class="btn ghost" href="#how">How it works</a></div>
  </div>
  <div class="stage">
    ${browser('desktop-library', 'The CrossPoint Sync library on the web', '', true)}
    ${phone('phone-timeline', 'Your reading timeline in the CrossPoint Sync app', '', true)}
  </div>
</div>

<section id="how" class="tight"><div class="wrap">
  <div class="lead"><h2>Nothing new to learn</h2>
    <p>It speaks KOSync, the protocol your reader already has. Point it here and keep reading.</p></div>
  <div class="steps">
    <div class="step"><h3>Point your reader here</h3>
      <p>Sign in under KOReader Sync on CrossPoint, CrossInk or KOReader. No plugin to install.</p></div>
    <div class="step"><h3>Just read</h3>
      <p>Your place syncs as you read, so any device picks up where you left off.</p></div>
    <div class="step"><h3>Open the app</h3>
      <p>Your library, highlights and reading habits, on your phone and the web.</p></div>
  </div>
</div></section>

<section><div class="wrap split">
  <div class="copy lead">
    <h2>Every book, with its story</h2>
    <p>Open any book for its cover, description, moods and how long it took you.</p>
    <ul class="points">
      <li>Covers, descriptions and genres filled in automatically</li>
      <li>See what comes next when you finish a book in a series</li>
      <li>Mark books reading, paused, finished or did not finish</li>
    </ul>
  </div>
  <div class="duo with-tablet">
    ${tablet('tablet-book', 'The Three-Body Problem on a tablet: its cover, stats and description')}
    ${phone('phone-book-details', 'Moods, genres and the next book in the series')}
  </div>
</div></section>

<section><div class="wrap split flip">
  <div class="copy lead">
    <h2>Highlights that leave the device</h2>
    <p>Every passage you highlight on your reader shows up here, searchable and ready to share.</p>
    <ul class="points">
      <li>A highlight of the day, pulled from everything you've saved</li>
      <li>Search across every book, or copy them all as Markdown</li>
      <li>Share any passage as an image card with its cover</li>
    </ul>
  </div>
  <div class="solo">
    ${phone('phone-clippings', 'Clippings in the app')}
  </div>
</div></section>

<section><div class="wrap">
  <div class="lead"><h2>See how you read</h2>
    <p>Pages per week, the days you read, and the moods and genres you keep coming back to.</p></div>
  <div class="wide">
    ${browser('desktop-calendar', 'Reading stats on the web: moods, genres and a year of reading days', 'short')}
    ${phone('phone-stats', 'Mood and genre stats in the app')}
  </div>
</div></section>

<section><div class="wrap">
  <div class="lead"><h2>Your reading, everywhere it lives</h2>
    <p>Link the services you already use. Progress and highlights flow out as you read.</p></div>
  <div class="services">
    ${SERVICES.map(
      ([icon, name, desc, state]) =>
        `<div class="svc"><img src="/icons/${icon}.png" alt="" width="40" height="40" loading="lazy"><div>` +
        `<div class="name">${name}${state === 'beta' ? '<span class="pill">beta</span>' : ''}</div><div class="desc">${desc}</div></div></div>`
    ).join('')}
  </div>
</div></section>

<div class="wrap closing">
  <h2>Start syncing in a minute</h2>
  <p>Free to use and open source. Run it here, or on your own server with one Docker image.</p>
  <div class="cta"><a class="btn primary" href="/app/">Get started</a><a class="btn ghost" href="${GITHUB}">Self-host</a></div>
</div>
</main>

<footer><div class="wrap">
  <span>CrossPoint Sync, part of <a href="https://crosspointreader.com">CrossPoint Reader</a></span>
  <span><a href="${GITHUB}">GitHub</a></span>
</div></footer>
</body></html>`;
}
