import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppEnv } from '../auth/middleware.js';
import { SESSION_COOKIE, verifySession } from '../auth/session.js';

/**
 * Minimal server-rendered web UI (no framework, no build step, no deps). Styled
 * to match the CrossPoint Reader site: Inter (UI) + Lora (display) + Geist Mono,
 * stone neutrals with the forest-green brand accent, white cards on stone-50.
 * Pages are static HTML calling the JSON /auth and /api/v1 endpoints via fetch;
 * the session cookie authenticates automatically (same-origin).
 */

const ASSETS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets');
const LOGO = fs.readFileSync(path.join(ASSETS_DIR, 'logo.png'));
const FAVICON = fs.readFileSync(path.join(ASSETS_DIR, 'favicon.png'));

// Service app icons, served at /icons/:id.png. Loaded once at boot; a missing
// file just means no icon for that service (the UI falls back gracefully).
const SERVICE_ICONS = new Map<string, Buffer>();
for (const id of ['kosync', 'hardcover', 'audiobookshelf', 'bookfusion', 'readwise', 'microblog']) {
  try {
    SERVICE_ICONS.set(id, fs.readFileSync(path.join(ASSETS_DIR, 'icons', `${id}.png`)));
  } catch {
    /* icon optional */
  }
}

const STYLE = `
  :root {
    color-scheme: light;
    --stone-50:#fafaf9; --stone-100:#f5f5f4; --stone-200:#e7e5e4; --stone-300:#d6d3d1;
    --stone-400:#a8a29e; --stone-500:#78716c; --stone-600:#57534e; --stone-700:#44403c;
    --stone-900:#1c1917; --stone-950:#0c0a09;
    --brand-50:#f0f5f3; --brand-100:#d6e5de; --brand-400:#69917d; --brand-500:#4a7a62;
    --brand-600:#3d6652; --brand-700:#315243;
    --ring:rgba(12,10,9,0.05);
  }
  * { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body {
    margin:0; background:var(--stone-50); color:var(--stone-900);
    font-family:"InterVariable","Inter",ui-sans-serif,system-ui,sans-serif;
    font-feature-settings:"cv02","cv03","cv04","cv11";
    -webkit-font-smoothing:antialiased;
  }
  .display { font-family:"Lora",ui-serif,serif; }
  .mono { font-family:"Geist Mono",ui-monospace,monospace; }

  header.site {
    position:sticky; top:0; z-index:40;
    border-bottom:1px solid rgba(231,229,228,0.8);
    background:rgba(250,250,249,0.8); backdrop-filter:blur(12px);
  }
  header.site .bar { max-width:64rem; margin:0 auto; padding:14px 20px; position:relative;
    display:flex; align-items:center; justify-content:center; gap:16px; }
  header.site .bar #logout { position:absolute; right:20px; top:50%; transform:translateY(-50%); }
  .wordmark { display:flex; align-items:center; gap:10px; text-decoration:none; }
  .wordmark img { width:28px; height:28px; border-radius:6px; display:block; }
  .wordmark span { font-family:"Lora",serif; font-weight:600; font-size:16px;
    letter-spacing:-0.01em; color:var(--stone-900); }
  .wordmark .accent { color:var(--brand-600); }

  .wrap { max-width:32rem; margin:0 auto; padding:44px 20px 96px; }
  .center { text-align:center; }
  .eyebrow { display:inline-flex; align-items:center; gap:7px; font-size:12px; font-weight:600;
    letter-spacing:0.08em; text-transform:uppercase; color:var(--brand-600); }
  .eyebrow::before { content:""; width:16px; height:1px; background:var(--brand-400); display:inline-block; }
  h1 { font-family:"Lora",serif; font-weight:600; font-size:30px; line-height:1.15;
    letter-spacing:-0.015em; margin:14px 0 0; color:var(--stone-900); }
  .sub { color:var(--stone-600); margin:12px 0 0; line-height:1.6; }

  .card { background:#fff; border-radius:12px; box-shadow:0 0 0 1px var(--ring); padding:24px; }
  .card + .card { margin-top:16px; }
  .card h2 { font-size:13px; font-weight:600; text-transform:uppercase; letter-spacing:0.05em;
    color:var(--stone-500); margin:0 0 14px; }

  label { display:block; font-size:14px; font-weight:500; color:var(--stone-700); margin:0 0 6px; }
  input { width:100%; padding:10px 14px; border:1px solid var(--stone-200); border-radius:8px;
    background:var(--stone-50); color:var(--stone-900); font-size:14px; }
  input::placeholder { color:var(--stone-400); }
  input:focus { outline:none; border-color:var(--brand-400); box-shadow:0 0 0 3px rgba(74,122,98,0.15); }

  button { appearance:none; border:0; border-radius:8px; padding:10px 16px; font-size:14px;
    font-weight:600; cursor:pointer; font-family:inherit; }
  button.primary { background:var(--brand-500); color:#fff; box-shadow:0 1px 2px rgba(0,0,0,0.06); }
  button.primary:hover { background:var(--brand-600); }
  button.ghost { background:#fff; color:var(--stone-700); box-shadow:0 0 0 1px var(--stone-200); }
  button.ghost:hover { background:var(--stone-50); }
  button.danger { background:#fff; color:#b91c1c; box-shadow:0 0 0 1px #f0cccc; }
  button.danger:hover { background:#fef2f2; }
  button.copied { color:var(--brand-700); box-shadow:0 0 0 1px var(--brand-100); background:var(--brand-50); opacity:1; }
  button:disabled { opacity:.5; cursor:default; }
  button.copied:disabled { opacity:1; }
  button.full { width:100%; }
  .mt { margin-top:14px; }

  .row { display:flex; align-items:center; justify-content:space-between; gap:14px; }
  .muted { color:var(--stone-500); font-size:13px; line-height:1.55; }
  .pill { font-size:11px; font-weight:600; padding:2px 9px; border-radius:999px;
    box-shadow:0 0 0 1px var(--stone-200); color:var(--stone-500); text-transform:uppercase; letter-spacing:0.03em; }
  .pill.ok { color:var(--brand-700); box-shadow:0 0 0 1px var(--brand-100); background:var(--brand-50); }
  .pill.warn { color:#9a7a2e; box-shadow:0 0 0 1px #ecdcae; background:#faf5e6; }
  .unlink-link { font-size:12px; font-weight:600; color:var(--stone-400); text-decoration:none; margin-left:2px; }
  .unlink-link:hover { color:#b91c1c; text-decoration:underline; }
  .grp { font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:var(--stone-400); margin:12px 0 4px; }

  code.token { display:block; margin:12px 0; padding:12px 14px; background:var(--stone-50);
    box-shadow:0 0 0 1px var(--stone-200); border-radius:8px; font-family:"Geist Mono",monospace;
    font-size:13px; word-break:break-all; color:var(--stone-900); }
  .notice { margin-top:16px; padding:14px 16px; background:var(--brand-50); border-radius:8px; }
  .notice b { color:var(--brand-700); }
  .err { color:#b91c1c; font-size:13px; min-height:18px; margin-top:8px; }
  .foot { text-align:center; color:var(--stone-400); font-size:12px; margin-top:28px; }
  .foot a { color:var(--stone-500); }
  a { color:var(--brand-600); text-decoration:none; }
  a:hover { text-decoration:underline; }

  /* Faint Free-Ink paper grain across the whole page (behind content). */
  body::before { content:""; position:fixed; inset:0; z-index:0; pointer-events:none; opacity:0.045;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    background-size:160px 160px; }
  header.site, .wrap { position:relative; z-index:1; }

  .wrap.wide { max-width:48rem; }
  .narrow { max-width:24rem; margin:0 auto; }
  /* hand-lettered "or" divider between the auth cards */
  .or { display:flex; align-items:center; gap:14px; margin:14px 2px; }
  .or::before, .or::after { content:""; flex:1; height:0;
    border-top:2px solid var(--stone-200); border-radius:2px;
    -webkit-mask-image:linear-gradient(90deg,transparent,#000 20%,#000 80%,transparent);
            mask-image:linear-gradient(90deg,transparent,#000 20%,#000 80%,transparent); }
  .or span { font-family:"Caveat",cursive; font-weight:600; font-size:24px; color:var(--stone-500);
    transform:rotate(-6deg); line-height:1; }
  /* soft brand wash behind the hero */
  .hero { text-align:center; padding:24px 20px 8px; position:relative; border-radius:16px;
    background:linear-gradient(160deg, var(--stone-50), #fff 55%, var(--brand-50) 130%); }
  .hero h1 { font-size:38px; }
  .hero h1 .mark { position:relative; white-space:nowrap; }
  /* hand-drawn underline under the emphasized word */
  .hero h1 .mark::after { content:""; position:absolute; left:-2%; right:-2%; bottom:-2px; height:12px;
    background:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 200 12' preserveAspectRatio='none'%3E%3Cpath d='M2 8 C 45 2, 80 11, 120 6 S 188 3, 198 7' stroke='%234a7a62' stroke-width='3' fill='none' stroke-linecap='round'/%3E%3C/svg%3E") bottom/100% 100% no-repeat; }
  .hero .sub { max-width:34rem; margin-left:auto; margin-right:auto; font-size:17px; }
  /* Caveat hand-lettered eyebrow + annotations */
  .eyebrow-hand { font-family:"Caveat",cursive; font-weight:600; font-size:22px; color:var(--brand-600);
    display:inline-block; transform:rotate(-1.5deg); margin:0; }
  .annotate { display:inline-flex; align-items:center; gap:6px; font-family:"Caveat",cursive;
    font-weight:600; font-size:19px; color:var(--stone-500); transform:rotate(-2deg); }
  .annotate svg { width:38px; height:22px; color:var(--stone-400); flex:0 0 auto; }
  .cta { display:flex; gap:10px; justify-content:center; align-items:center; margin-top:24px; flex-wrap:wrap; }
  .cta a { text-decoration:none; }
  .step { display:flex; gap:16px; padding:16px 0; border-top:1px solid var(--stone-200); }
  .step:first-child { border-top:0; padding-top:4px; }
  .step .n { flex:0 0 30px; height:30px; border-radius:999px; background:var(--brand-50);
    color:var(--brand-700); box-shadow:0 0 0 1px var(--brand-100); display:flex;
    align-items:center; justify-content:center; font-weight:700; font-size:14px; }
  .step h3 { margin:3px 0 4px; font-size:15px; }
  .step p { margin:0; color:var(--stone-600); line-height:1.55; }
  .svc { display:flex; justify-content:space-between; align-items:flex-start; gap:14px;
    padding:14px 0; border-top:1px solid var(--stone-200); }
  .svc:first-child { border-top:0; }
  .svc .name { font-weight:600; }
  .svc .desc { color:var(--stone-600); font-size:13px; margin-top:2px; line-height:1.5; }
  .lead { display:flex; gap:12px; align-items:flex-start; min-width:0; }
  .svc-icon { width:34px; height:34px; border-radius:8px; flex:0 0 auto; object-fit:cover;
    box-shadow:0 1px 2px rgba(0,0,0,0.12); background:#fff; }
  .sync-book { padding:14px 0; border-top:1px solid var(--stone-200); }
  .sync-book:first-child { border-top:0; padding-top:0; }
  .sync-book:last-child { padding-bottom:0; }
  .sync-book .title { font-weight:600; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sync-book .meta { color:var(--stone-500); font-size:12px; margin-top:3px; }
  .progress-track { height:6px; border-radius:999px; background:var(--stone-100); overflow:hidden; margin-top:10px; }
  .progress-fill { height:100%; border-radius:inherit; background:var(--brand-500); }
`;

