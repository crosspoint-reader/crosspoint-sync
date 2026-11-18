/**
 * The public landing page (served at / unless LEGACY_WEB=1). Static HTML in the
 * app's own visual language: Lora headlines, Inter text, Caveat accents, stone
 * neutrals and forest green, light and dark. The screenshots in assets/landing
 * are the real app, captured with a seeded demo account.
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

const SERVICES: [string, string, string, 'ready' | 'beta'][] = [
  ['hardcover', 'Hardcover', 'Your shelf and progress update each time you sync.', 'ready'],
  ['bookfusion', 'BookFusion', 'Reading positions both ways for books from BookFusion.', 'ready'],
  ['readwise', 'Readwise', 'Sync reading progress both ways with matched books in Readwise Reader.', 'ready'],
  ['spotify', 'Spotify', 'Listen ahead in the audiobook and your progress moves forward. Resume it in one tap.', 'beta'],
  ['microblog', 'Micro.blog', 'Keep your Currently reading and Finished shelves current.', 'ready'],
  ['audiobookshelf', 'Audiobookshelf', 'Switch between the ebook and the audiobook without losing your place.', 'ready'],
  ['jellyfin', 'Jellyfin', 'Keep your place in sync with books on your Jellyfin server.', 'beta'],
  ['bookorbit', 'BookOrbit', 'Two-way progress with your own library, clippings as highlights.', 'beta'],
  ['seekquel', 'Seekquel', 'Log your progress, finished books and highlights in your Seekquel library.', 'beta'],
  ['readest', 'Readest', 'Two-way progress and highlights with the Readest app.', 'beta'],
];

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
.closing .stores{justify-content:center}
.store{display:inline-flex;align-items:center;gap:8px;height:44px;padding:0 14px 0 12px;border-radius:9px;background:#000;color:#fff;
  box-shadow:inset 0 0 0 1px #a6a6a6;transition:transform .15s}
.store:active{transform:scale(.98)}
.store svg{width:24px;height:24px;fill:currentColor;flex:none}
.store span{display:flex;flex-direction:column;font-size:18px;font-weight:600;line-height:1.05;letter-spacing:-.01em}
.store small{font-size:10px;font-weight:500;letter-spacing:.01em}

/* Screenshots: a tinted panel holding one wide shot and one phone shot, each in a
   white frame with a hard offset shadow (the main site's .reader-screenshot). */
.screens{position:relative;aspect-ratio:1.25;background:var(--panel);border-radius:12px}
.shot{position:absolute}
.shot img{border:7px solid var(--frame);border-radius:12px;box-shadow:8px 12px 0 var(--frame-shadow);object-fit:cover;object-position:top}
.shot.wide{width:86%;top:10%;left:5%}
.shot.wide img{aspect-ratio:1280/800}
.shot.wide.tab{width:74%}
.shot.wide.tab img{aspect-ratio:1100/820}
.shot.wide.short img{aspect-ratio:1280/660}
.shot.tall{width:27%;right:6%;bottom:7%}
.shot.tall img{aspect-ratio:390/844}
.shot.tall.solo{width:30%;left:35%;right:auto;top:9%;bottom:auto}
@media (max-width:640px){.shot img{border-width:4px;box-shadow:5px 7px 0 var(--frame-shadow)}}

