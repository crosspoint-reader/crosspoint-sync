/**
 * The public landing page (served at / unless LEGACY_WEB=1). Static HTML in the
 * app's own visual language: Lora headlines, Inter text, Caveat accents, stone
 * neutrals and forest green, light and dark. The art in assets/landing is made by
 * app/store/make-assets.mjs from the real app with sample data.
 */
const GITHUB = 'https://github.com/crosspoint-reader/crosspoint-sync';
const IOS = 'https://apps.apple.com/us/app/crosspoint-sync-stats/id6824581923';
const ANDROID = 'https://play.google.com/store/apps/details?id=com.crosspointreader.sync';

// Store badges in the stores' black-pill style, logos from simple-icons.
const STORES = `<div class="stores">
<a class="store" href="${IOS}" aria-label="Download on the App Store"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/></svg><span><small>Download on the</small>App Store</span></a>
<a class="store" href="${ANDROID}" aria-label="Get it on Google Play"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M22.018 13.298l-3.919 2.218-3.515-3.493 3.543-3.521 3.891 2.202a1.49 1.49 0 0 1 0 2.594zM1.337.924a1.486 1.486 0 0 0-.112.568v21.017c0 .217.045.419.124.6l11.155-11.087L1.337.924zm12.207 10.065l3.258-3.238L3.45.195a1.466 1.466 0 0 0-.946-.179l11.04 10.973zm0 2.067l-11 10.933c.298.036.612-.016.906-.183l13.324-7.54-3.23-3.21z"/></svg><span><small>GET IT ON</small>Google Play</span></a>
</div>`;

export const SITE_DESCRIPTION =
  "Sync your e-reader's progress, highlights and reading stats to your phone, the web, Hardcover, Readwise and more. Works with CrossPoint, CrossInk and KOReader.";
// Link previews need an absolute image URL. It's brand art, so self-hosted
// servers point at the hosted copy too.
const OG_IMAGE = 'https://sync.crosspointreader.com/og.jpg';

/** Description plus Open Graph / Twitter card tags. Title and description are trusted literals. */
export const metaTags = (title: string, description = SITE_DESCRIPTION) =>
  `<meta name="description" content="${description}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="CrossPoint Sync">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${description}">
<meta property="og:image" content="${OG_IMAGE}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="CrossPoint Sync: your reading, in sync everywhere. The CrossPoint Sync library on the web.">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${title}">
<meta name="twitter:description" content="${description}">
<meta name="twitter:image" content="${OG_IMAGE}">`;

// The services it syncs with, as [icon id, name], in ring order.
const SERVICES = [
  ['hardcover', 'Hardcover'], ['bookfusion', 'BookFusion'], ['readwise', 'Readwise'], ['spotify', 'Spotify'], ['microblog', 'Micro.blog'],
  ['audiobookshelf', 'Audiobookshelf'], ['jellyfin', 'Jellyfin'], ['bookorbit', 'BookOrbit'], ['seekquel', 'Seekquel'], ['readest', 'Readest'],
];
// Hero art: the service icons on a slowly turning ring, each joined to its neighbours and
// to the icon three places round, with dots marching along the lines.
const RING = 36; // ring radius, in percent of the tile
const ringAt = SERVICES.map((_, i) => {
  const a = (i / SERVICES.length - 0.25) * 2 * Math.PI;
  return [50 + RING * Math.cos(a), 50 + RING * Math.sin(a)].map((v) => v.toFixed(2));
});
const ringArt = (basePath: string) => `<div class="ring" role="img" aria-label="The services CrossPoint Sync connects, joined in a ring: ${SERVICES.map(([, name]) => name).join(', ')}">
<div class="ring-orbit">
  <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="${RING}"/><path d="${ringAt.map(([x, y], i) => `M${x} ${y}L${ringAt[(i + 3) % ringAt.length].join(' ')}`).join('')}"/></svg>
  <ul>${SERVICES.map(([icon], i) => `<li style="left:${ringAt[i][0]}%;top:${ringAt[i][1]}%;--i:${i}"><img src="${basePath}/icons/${icon}.png" alt="" width="56" height="56"></li>`).join('')}</ul>
</div></div>`;