function shell(title: string, body: string, wide = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · CrossPoint Sync</title>
<link rel="icon" type="image/png" href="/favicon.png">
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Lora:wght@500;600;700&family=Geist+Mono:wght@400;500&family=Caveat:wght@500;600&display=swap">
<style>${STYLE}</style></head>
<body>
<header class="site"><div class="bar">
  <a class="wordmark" href="https://crosspointreader.com"><img src="/logo.png" alt=""><span>CrossPoint <span class="accent">Sync</span></span></a>
  ${title === 'Account' ? '<button class="ghost" id="logout">Sign out</button>' : ''}
</div></header>
<div class="wrap${wide ? ' wide' : ''}">${body}</div>
</body></html>`;
}

const SECTION = 'font-size:13px;text-transform:uppercase;letter-spacing:0.05em;color:var(--stone-500);margin:32px 0 12px;';

const LANDING = shell(
  'Sync your reading',
  `<div class="hero">
     <p class="eyebrow-hand">read on every device</p>
     <h1>Your reading, in sync <span class="mark">everywhere</span></h1>
     <p class="sub">A KOReader-compatible sync server for your e-reader. It keeps your reading progress in sync across devices, and pushes it out to the reading services you already use.</p>
     <div class="cta">
       <a href="#get-started"><button class="primary">Get started</button></a>
       <span class="annotate">
         <svg viewBox="0 0 40 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M38 20 C 30 22, 18 20, 5 8"/><path d="M5 8 l 0.5 7"/><path d="M5 8 l 7.5 0.5"/></svg>
         free &amp; open source
       </span>
     </div>
   </div>

   <h2 id="how" style="${SECTION}margin-top:44px">How it works</h2>
   <div class="card">
     <div class="step"><div class="n">1</div><div>
       <h3>Point your reader at CrossPoint Sync</h3>
       <p>In your reader's KOReader Sync settings, use this server with your sync account. It is standard KOSync, so there is nothing extra to install.</p></div></div>
     <div class="step"><div class="n">2</div><div>
       <h3>Just read</h3>
       <p>Your reading progress and finished books sync to your account automatically, and stay in sync across all your devices.</p></div></div>
     <div class="step"><div class="n">3</div><div>
       <h3>Link your services</h3>
       <p>Connect services like Hardcover and other sync servers. Your reading flows out to them as you go, and "Sync now" backfills the books you have already read.</p></div></div>
   </div>

   <h2 style="${SECTION}">Services you can link</h2>
   <div class="card">
     <div class="svc"><div class="lead"><img class="svc-icon" src="/icons/kosync.png" alt="" width="34" height="34"><div><div class="name">Another KOSync server</div>
       <div class="desc">Mirror your progress to sync.koreader.rocks or your own server, so your other KOReader devices stay in sync too.</div></div></div>
       <span class="pill">ready</span></div>
     <div class="svc"><div class="lead"><img class="svc-icon" src="/icons/hardcover.png" alt="" width="34" height="34"><div><div class="name">Hardcover</div>
       <div class="desc">Keep your Hardcover shelf and reading progress up to date automatically.</div></div></div>
       <span class="pill warn">beta</span></div>
     <div class="svc"><div class="lead"><img class="svc-icon" src="/icons/microblog.png" alt="" width="34" height="34"><div><div class="name">Micro.blog</div>
       <div class="desc">Keep your Currently reading and Finished reading bookshelves up to date automatically.</div></div></div>
       <span class="pill">ready</span></div>
     <div class="svc"><div class="lead"><img class="svc-icon" src="/icons/audiobookshelf.png" alt="" width="34" height="34"><div><div class="name">Audiobookshelf</div>
       <div class="desc">Keep your place between the ebook and the audiobook, both ways. Read some, then pick up listening right where you left off.</div></div></div>
       <span class="pill">ready</span></div>
     <div class="svc"><div class="lead"><img class="svc-icon" src="/icons/bookfusion.png" alt="" width="34" height="34"><div><div class="name">BookFusion</div>
       <div class="desc">Sync reading positions both ways for books downloaded from BookFusion.</div></div></div>
       <span class="pill warn">experimental</span></div>
     <p style="font-family:'Caveat',cursive;font-weight:600;font-size:19px;color:var(--brand-600);margin:16px 0 0;transform:rotate(-1deg)">more on the way, and it's all open source</p>
   </div>

   <div class="narrow">
     <h2 id="get-started" style="${SECTION}text-align:center">Get started</h2>
     <div class="card">
       <h2>Create account</h2>
       <label for="su">Choose a handle</label>
       <input id="su" autocomplete="username" placeholder="e.g. julia" />
       <button class="primary full mt" id="signup">Create account</button>
       <div class="err" id="suErr"></div>
       <div id="tokenBox" hidden>
         <div class="notice">
           <p style="margin:0 0 4px"><b>Save your login token now.</b> It won't be shown again.</p>
           <p class="muted" style="margin:0">This is how you sign into this website. It is not your reader password. You set up your reader sync separately, inside.</p>
         </div>
         <code class="token" id="tokenVal"></code>
         <div class="row">
           <button class="ghost" id="copyTok">Copy token</button>
           <a href="/account">Continue &rarr;</a>
         </div>
       </div>
     </div>

     <div class="or"><span>or</span></div>

     <div class="card">
       <h2>Sign in</h2>
       <label for="ksu">Sync username</label>
       <input id="ksu" autocomplete="username" placeholder="your reader sync username" />
       <label for="ksp" style="margin-top:10px">Sync password</label>
       <input id="ksp" type="password" autocomplete="current-password" />
       <button class="primary full mt" id="ksLogin">Sign in</button>
       <div class="err" id="ksLoginErr"></div>
       <p class="muted" style="margin-top:14px"><a href="#" id="tokToggle">Have a login token instead?</a></p>
       <div id="tokBox" hidden style="margin-top:6px">
         <label for="li">Login token</label>
         <input id="li" class="mono" placeholder="xp1_…" autocomplete="off" />
         <button class="ghost full mt" id="login">Sign in with token</button>
         <div class="err" id="liErr"></div>
       </div>
     </div>
   </div>

   <p class="foot"><a href="https://github.com/crosspoint-reader/crosspoint-sync">Want to self host this?</a></p>

<script>
const $ = (id) => document.getElementById(id);
async function post(url, body) {
  const r = await fetch(url, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify(body) });
  return { ok: r.ok, data: await r.json().catch(()=>({})) };
}
$('signup').onclick = async () => {
  $('suErr').textContent = '';
  const { ok, data } = await post('/auth/signup', { handle: $('su').value.trim() });
  if (!ok) { $('suErr').textContent = data.error || 'Something went wrong'; return; }
  $('tokenVal').textContent = data.token;
  $('tokenBox').hidden = false;
  $('signup').disabled = true; $('su').disabled = true;
};
async function copyWithFeedback(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API can fail (insecure context / permissions); fall back.
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } catch {} document.body.removeChild(ta);
  }
  const original = btn.textContent;
  btn.textContent = 'Copied ✓';
  btn.classList.add('copied');
  btn.disabled = true;
  setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); btn.disabled = false; }, 1600);
}
$('copyTok').onclick = () => copyWithFeedback($('copyTok'), $('tokenVal').textContent);
$('ksLogin').onclick = async () => {
  $('ksLoginErr').textContent = '';
  const { ok, data } = await post('/auth/login-kosync', { username: $('ksu').value.trim(), password: $('ksp').value });
  if (!ok) { $('ksLoginErr').textContent = data.error || 'Invalid credentials'; return; }
  location.href = '/account';
};
$('tokToggle').onclick = (e) => { e.preventDefault(); $('tokBox').hidden = !$('tokBox').hidden; };
$('login').onclick = async () => {
  $('liErr').textContent = '';
  const { ok, data } = await post('/auth/login', { token: $('li').value.trim() });
  if (!ok) { $('liErr').textContent = data.error || 'Invalid token'; return; }
  location.href = '/account';
};
</script>`,
  true
);

const ACCOUNT = shell(
  'Account',
  `<div>
     <span class="eyebrow">Account</span>
     <h1>Signed in as <span id="who">…</span></h1>
   </div>

   <h2 style="${SECTION}">CrossPoint Sync (KOSync)</h2>
   <div id="kosync"><p class="muted">Loading…</p></div>


   <h2 style="${SECTION}">Reading progress</h2>
   <div class="card"><div class="row"><div><div style="font-weight:600">Synced books</div><div class="muted" style="margin-top:3px">View titles, percentages, devices, and sync times.</div></div><a href="/progress"><button class="ghost">View</button></a></div></div>

   <h2 style="${SECTION}">Linked services</h2>
   <div class="notice" style="margin-bottom:12px">
     <p style="margin:0 0 4px"><b>One-time setup:</b> turn on <b>Send Document Metadata</b> in your reader.</p>
     <p class="muted" style="margin:0">On CrossPoint: Settings &rarr; KOReader Sync &rarr; Send Document Metadata &rarr; On. This lets us match your books to these services by title and author. Without it, new books can't be matched automatically (you can still match them by hand under Matches).</p>
   </div>
   <div id="connectors"><p class="muted">Loading…</p></div>

   <h2 style="${SECTION}">Website login</h2>
   <div class="card">
     <p class="muted" style="margin-top:0">The token you use to sign into this website. Rotating it signs you out on the web and does not affect your reader.</p>
     <div class="row" style="justify-content:flex-start;gap:8px">
       <button class="ghost" id="rotate">Rotate login token</button>
       <button class="danger" id="delAccount">Delete account</button>
     </div>
     <div id="rotBox" hidden>
       <code class="token" id="rotVal"></code>
       <button class="ghost" id="copyRot">Copy token</button>
     </div>
   </div>

   <p class="foot"><a href="https://github.com/crosspoint-reader/crosspoint-sync">Want to self host this?</a></p>