/* hero */
.hero{display:grid;grid-template-columns:1fr;gap:48px;padding-block:56px 72px;align-items:center}
.hero .eyebrow{font-size:24px;transform:rotate(-2deg);display:inline-block}
.hero h1{font-size:clamp(2.2rem,5.2vw,4.75rem);line-height:1.25;margin-top:6px}
.hero h1 .u{position:relative;white-space:nowrap}
.hero h1 .u::after{content:"";position:absolute;left:-2%;right:-2%;bottom:-6px;height:14px;
  background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 12' preserveAspectRatio='none'%3E%3Cpath d='M2 8 C 45 2, 80 11, 120 6 S 188 3, 198 7' stroke='%234a7a62' stroke-width='3' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") bottom/100% 100% no-repeat}
.hero p.sub{font-size:18px;line-height:1.8;color:var(--soft);max-width:30rem;margin:22px 0 0}
@media (min-width:900px){.hero{grid-template-columns:1fr 1fr;gap:65px;padding-block:72px 96px}}

/* sections: heading left, short paragraph right, as on the main site */
section{padding:88px 0}
section.tight{padding-top:24px}
h2{font-size:clamp(2.25rem,3.8vw,3.5rem);line-height:1.25}
.lead p{font-size:15px;line-height:1.8;color:var(--soft);max-width:340px;margin:16px 0 0}
@media (min-width:641px){.lead{display:flex;justify-content:space-between;align-items:end;gap:36px}.lead p{margin:0}}
.steps{display:grid;gap:32px;margin-top:40px}
.step{border-top:1px solid var(--line);padding-top:20px}
.step h3{font-size:21px;margin-top:2px}
.step p{margin:8px 0 0;color:var(--soft)}
@media (min-width:800px){.steps{grid-template-columns:repeat(3,1fr)}}

/* Feature sections: copy beside a screenshot panel, alternating sides. */
.split{display:grid;gap:40px;align-items:center}
.split .copy p{font-size:15px;line-height:1.8;color:var(--soft);max-width:430px;margin:16px 0 0}
@media (min-width:900px){
  .split{grid-template-columns:1fr 1.25fr;gap:80px}
  .split.flip{grid-template-columns:1.25fr 1fr}
  .split.flip .copy{order:2}
}
.points{list-style:none;padding:0;margin:24px 0 0;display:grid;gap:12px;font-size:15px}
.points li{display:flex;gap:12px;color:var(--text)}
.points li::before{content:"";flex:0 0 18px;height:18px;margin-top:2px;border-radius:50%;
  /* Lucide's check glyph. */
  background:var(--brand-wash) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%234a7a62' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center/11px no-repeat;
  box-shadow:inset 0 0 0 1px var(--brand-line)}

/* Integrations hub: a slow marquee of the service icons.
   Three copies of the list so the loop never shows a gap inside .wrap. */
.hub{position:relative;margin-top:40px;overflow:hidden;mask-image:linear-gradient(to right,transparent,#000 8%,#000 92%,transparent)}
.hub-track{display:flex;width:max-content;padding-block:8px;animation:hub-drift 60s linear infinite}
.hub:hover .hub-track{animation-play-state:paused}
.hub ul{display:flex;gap:16px;margin:0;padding:0 16px 0 0;list-style:none;flex:none}
.hub li{display:grid;place-items:center;width:100px;height:100px;border-radius:50%;background:var(--surface);box-shadow:inset 0 0 0 1px var(--line)}
.hub li img{width:56px;height:56px;border-radius:14px}
@keyframes hub-drift{to{transform:translateX(-33.3333%)}}
@media (prefers-reduced-motion:reduce){
  .hub{mask-image:none}
  .hub-track{animation:none;width:auto}
  .hub ul{flex-wrap:wrap;justify-content:center;padding:0;flex:1}
  .hub ul[aria-hidden]{display:none}
}
.more{margin-top:28px}
.more summary{display:flex;width:fit-content;margin:0 auto;cursor:pointer;list-style:none}
@media (max-width:640px){
  .hub li{width:72px;height:72px}
  .hub li img{width:40px;height:40px;border-radius:10px}
}
.more summary::-webkit-details-marker{display:none}

/* services */
.services{display:grid;gap:12px;margin-top:28px}
@media (min-width:760px){.services{grid-template-columns:1fr 1fr}}
.svc{display:flex;gap:14px;align-items:flex-start;padding:24px;border-radius:6px;background:var(--panel)}
.svc img{width:40px;height:40px;border-radius:10px;flex:0 0 auto}
.svc .name{display:flex;align-items:center;gap:8px;font-weight:600;color:var(--ink)}
.svc .desc{font-size:14px;color:var(--soft);margin-top:2px;line-height:1.5}
.pill{font-size:11px;font-weight:600;padding:1px 8px;border-radius:999px;text-transform:uppercase;letter-spacing:.04em;
  color:#8a6a1c;background:#faf5e6;box-shadow:inset 0 0 0 1px #ecdcae}
:root[data-theme="dark"] .pill{color:#e5c97a;background:#2a2412;box-shadow:inset 0 0 0 1px #4a3f1c}

/* closing */
.closing{text-align:center;padding-block:96px 72px}
.closing h2{font-size:clamp(32px,4.5vw,48px)}
.closing p{color:var(--soft);font-size:18px;margin:14px auto 0;max-width:30rem}
.closing .cta{display:flex;gap:12px;justify-content:center;margin-top:28px;flex-wrap:wrap}
footer{border-top:1px solid var(--line);padding:28px 0 40px;color:var(--soft);font-size:14px}
footer .wrap{display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
footer a:hover{color:var(--ink)}
.footer-actions{display:flex;align-items:center;gap:20px}
#theme-toggle{font:inherit;color:var(--ink);border:1px solid var(--line);background:var(--surface);border-radius:6px;min-height:44px;padding:0 14px;cursor:pointer}
#theme-toggle:hover{background:var(--wash)}

@media (prefers-reduced-motion:no-preference){
  .hero .copy,.hero .stage{animation:rise .7s cubic-bezier(.16,1,.3,1) both}
  .hero .stage{animation-delay:.12s}
  @keyframes rise{from{opacity:0;transform:translateY(16px)}}
}
`;

export function landingPage(fontFaces: string, basePath = ''): string {
  // Dark screenshots follow the explicit landing-page preference.
  // cls: "wide" (desktop/tablet shot) or "tall" (phone shot), placed inside a .screens panel.
  const shot = (name: string, alt: string, cls: string, eager = false) =>
    `<div class="shot ${cls}"><picture><source srcset="${basePath}/landing/${name}-dark.webp" media="not all">` +
    `<img src="${basePath}/landing/${name}-light.webp" alt="${alt}"${eager ? ' fetchpriority="high"' : ' loading="lazy"'} decoding="async"></picture></div>`;
  const hubIcons = SERVICES.map(
    ([icon, name]) => `<li><img src="${basePath}/icons/${icon}.png" alt="${name}" width="56" height="56" loading="lazy"></li>`
  ).join('');
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
  <div class="screens">
    ${shot('desktop-library', 'The CrossPoint Sync library on the web', 'wide', true)}
    ${shot('phone-timeline', 'Your reading timeline in the CrossPoint Sync app', 'tall', true)}
  </div>
</div>

<section class="tight"><div class="wrap">
  <div class="lead"><h2>Sync progress, highlights, and stats anywhere</h2>
    <p>Link the services you already use. Progress and highlights go to them each time you sync.</p></div>
  <div class="hub">
    <div class="hub-track"><ul>${hubIcons}</ul><ul aria-hidden="true">${hubIcons}</ul><ul aria-hidden="true">${hubIcons}</ul></div>
  </div>
  <details class="more"><summary class="btn ghost">What each service syncs</summary>
  <div class="services">
    ${SERVICES.map(
      ([icon, name, desc, state]) =>
        `<div class="svc"><img src="${basePath}/icons/${icon}.png" alt="" width="40" height="40" loading="lazy"><div>` +
        `<div class="name">${name}${state === 'beta' ? '<span class="pill">beta</span>' : ''}</div><div class="desc">${desc}</div></div></div>`
    ).join('')}
  </div></details>
</div></section>

<section id="how"><div class="wrap">
  <div class="lead"><h2>Nothing new to learn</h2>
    <p>It speaks KOSync, the protocol your reader already has. Point it here and keep reading.</p></div>
  <div class="steps">
    <div class="step"><h3>Point your reader here</h3>
      <p>Sign in under KOReader Sync on CrossPoint, CrossInk or KOReader. No plugin to install.</p></div>
    <div class="step"><h3>Sync when you want to</h3>
      <p>Send your progress from KOReader Sync, then pick up on another device right where you left off.</p></div>
    <div class="step"><h3>View &amp; share in app</h3>
      <p>Your library, highlights and reading habits, on your phone and the web.</p></div>
  </div>
</div></section>

<section><div class="wrap split">
  <div class="copy">
    <h2>Every book, with its story</h2>
    <p>Open any book for its cover, description, moods and how long it took you.</p>
    <ul class="points">
      <li>Covers, descriptions and genres filled in automatically</li>
      <li>See what comes next when you finish a book in a series</li>
      <li>Mark books reading, paused, finished or did not finish</li>
    </ul>
  </div>
  <div class="screens">
    ${shot('tablet-book', 'The Three-Body Problem on a tablet: its cover, stats and description', 'wide tab')}
    ${shot('phone-book-details', 'Moods, genres and the next book in the series', 'tall')}
  </div>
</div></section>

<section><div class="wrap split flip">
  <div class="copy">
    <h2>Highlights that leave the device</h2>
    <p>Every passage you highlight on your reader shows up here, searchable and ready to share.</p>
    <ul class="points">
      <li>A highlight of the day, pulled from everything you've saved</li>
      <li>Search across every book, or copy them all as Markdown</li>
      <li>Share any passage as an image card with its cover</li>
    </ul>
  </div>
  <div class="screens">
    ${shot('phone-clippings', 'Clippings in the app', 'tall solo')}
  </div>
</div></section>

<section><div class="wrap split">
  <div class="copy">
    <h2>See how you read</h2>
    <p>Pages per week, the days you read, and the moods and genres you keep coming back to.</p>
  </div>
  <div class="screens">
    ${shot('desktop-calendar', 'Reading stats on the web: moods, genres and a year of reading days', 'wide short')}
    ${shot('phone-stats', 'Mood and genre stats in the app', 'tall')}
  </div>
</div></section>


<div class="wrap closing">
  <h2>Start syncing in a minute</h2>
  <p>Free to use and open source. Run it here, or on your own server with one Docker image.</p>
  <div class="cta"><a class="btn primary" href="${basePath}/app/">Sync Dashboard</a><a class="btn ghost" href="${GITHUB}">Self-Host Sync</a></div>
  ${STORES}
</div>
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
  document.querySelectorAll('picture source').forEach(source => { source.media = dark ? 'all' : 'not all'; });
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