const STYLE = `
:root{
  color-scheme:light;
  --page:#faf8f3;--surface:#ffffff;--ink:#242820;--text:#41483d;--soft:#555b50;--line:#e7e5e4;--wash:#ebe7de;
  --brand:#4a7a62;--brand-ink:#3d6652;--brand-wash:#f0f5f3;--brand-line:#d6e5de;
  /* Print-style surfaces shared with crosspointreader.com: tinted panels, white-framed
     screenshots with a hard offset shadow. */
  --panel:#e7e7dc;--ring:#c8c9bb;--frame:#fff;--frame-shadow:#d4d5c7;
}
:root[data-theme="dark"]{
  color-scheme:dark;
  --page:#121110;--surface:#1b1917;--ink:#f3f0ed;--text:#d3cec9;--soft:#a09993;--line:#2e2a27;--wash:#221f1d;
  --brand:#4f8268;--brand-ink:#8fb9a6;--brand-wash:#16211c;--brand-line:#284738;
  --panel:#1b1917;--ring:#3a3531;--frame:#2e2a27;--frame-shadow:#060505;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;scroll-behavior:smooth}
@media (prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
body{margin:0;background:var(--page);color:var(--text);font:16px/1.6 "InterVariable",ui-sans-serif,system-ui,sans-serif;
  font-feature-settings:"cv02","cv03","cv04","cv11";-webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit;text-decoration:none}
a:focus-visible,button:focus-visible{outline:2px solid var(--brand-ink);outline-offset:4px}
p{text-wrap:pretty}
img{display:block;width:100%;height:auto}
.wrap{max-width:1280px;margin:0 auto;padding:0 32px}
@media (max-width:640px){.wrap{padding:0 22px}}
h1,h2,h3{font-family:"Lora",ui-serif,serif;color:var(--ink);font-weight:400;letter-spacing:-.045em;text-wrap:balance;margin:0}
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

.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;height:44px;padding:0 16px;border-radius:4px;
  font-size:14px;font-weight:600;white-space:nowrap;transition:transform .15s,background .15s}
.btn:active{transform:scale(.98)}
.btn.primary{background:#315243;color:#fff}
.btn.primary:hover{background:#253e33}
/* The light-theme green in both themes: the dark theme's lifted green is under 4.5:1 with white text. */
:root[data-theme="dark"] .btn.primary{background:#4a7a62}
:root[data-theme="dark"] .btn.primary:hover{background:#3a6451}
.btn.ghost{color:var(--ink);box-shadow:inset 0 0 0 1px var(--ring);background:var(--page)}
.btn.ghost:hover{background:var(--wash)}
nav .btn{height:38px;padding:0 16px;font-size:14px}
.stores{display:flex;gap:10px;margin-top:16px;flex-wrap:wrap}
.hero .stores{margin-top:32px}
.store{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 14px 0 12px;border-radius:9px;background:#000;color:#fff;
  box-shadow:inset 0 0 0 1px #a6a6a6;transition:transform .15s}
.store:active{transform:scale(.98)}
.store svg{width:24px;height:24px;fill:currentColor;flex:none}
.store span{display:flex;flex-direction:column;font-size:18px;font-weight:600;line-height:1.05;letter-spacing:-.01em}
.store small{font-size:10px;font-weight:500;letter-spacing:.01em}

/* hero */
.hero{display:grid;grid-template-columns:1fr;gap:48px;padding-block:56px 72px;align-items:center}
.hero .eyebrow{font-size:24px;transform:rotate(-2deg);display:inline-block}
.hero h1{font-size:clamp(2.2rem,5.2vw,4.75rem);line-height:1.25;margin-top:6px}
.u{position:relative;white-space:nowrap}
.u::after{content:"";position:absolute;left:-2%;right:-2%;bottom:-6px;height:14px;
  background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 12' preserveAspectRatio='none'%3E%3Cpath d='M2 8 C 45 2, 80 11, 120 6 S 188 3, 198 7' stroke='%234a7a62' stroke-width='3' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") bottom/100% 100% no-repeat}
.hero p.sub{font-size:18px;line-height:1.8;color:var(--soft);max-width:30rem;margin:22px 0 0}
@media (min-width:900px){.hero{grid-template-columns:1fr 1fr;gap:65px;padding-block:72px 64px}}
.art{border-radius:12px}
/* Hero ring (ringArt). The orbit turns; each icon turns back by the same amount to stay upright. */
.ring{position:relative;aspect-ratio:1;overflow:hidden;border-radius:12px;background:radial-gradient(120% 80% at 50% 0%,#315243,#1a2c24)}
.ring-orbit,.ring svg{position:absolute;inset:0}
.ring svg{width:100%;height:100%;fill:none;stroke:rgb(179 207 194/.5);stroke-width:1.5;stroke-dasharray:2 9;stroke-linecap:round}
.ring svg *{vector-effect:non-scaling-stroke}
.ring ul{margin:0;padding:0;list-style:none}
.ring li{position:absolute;display:grid;place-items:center;width:17%;aspect-ratio:1;translate:-50% -50%;border-radius:50%;background:#fff;
  box-shadow:0 10px 24px rgb(0 0 0/.3)}
.ring li img{width:56%;height:auto;border-radius:24%}
@media (prefers-reduced-motion:no-preference){
  .ring-orbit{animation:ring-turn 120s linear infinite}
  .ring li{animation:ring-turn 120s linear infinite reverse,ring-pulse 5s ease-in-out infinite;animation-delay:0s,calc(var(--i)*.5s)}
  .ring svg{animation:ring-march 1.2s linear infinite}
  @keyframes ring-turn{to{rotate:360deg}}
  @keyframes ring-pulse{0%,20%,100%{scale:1}10%{scale:1.1}}
  @keyframes ring-march{to{stroke-dashoffset:-11}}
}

/* The services by name, drifting under the hero. Three copies so the loop never shows a gap. */
.names{padding-bottom:72px}
.names-window{overflow:hidden;mask-image:linear-gradient(to right,transparent,#000 8%,#000 92%,transparent)}
.names-track{display:flex;width:max-content;animation:names-drift 60s linear infinite}
.names-window:hover .names-track{animation-play-state:paused}
.names ul{display:flex;flex:none;margin:0;padding:0;list-style:none}
.names li{font:400 1.6rem/1.6 "Lora",serif;letter-spacing:-.03em;color:var(--soft);white-space:nowrap}
.names li::after{content:"\\00b7";margin:0 22px;color:var(--ring)}
@keyframes names-drift{to{transform:translateX(-33.3333%)}}
@media (prefers-reduced-motion:reduce){
  .names-window{mask-image:none}
  .names-track{animation:none;width:auto}
  .names ul{flex-wrap:wrap;justify-content:center;flex:1}
  .names ul[aria-hidden]{display:none}
}

/* sections: heading left, short paragraph right, as on the main site */
section{padding:88px 0}
section.tight{padding-top:24px}
h2{font-size:clamp(2.25rem,3.8vw,3.5rem);line-height:1.25}
.lead p{font-size:15px;line-height:1.8;color:var(--soft);max-width:340px;margin:16px 0 0}
@media (min-width:641px){.lead{display:flex;justify-content:space-between;align-items:end;gap:36px}.lead p{margin:0}}
/* feature cards: a generated art tile with its copy underneath */
.cards{display:grid;gap:56px 20px;margin-top:40px}
.card h3{font-size:2rem;line-height:1.2;margin-top:26px}
.card p{font-size:14px;line-height:1.8;color:var(--soft);max-width:440px;margin:12px 0 0}
@media (min-width:900px){
  .cards{grid-template-columns:1fr 1fr}
  .card.big{grid-column:1/-1;display:grid;grid-template-columns:1fr 1fr;gap:0 20px}
  .card.big .art{grid-column:1/-1}
}

/* dark green band: how it works, as numbered steps */
section.band{padding:0;background:#243c31;color:#f5f2e9}
.band .wrap{display:grid;gap:40px;padding-block:65px}
.band h2{color:inherit;font-size:clamp(3rem,4.5vw,4.5rem)}
.band .copy p{max-width:420px;margin:24px 0;line-height:1.8;color:#e0e5da}
.textlink{font-size:13px;font-weight:600;text-underline-offset:5px}
.textlink:hover{text-decoration:underline}
.steps{list-style:none;margin:0;padding:0;counter-reset:step}
.steps li{display:grid;grid-template-columns:3.4rem 1fr;gap:20px;padding:22px 0;border-top:1px solid rgb(245 242 233/.18);counter-increment:step}
.steps li:last-child{border-bottom:1px solid rgb(245 242 233/.18)}
.steps li::before{content:"0" counter(step);font:400 2.6rem/1 "Lora",serif;letter-spacing:-.045em;color:#8fb9a6}
.steps h3{color:inherit;font-size:1.45rem}
.steps p{margin:6px 0 0;font-size:14px;line-height:1.7;color:#bdc9bd}
@media (min-width:900px){.band .wrap{grid-template-columns:1fr 1fr;gap:80px;align-items:center}}

/* self-hosting: the actual command */
.pair{display:grid;gap:40px;align-items:center}
.pair>*{min-width:0} /* lets the code block scroll instead of widening the page */
.pair .copy p{font-size:15px;line-height:1.8;color:var(--soft);max-width:430px;margin:24px 0 0}
.pair .cta{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}
.pair .hand{display:inline-block;font-size:22px;transform:rotate(-2deg);margin-bottom:10px}
.code{margin:0;padding:28px;background:#1a2c24;color:#e0e5da;font:13px/1.9 "Geist Mono",ui-monospace,monospace;overflow-x:auto;
  border-radius:12px;box-shadow:8px 12px 0 var(--frame-shadow)}
.code b{font-weight:500;color:#8fb9a6}
@media (min-width:900px){.pair{grid-template-columns:1fr 1fr;gap:80px}.pair.flip .copy{order:2}}
/* CrossPaper: the edition's cover as the reader draws it, in the print frame */
.paper{display:grid;place-items:center;padding:48px 24px;background:var(--panel)}
.paper img{width:min(260px,70%);border:7px solid var(--frame);border-radius:12px;box-shadow:8px 12px 0 var(--frame-shadow)}

.points{list-style:none;padding:0;margin:18px 0 0;display:grid;gap:8px;font-size:13px}
.points li{display:flex;gap:12px;color:var(--text)}
.points li::before{content:"";flex:0 0 18px;height:18px;margin-top:1px;border-radius:50%;
  /* Lucide's check glyph. */
  background:var(--brand-wash) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%234a7a62' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/11px no-repeat;
  box-shadow:inset 0 0 0 1px var(--brand-line)}

/* closing row, as on the main site */
.start{display:flex;justify-content:space-between;align-items:center;gap:32px;flex-wrap:wrap;padding-block:50px;border-top:1px solid var(--line)}
.start h2{font-size:2rem}
.start .stores{margin:0}
footer{border-top:1px solid var(--line);padding:28px 0 40px;color:var(--soft);font-size:14px}
footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
footer a:hover{color:var(--ink)}
.footer-actions{display:flex;align-items:center;gap:20px}
#theme-toggle{font:inherit;color:var(--ink);border:1px solid var(--line);background:var(--surface);border-radius:6px;min-height:44px;padding:0 14px;cursor:pointer}
#theme-toggle:hover{background:var(--wash)}

@media (prefers-reduced-motion:no-preference){
  .hero .copy,.ring{animation:rise .7s cubic-bezier(.16,1,.3,1) both}
  .ring{animation-delay:.12s}
  @keyframes rise{from{opacity:0;transform:translateY(16px)}}
}
`;