<script>
const ORIGIN = window.location.origin;
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
async function jget(u){ const r = await fetch(u); return { ok:r.ok, data: await r.json().catch(()=>({})) }; }
async function jsend(u, m='POST', body){ const r = await fetch(u,{method:m,headers:body?{'content-type':'application/json'}:undefined, body: body?JSON.stringify(body):undefined}); return { ok:r.ok, data: await r.json().catch(()=>({})) }; }
async function copyWithFeedback(btn, text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const ta=document.createElement('textarea'); ta.value=text; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy');}catch{} document.body.removeChild(ta); }
  const o=btn.textContent; btn.textContent='Copied ✓'; btn.classList.add('copied'); btn.disabled=true;
  setTimeout(()=>{btn.textContent=o; btn.classList.remove('copied'); btn.disabled=false;}, 1600);
}

(async () => {
  const me = await jget('/auth/me');
  if (!me.ok) { location.href='/'; return; }
  $('who').textContent = me.data.handle;
  renderKosync();
})();




// Reader-setup panel shown once a sync account exists. The password is the one
// the user chose (we never store or display plaintext), so we only echo server
// + username and remind them to use their chosen password.
function readerSetup(username) {
  return '<div class="notice"><p style="margin:0 0 8px"><b>Enter these in your reader</b> under Settings &rarr; KOReader Sync.</p>'
    + '<dl style="margin:0;font-size:13px">'
    + '<div class="row"><dt class="muted">Server</dt><dd class="mono" style="margin:0">'+esc(ORIGIN)+'</dd></div>'
    + '<div class="row" style="margin-top:6px"><dt class="muted">Username</dt><dd class="mono" style="margin:0">'+esc(username)+'</dd></div>'
    + '<div class="row" style="margin-top:6px"><dt class="muted">Password</dt><dd style="margin:0">the password you just chose</dd></div>'
    + '</dl></div>';
}

async function renderKosync() {
  const { ok, data } = await jget('/account/kosync');
  const el = $('kosync');
  if (!ok) { el.innerHTML = '<p class="muted">Could not load.</p>'; return; }
  if (data.linked) {
    el.innerHTML =
      '<div class="card"><div class="row"><div><div style="font-weight:600">'+esc(data.username)+' <span class="pill ok">connected</span></div>'
      + '<div class="muted" style="margin-top:3px">Your reader syncs reading progress to this KOSync account.</div></div>'
      + '<button class="ghost" id="ksPw">Change password</button></div>'
      + '<div id="ksPwBox" style="margin-top:12px"></div>'
      + '<div class="row" style="margin-top:12px;justify-content:flex-start;gap:8px"><button class="ghost" id="ksUnlink">Disconnect</button>'
      + '<button class="danger" id="ksDelete">Delete sync account</button></div></div>';
    $('ksPw').onclick = () => {
      $('ksPwBox').innerHTML = '<label>New password</label><input id="ksNewPw" type="password" autocomplete="new-password">'
        + '<button class="primary mt" id="ksPwSave">Save password</button><div class="err" id="ksPwErr"></div>';
      $('ksPwSave').onclick = async () => {
        $('ksPwErr').textContent = '';
        const r = await jsend('/account/kosync/password', 'POST', { password: $('ksNewPw').value });
        if (r.ok) { $('ksPwBox').innerHTML = readerSetup(data.username); }
        else { $('ksPwErr').textContent = r.data.error || 'Could not update'; }
      };
    };
    $('ksUnlink').onclick = async () => {
      if (!confirm('Disconnect this sync account from your login? Your reading data is kept.')) return;
      await jsend('/account/kosync', 'DELETE'); renderKosync();
    };
    $('ksDelete').onclick = async () => {
      if (!confirm('Permanently delete this sync account and ALL its reading data (progress, bookmarks, clippings, stats, linked services)? This cannot be undone.')) return;
      await jsend('/account/kosync/data', 'DELETE'); renderKosync();
    };
    renderConnectors();
    return;
  }
  $('progress').innerHTML = '<div class="card"><p class="muted" style="margin:0">Set up reading sync above to see your synced books here.</p></div>';
  el.innerHTML =
    '<div class="card"><div style="font-weight:600">Set up reading sync</div>'
    + '<p class="muted" style="margin:6px 0 14px">CrossPoint Sync is a KOReader-compatible (KOSync) progress server. Create a sync account, then enter it in your reader under Settings &rarr; KOReader Sync. Already made one on your device? Connect it below.</p>'
    + '<div><label>Username</label><input id="ksUser" autocomplete="off" placeholder="your sync username"></div>'
    + '<div style="margin-top:10px"><label>Password</label><input id="ksPass" type="password" autocomplete="new-password"></div>'
    + '<div style="margin-top:10px"><label>Confirm password</label><input id="ksPass2" type="password" autocomplete="new-password"></div>'
    + '<button class="primary full mt" id="ksCreate">Create sync account</button>'
    + '<div id="ksCreateBox" style="margin-top:12px"></div>'
    + '<div class="err" id="ksErr"></div>'
    + '<hr style="border:0;border-top:1px solid var(--stone-200);margin:18px 0">'
    + '<div style="font-weight:600;font-size:14px">Connect an existing sync account</div>'
    + '<p class="muted" style="margin:4px 0 10px">Use the username and password you already set on your device.</p>'
    + '<div><label>Username</label><input id="ksLuser" autocomplete="off"></div>'
    + '<div style="margin-top:10px"><label>Password</label><input id="ksLpass" type="password" autocomplete="off"></div>'
    + '<button class="ghost mt" id="ksLink">Connect existing</button>'
    + '<div class="err" id="ksLerr"></div></div>';
  $('ksCreate').onclick = async () => {
    $('ksErr').textContent = '';
    const u = $('ksUser').value.trim(), p = $('ksPass').value, p2 = $('ksPass2').value;
    if (p !== p2) { $('ksErr').textContent = 'Passwords do not match.'; return; }
    const r = await jsend('/account/kosync', 'POST', { username: u, password: p });
    if (r.ok) {
      el.querySelector('.card').innerHTML = '<div style="font-weight:600">'+esc(r.data.username)+' <span class="pill ok">connected</span></div>'
        + '<div style="margin-top:12px">'+readerSetup(r.data.username)+'</div>'
        + '<div style="margin-top:12px"><button class="primary" id="ksDone">Done</button></div>';
      $('ksDone').onclick = () => renderKosync();
      // The sync account now exists, so surface the linkable services right away.
      renderConnectors();
    } else { $('ksErr').textContent = r.data.error || 'Could not create'; }
  };
  $('ksLink').onclick = async () => {
    $('ksLerr').textContent = '';
    const r = await jsend('/account/kosync', 'PUT', { username: $('ksLuser').value.trim(), password: $('ksLpass').value });
    if (r.ok) { renderKosync(); } else { $('ksLerr').textContent = r.data.error || 'Could not connect'; }
  };
  $('connectors').innerHTML = '<p class="muted">Set up reading sync above to link services.</p>';
}