export function landingPage(fontFaces: string, basePath = ''): string {
  const names = SERVICES.map(([, name]) => `<li>${name}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CrossPoint Sync: Your reading, in sync everywhere</title>
${metaTags('CrossPoint Sync: Your reading, in sync everywhere')}
<meta name="theme-color" content="#faf8f3">
<script>
try {
  if (localStorage.getItem('crosspoint-landing-theme') === 'dark') document.documentElement.dataset.theme = 'dark';
} catch (_) {}
</script>
<link rel="icon" type="image/png" href="${basePath}/favicon.png">
<link rel="preload" href="${basePath}/fonts/inter-latin-wght-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="${basePath}/fonts/lora-latin-400-normal.woff2" as="font" type="font/woff2" crossorigin>
<style>${fontFaces}${STYLE}</style></head>
<body>
<header><div class="wrap">
  <a class="mark" href="${basePath}/"><img src="${basePath}/logo.png" alt="">CrossPoint Sync</a>
  <nav><a class="link" href="https://crosspointreader.com">CrossPoint Reader</a><a class="link" href="${GITHUB}">Self-Host Sync</a><a class="btn primary" href="${basePath}/app/">Sync Dashboard</a></nav>
</div></header>

<main>
<div class="wrap hero">
  <div class="copy">
    <span class="hand eyebrow">read on every device</span>
    <h1>Your reading, in sync <span class="u">everywhere</span></h1>
    <p class="sub">Your e-reader's progress, clippings and stats on your phone and the web, and in the services you already use.</p>
    ${STORES}
  </div>
  ${ringArt(basePath)}
</div>

<div class="wrap names" aria-label="Services CrossPoint Sync works with"><div class="names-window"><div class="names-track">
  <ul>${names}</ul><ul aria-hidden="true">${names}</ul><ul aria-hidden="true">${names}</ul>
</div></div></div>

<section><div class="wrap">
  <div class="lead"><h2>Everything you read, in one place.</h2>
    <p>Your library, highlights and reading habits, on your phone and the web.</p></div>
  <div class="cards">
    <article class="card big">
      <img class="art" src="${basePath}/landing/book.webp" alt="A book's page in the app, with its progress and its Hardcover link" width="2400" height="1200" loading="lazy">
      <div><h3>Every book, with its story</h3>
        <p>Open any book for its cover, description, moods and how long it took you.</p></div>
      <ul class="points">
        <li>Covers, descriptions and genres filled in automatically</li>
        <li>See what comes next when you finish a book in a series</li>
        <li>Mark books reading, paused, finished or did not finish</li>
      </ul>
    </article>
    <article class="card">
      <img class="art" src="${basePath}/landing/clippings.webp" alt="The clipping of the day in the app" width="1500" height="1200" loading="lazy">
      <h3>Highlights that leave the device</h3>
      <p>Every passage you highlight on your reader shows up here, searchable and ready to share.</p>
      <ul class="points">
        <li>A highlight of the day, pulled from everything you've saved</li>
        <li>Search across every book, or copy them all as Markdown</li>
        <li>Share any passage as an image card with its cover</li>
      </ul>
    </article>
    <article class="card">
      <img class="art" src="${basePath}/landing/stats.webp" alt="Pages per week in the app's reading stats" width="1500" height="1200" loading="lazy">
      <h3>See how you read</h3>
      <p>Pages per week, the days you read, and the moods and genres you keep coming back to.</p>
      <ul class="points">
        <li>Your streak, pages read and books finished</li>
        <li>A day-by-day timeline of what you read</li>
        <li>A yearly goal for books to finish</li>
      </ul>
    </article>
  </div>
</div></section>

<section><div class="wrap pair flip">
  <div class="copy"><span class="hand">new in the app</span>
    <h2>CrossPaper: your feeds as a daily EPUB</h2>
    <p>Follow RSS feeds and save pages you want to read later. Each day's edition bundles them into one EPUB for your reader.</p>
    <ul class="points">
      <li>Follow up to 30 feeds, or paste any site address</li>
      <li>Article text only: no ads, no images, no links</li>
      <li>Download an edition or send it to your reader</li>
      <li>Past editions are kept for two weeks</li>
    </ul></div>
  <div class="paper"><img src="${basePath}/landing/crosspaper.webp" alt="The front page of a CrossPaper edition, drawn for an e-ink screen" width="720" height="1200" loading="lazy"></div>
</div></section>

<section class="band" id="how"><div class="wrap">
  <div class="copy"><h2>Works with any KOSync reader</h2>
    <p>CrossPoint, CrossInk and KOReader already speak KOSync. Change one setting, the sync server address, and keep reading.</p>
    <a class="textlink" href="https://crosspointreader.com/docs#367-koreader-sync-quick-setup?doc=user_guide">Set up your reader →</a></div>
  <ol class="steps">
    <li><div><h3>Point your reader here</h3>
      <p>Sign in under KOReader Sync on CrossPoint, CrossInk or KOReader. No plugin to install.</p></div></li>
    <li><div><h3>Sync when you want to</h3>
      <p>Send your progress from KOReader Sync, then pick up on another device right where you left off.</p></div></li>
    <li><div><h3>View &amp; share in app</h3>
      <p>Your library, highlights and reading habits, on your phone and the web.</p></div></li>
  </ol>
</div></section>

<section><div class="wrap pair">
  <div class="copy"><h2>Run it here, or <span class="u">host it yourself.</span></h2>
    <p>Free to use and open source. The hosted service and self-hosted installs run the exact same thing: one Docker image.</p>
    <div class="cta"><a class="btn primary" href="${basePath}/app/">Sync Dashboard</a><a class="btn ghost" href="${GITHUB}">Self-Host Sync</a></div></div>
  <div><span class="hand">one command, your own server</span>
<pre class="code"><code><b>$</b> docker run -d --name crosspoint-sync \\
    -p 8080:8080 \\
    -v crosspoint-data:/data \\
    ghcr.io/crosspoint-reader/crosspoint-sync:main</code></pre></div>
</div></section>

<div class="wrap start"><h2>Start syncing in a minute.</h2>${STORES}</div>
</main>

<footer><div class="wrap">
  <span>CrossPoint Sync, part of <a href="https://crosspointreader.com">CrossPoint Reader</a></span>
  <div class="footer-actions"><a href="${GITHUB}">GitHub</a><button id="theme-toggle" type="button" aria-pressed="false">Dark mode</button></div>
</div></footer>
<script>
const themeToggle = document.getElementById('theme-toggle');
function applyLandingTheme() {
  const dark = document.documentElement.dataset.theme === 'dark';
  themeToggle.setAttribute('aria-pressed', String(dark));
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#121110' : '#faf8f3');
}
applyLandingTheme();
themeToggle.addEventListener('click', () => {
  const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('crosspoint-landing-theme', theme); } catch (_) {}
  applyLandingTheme();
});
</script>
</body></html>`;
}