async function renderConnectors() {
  const { ok, data } = await jget('/api/v1/connectors');
  const el = $('connectors');
  if (!ok) { el.innerHTML = '<p class="muted">Set up reading sync above to link services.</p>'; return; }
  if (data.encryption !== 'enabled') {
    el.innerHTML = '<div class="card"><p class="muted" style="margin:0">Service linking is disabled on this server (no <code class="mono">TOKEN_ENC_KEY</code> configured).</p></div>';
    return;
  }
  el.innerHTML = data.connectors.map(c => {
    const badge = c.linked
      ? (c.status==='needs_reauth' ? '<span class="pill warn">needs reauth</span> ' : '') + '<a href="#" class="unlink-link" data-unlink="'+c.id+'">unlink</a>'
      : (c.experimental ? '<span class="pill warn">experimental</span>' : '');
    const action = c.linked
      ? '<div class="row" style="justify-content:flex-end;gap:8px"><button class="ghost" data-review="'+c.id+'">Matches</button><button class="ghost" data-sync="'+c.id+'">Sync now</button></div>'
      : '<button class="primary" data-link="'+c.id+'">Link</button>';
    return '<div class="card"><div class="row"><div class="lead"><img class="svc-icon" src="/icons/'+esc(c.id)+'.png" alt="" width="34" height="34" onerror="this.style.display=\\'none\\'"><div><div style="font-weight:600">'+esc(c.name)+' '+badge+
      '</div><div class="muted" style="margin-top:3px">syncs '+esc(c.carries.join(', '))+(c.account?' · '+esc(c.account):'')+'</div></div></div>'+action+'</div></div>';
  }).join('');
  el.querySelectorAll('[data-unlink]').forEach(b => b.onclick = async (e) => {
    e.preventDefault();
    if (!confirm('Unlink this service? Its saved matches are removed too.')) return;
    await jsend('/api/v1/connectors/'+b.dataset.unlink, 'DELETE'); renderConnectors();
  });
  el.querySelectorAll('[data-sync]').forEach(b => b.onclick = async () => {
    const orig = b.textContent; b.disabled = true; b.textContent = 'Syncing…';
    const r = await jsend('/api/v1/connectors/'+b.dataset.sync+'/sync');
    b.textContent = r.ok ? ('Queued ' + r.data.queued + ' ✓') : 'Failed';
    b.classList.toggle('copied', r.ok);
    setTimeout(() => { b.textContent = orig; b.disabled = false; b.classList.remove('copied'); }, 2000);
  });
  el.querySelectorAll('[data-review]').forEach(b => b.onclick = () => { location.href = '/review/' + b.dataset.review; });
  el.querySelectorAll('[data-link]').forEach(b => b.onclick = () => { location.href = '/link/' + b.dataset.link; });
}

$('logout').onclick = async () => { await jsend('/auth/logout'); location.href='/'; };
$('rotate').onclick = async () => {
  if (!confirm('Rotate your website login token? You will be signed out on the web and must sign in with the new token.')) return;
  const { ok, data } = await jsend('/auth/token/rotate');
  if (ok) { $('rotVal').textContent = data.token; $('rotBox').hidden = false; }
};
$('copyRot').onclick = () => copyWithFeedback($('copyRot'), $('rotVal').textContent);
$('delAccount').onclick = async () => {
  if (!confirm('Permanently delete your account, your sync account, and ALL reading data? This cannot be undone.')) return;
  if (!confirm('Are you absolutely sure? Everything will be erased.')) return;
  await jsend('/account', 'DELETE'); location.href = '/';
};
</script>`,
  true
);

const LINK = shell(
  'Link service',
  `<div><a class="muted" href="/account">&larr; Account</a></div>
   <div style="margin-top:16px"><span class="eyebrow" id="eyebrow">Link service</span>
     <h1 id="title">Link</h1>
     <p class="sub" id="desc"></p></div>
   <div class="card mt" style="margin-top:24px" id="form"><p class="muted">Loading…</p></div>

<script>
const ID = decodeURIComponent(location.pathname.split('/').pop());
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[m]));
async function jget(u){ const r = await fetch(u); return { ok:r.ok, status:r.status, data: await r.json().catch(()=>({})) }; }
async function jsend(u, m='POST', body){ const r = await fetch(u,{method:m,headers:body?{'content-type':'application/json'}:undefined, body: body?JSON.stringify(body):undefined}); return { ok:r.ok, status:r.status, data: await r.json().catch(()=>({})) }; }
function secureCredentialConnection() {
  return location.protocol === 'https:' || location.hostname === 'localhost'
    || location.hostname === '127.0.0.1' || location.hostname === '[::1]';
}
async function linkCredential(body) {
  if (!secureCredentialConnection()) {
    return { ok:false, data:{ message:'Use HTTPS to link a service.' } };
  }
  return jsend('/api/v1/connectors/' + ID, 'PUT', { credential: body });
}

const HINTS = {
  hardcover: 'Paste your Hardcover API token from hardcover.app/account/api. Syncs your reading progress and shelf status.',
  microblog: 'Connect an app token to keep your Currently reading and Finished reading bookshelves in sync.',
  readwise: 'Paste your Readwise access token from readwise.io/access_token. Syncs your highlights.',
  kosync: 'Mirror your reading progress to another KOReader-compatible (KOSync) server, so your other devices see it too.',
  bookfusion: 'Connect your BookFusion account to sync reading progress. You will approve the request on bookfusion.com.',
  audiobookshelf: 'Sync your reading position to the matching audiobook on your Audiobookshelf server. Create an API key in Audiobookshelf under Settings, Users, API Keys.'
};

const TOKEN_HELP = {
  microblog: '<div class="muted" style="margin-bottom:18px"><p style="margin-top:0"><b>Get a Micro.blog app token:</b></p>'
    + '<ol style="padding-left:20px;margin-bottom:10px">'
    + '<li>Sign in to Micro.blog in another tab.</li>'
    + '<li>Open <a href="https://micro.blog/account/apps" target="_blank" rel="noopener noreferrer">Account → App tokens</a>.</li>'
    + '<li>Create a separate token for <b>CrossPoint Sync</b>.</li>'
    + '<li>Copy the new token and paste it below.</li>'
    + '</ol><p style="margin-bottom:0">Treat this token like a password: it has full access to your Micro.blog account. CrossPoint Sync encrypts it before storing it.</p></div>'
};

(async () => {
  const { ok, status, data } = await jget('/api/v1/connectors');
  if (status === 409) { location.href = '/account'; return; }   // no sync account yet
  if (!ok) { $('form').innerHTML = '<p class="muted">Could not load.</p>'; return; }
  const conn = (data.connectors || []).find(c => c.id === ID);
  if (!conn) { location.href = '/account'; return; }
  $('title').textContent = 'Link ' + conn.name;
  $('desc').textContent = HINTS[ID] || '';
  if (conn.experimental) $('eyebrow').textContent = 'Experimental';
  render(conn);
})();

function done() { location.href = '/account'; }

function render(conn) {
  const f = $('form');
  if (conn.credential_kind === 'token') {
    f.innerHTML = (TOKEN_HELP[ID] || '') + '<label>API token</label><input id="tok" class="mono" type="password" placeholder="paste token">'
      + '<button class="primary full mt" id="go">Link ' + esc(conn.name) + '</button><div class="err" id="e"></div>';
    $('go').onclick = async () => {
      $('e').textContent = '';
      const r = await linkCredential({ token: $('tok').value.trim() });
      if (r.ok) done(); else $('e').textContent = r.data.message || 'Could not link';
    };
  } else if (conn.credential_kind === 'kosync') {
    f.innerHTML = '<label>Server URL</label><input id="srv" class="mono" placeholder="https://sync.koreader.rocks:443">'
      + '<div style="margin-top:10px"><label>Username</label><input id="u" autocomplete="off"></div>'
      + '<div style="margin-top:10px"><label>Password</label><input id="p" type="password" autocomplete="off"></div>'
      + '<button class="primary full mt" id="go">Connect server</button><div class="err" id="e"></div>';
    $('go').onclick = async () => {
      $('e').textContent = '';
      const r = await linkCredential({ server: $('srv').value.trim(), username: $('u').value.trim(), password: $('p').value });
      if (r.ok) done(); else $('e').textContent = r.data.message || 'Could not connect';
    };
  } else if (conn.credential_kind === 'abs') {
    f.innerHTML = '<label>Server URL</label><input id="srv" class="mono" placeholder="https://audiobookshelf.example.com">'
      + '<div style="margin-top:10px"><label>API key</label><input id="tok" class="mono" type="password" placeholder="paste API key"></div>'
      + '<button class="primary full mt" id="go">Connect Audiobookshelf</button><div class="err" id="e"></div>';
    $('go').onclick = async () => {
      $('e').textContent = '';
      const r = await linkCredential({ server: $('srv').value.trim(), token: $('tok').value.trim() });
      if (r.ok) done(); else $('e').textContent = r.data.message || 'Could not connect';
    };
  } else if (conn.credential_kind === 'device_code') {
    f.innerHTML = '<p class="muted" style="margin-top:0">Click start, then approve the request on ' + esc(conn.name) + '.</p>'
      + '<button class="primary" id="start">Start</button><div id="dc" style="margin-top:14px"></div><div class="err" id="e"></div>';
    $('start').onclick = startDeviceFlow;
  } else {
    f.innerHTML = '<p class="muted">This connector is not linkable from here yet.</p>';
  }
}

async function startDeviceFlow() {
  $('e').textContent = '';
  $('start').disabled = true;
  const r = await jsend('/api/v1/connectors/' + ID + '/link/begin');
  if (!r.ok) { $('e').textContent = r.data.message || 'Could not start'; $('start').disabled = false; return; }
  const { device_code, user_code, verification_uri, interval } = r.data;
  $('dc').innerHTML = '<div class="notice"><p style="margin:0 0 8px">Go to <a href="' + esc(verification_uri) + '" target="_blank" rel="noopener">' + esc(verification_uri) + '</a> and enter this code:</p>'
    + '<code class="token" style="text-align:center;font-size:20px;letter-spacing:3px">' + esc(user_code) + '</code>'
    + '<p class="muted" id="poll" style="margin:8px 0 0">Waiting for approval…</p></div>';
  const deadline = Date.now() + 15 * 60 * 1000;
  const tick = async () => {
    if (Date.now() > deadline) { $('poll').textContent = 'Timed out. Start again.'; return; }
    const p = await jsend('/api/v1/connectors/' + ID + '/link/poll', 'POST', { device_code });
    if (p.data.status === 'ok') { done(); return; }
    if (p.data.status === 'pending') { setTimeout(tick, Math.max(2, interval || 5) * 1000); return; }
    $('poll').textContent = p.data.error || 'Linking failed. Start again.';
    $('start').disabled = false;
  };
  setTimeout(tick, Math.max(2, interval || 5) * 1000);
}
</script>`
);

const PROGRESS = shell(
  'Reading progress',
  `<div><a class="muted" href="/account">&larr; Account</a></div>
   <div style="margin-top:16px"><span class="eyebrow">Reading progress</span>
     <h1>Synced books</h1>
     <p class="sub">All synced books with their latest progress.</p></div>
   <div id="list" style="margin-top:8px"><p class="muted">Loading…</p></div>

<script>
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
async function jget(u){ const r = await fetch(u); return { ok:r.ok, data:await r.json().catch(()=>({})) }; }
(async () => {
  const r = await jget('/api/v1/progress?limit=500');
  const el = $('list');
  if (!r.ok) { el.innerHTML = '<p class="muted">Could not load synced books.</p>'; return; }
  const books = r.data.items || [];
  if (!books.length) { el.innerHTML = '<div class="card"><p class="muted" style="margin:0">No synced books yet. Read something on your device first.</p></div>'; return; }
  el.innerHTML = books.map(b => {
    const title = b.title || b.filename || b.document;
    const value = Math.max(0, Math.min(1, Number(b.percentage) || 0));
    const percent = (value * 100).toFixed(1).replace(/\\.0$/, '');
    const author = b.author ? '<div class="meta">' + esc(b.author) + '</div>' : '';
    const device = b.device || b.device_id ? 'Device: ' + esc(b.device || b.device_id) : '';
    const when = b.timestamp ? ' · Last synced: ' + new Date(b.timestamp * 1000).toLocaleString() : '';
    return '<div class="sync-book"><div class="row"><div><div class="title" title="' + esc(title) + '">' + esc(title) + '</div>'
      + author + '<div class="meta">' + device + when + '</div></div><b class="mono" style="font-size:13px">' + percent + '%</b></div>'
      + '<div class="progress-track" role="progressbar" aria-valuenow="' + (value * 100) + '" aria-valuemin="0" aria-valuemax="100"><div class="progress-fill" style="width:' + (value * 100) + '%"></div></div></div>';
  }).join('');
})();
</script>`
);


const REVIEW = shell(
  'Matches',
  `<div><a class="muted" href="/account">&larr; Account</a></div>
   <div style="margin-top:16px"><span class="eyebrow">Matches</span>
     <h1 id="title">Matches</h1>
     <p class="sub">Which book each of your synced titles maps to. Fix anything that matched wrong, or pick a match for the ones that didn't.</p></div>
   <div id="list" style="margin-top:8px"><p class="muted">Loading…</p></div>

<script>
const ID = decodeURIComponent(location.pathname.split('/').pop());
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
async function jget(u){ const r = await fetch(u); return { ok:r.ok, status:r.status, data: await r.json().catch(()=>({})) }; }
async function jsend(u, m='PUT', body){ const r = await fetch(u,{method:m,headers:body?{'content-type':'application/json'}:undefined, body: body?JSON.stringify(body):undefined}); return { ok:r.ok, data: await r.json().catch(()=>({})) }; }

let CONN = null, CANDIDATES = [], BOOKS = [];

(async () => {
  const list = await jget('/api/v1/connectors');
  if (list.status === 409) { location.href = '/account'; return; }
  CONN = (list.data.connectors || []).find(c => c.id === ID);
  if (!CONN) { location.href = '/account'; return; }
  $('title').textContent = CONN.name + ' matches';
  // Preload the "currently reading" candidates for quick picking.
  const cand = await jget('/api/v1/connectors/' + ID + '/candidates');
  CANDIDATES = cand.data.books || [];
  renderList();
})();

async function renderList() {
  const { ok, data } = await jget('/api/v1/connectors/' + ID + '/review');
  const el = $('list');
  if (!ok) { el.innerHTML = '<p class="muted">Could not load.</p>'; return; }
  BOOKS = data.books || [];
  if (!BOOKS.length) { el.innerHTML = '<div class="card"><p class="muted" style="margin:0">No synced books yet. Read something on your device first.</p></div>'; return; }
  el.innerHTML = data.books.map(b => {
    const name = b.title ? esc(b.title) + (b.author ? ' <span class="muted">· ' + esc(b.author) + '</span>' : '') : '<span class="mono">' + esc(b.document.slice(0,12)) + '…</span>';
    const state = b.matched
      ? '<span class="pill ok">' + (b.source === 'manual' ? 'matched (manual)' : 'matched') + '</span>'
      : '<span class="pill warn">not matched</span>';
    return '<div class="card"><div class="row"><div><div style="font-weight:600">' + name + ' ' + state + '</div>'
      + (b.matched ? '<div class="muted" style="margin-top:3px">id ' + esc(b.external_id) + '</div>' : '')
      + '</div><button class="ghost" data-pick="' + esc(b.document) + '">' + (b.matched ? 'Change' : 'Match') + '</button></div>'
      + '<div class="picker" id="pick-' + esc(b.document) + '" hidden style="margin-top:12px"></div></div>';
  }).join('');
  el.querySelectorAll('[data-pick]').forEach(btn => btn.onclick = () => openPicker(btn.dataset.pick));
}

function openPicker(doc) {
  const box = $('pick-' + doc);
  if (!box.hidden) { box.hidden = true; return; }
  box.hidden = false;
  const book = BOOKS.find(b => b.document === doc);
  const opts = CANDIDATES.map(c => optionRow(doc, c)).join('');
  box.innerHTML = (opts ? '<div class="grp">Currently reading</div>' + opts : '')
    + '<div id="results-' + doc + '"><div class="grp">Suggestions</div><p class="muted" style="margin:2px 0 0">Searching…</p></div>'
    + '<div style="display:flex;gap:8px;margin-top:12px"><input placeholder="search ' + esc(CONN.name) + '…" id="q-' + doc + '" style="flex:1"><button class="ghost" data-search="' + doc + '">Search</button></div>'
    + '<button class="ghost mt" data-nomatch="' + doc + '">Don\\'t sync this book</button>';
  box.querySelectorAll('[data-choose]').forEach(bindChoose);
  box.querySelector('[data-search]').onclick = () => runSearch(doc, $('q-' + doc).value.trim());
  box.querySelector('[data-nomatch]').onclick = async () => {
    await jsend('/api/v1/connectors/' + ID + '/matches/' + doc, 'PUT', { external_id: null });
    renderList();
  };
  // Auto-suggest from the whole library using the book's own title.
  if (book && book.title) { $('q-' + doc).value = book.title; runSearch(doc, book.title, true); }
  else { $('results-' + doc).innerHTML = ''; }
}

async function runSearch(doc, q, isAuto) {
  if (!q) return;
  const res = $('results-' + doc);
  res.innerHTML = '<div class="grp">' + (isAuto ? 'Suggestions' : 'Results') + '</div><p class="muted" style="margin:2px 0 0">Searching…</p>';
  const r = await jget('/api/v1/connectors/' + ID + '/search?q=' + encodeURIComponent(q));
  const rows = (r.data.books || []).map(c => optionRow(doc, c)).join('');
  res.innerHTML = '<div class="grp">' + (isAuto ? 'Suggestions' : 'Results') + '</div>' + (rows || '<p class="muted" style="margin:2px 0 0">No matches found.</p>');
  res.querySelectorAll('[data-choose]').forEach(bindChoose);
}

function optionRow(doc, c) {
  return '<div class="row" style="padding:6px 0"><div>' + esc(c.title) + (c.author ? ' <span class="muted">· ' + esc(c.author) + '</span>' : '')
    + '</div><button class="ghost" data-choose=\\'' + esc(JSON.stringify({ doc, id: c.externalId, title: c.title, author: c.author, edition: c.edition })) + '\\'>Use</button></div>';
}
function bindChoose(btn) {
  btn.onclick = async () => {
    const p = JSON.parse(btn.dataset.choose);
    await jsend('/api/v1/connectors/' + ID + '/matches/' + p.doc, 'PUT', { external_id: p.id, external_edition: p.edition || null, title: p.title, author: p.author });
    renderList();
  };
}
</script>`
);

export function webRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/logo.png', (c) => {
    c.header('content-type', 'image/png');
    c.header('cache-control', 'public, max-age=86400');
    return c.body(LOGO);
  });
  app.get('/favicon.png', (c) => {
    c.header('content-type', 'image/png');
    c.header('cache-control', 'public, max-age=86400');
    return c.body(FAVICON);
  });
  app.get('/icons/:file', (c) => {
    const icon = SERVICE_ICONS.get(c.req.param('file').replace(/\.png$/, ''));
    if (!icon) return c.notFound();
    c.header('content-type', 'image/png');
    c.header('cache-control', 'public, max-age=604800');
    return c.body(new Uint8Array(icon));
  });

  app.get('/', (c) => {
    if (verifySession(getCookie(c, SESSION_COOKIE))) return c.redirect('/account');
    return c.html(LANDING);
  });

  app.get('/account', (c) => {
    if (!verifySession(getCookie(c, SESSION_COOKIE))) return c.redirect('/');
    return c.html(ACCOUNT);
  });

  app.get('/progress', (c) => {
    if (!verifySession(getCookie(c, SESSION_COOKIE))) return c.redirect('/');
    return c.html(PROGRESS);
  });

  app.get('/link/:id', (c) => {
    if (!verifySession(getCookie(c, SESSION_COOKIE))) return c.redirect('/');
    return c.html(LINK);
  });

  app.get('/review/:id', (c) => {
    if (!verifySession(getCookie(c, SESSION_COOKIE))) return c.redirect('/');
    return c.html(REVIEW);
  });

  return app;
}
