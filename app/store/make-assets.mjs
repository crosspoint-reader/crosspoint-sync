// Builds the Google Play and App Store images from the real app UI: seeds a throwaway sync
// server, serves the app with Vite, captures each screen in Chrome, then frames the
// captures with frame.html. Usage: node make-assets.mjs [out-dir]. See README.md.
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const APP = path.join(HERE, '..')
const ROOT = path.join(APP, '..')
const OUT = path.resolve(process.argv[2] ?? path.join(HERE, 'out'))
const TMP = mkdtempSync(path.join(tmpdir(), 'cps-store-'))
const SYNC_PORT = 8799, READER_PORT = 8798, VITE_PORT = 1430
// The app talks to these; Chrome reroutes them to the local stand-ins.
const SERVER = 'https://sync.crosspointreader.com', READER = 'http://crosspoint.local'

const md5 = (s) => createHash('md5').update(s).digest('hex')
const USER = 'maya', KEY = md5('demo'), DEVICE = 'X3A1B2C3'
const now = Math.floor(Date.now() / 1000), DAY = 86400
const iso = (daysAgo) => new Date((now - daysAgo * DAY) * 1000).toISOString().slice(0, 10)

// Public-domain books, with Project Gutenberg ids for their scanned covers.
// [title, author, Gutenberg id, percent read, status, print pages, [started, finished] days ago]
const BOOKS = [
  ['Middlemarch', 'George Eliot', 145, 0.62, 'reading', 793, [9, 0]],
  ['The Count of Monte Cristo', 'Alexandre Dumas', 1184, 0.34, 'reading', 1276, [30, 1]],
  ['Frankenstein', 'Mary Shelley', 84, 0.88, 'reading', 280, [3, 0]],
  ['Pride and Prejudice', 'Jane Austen', 1342, 1, 'finished', 432, [52, 41]],
  ['Jane Eyre', 'Charlotte Brontë', 1260, 1, 'finished', 532, [39, 27]],
  ['The Picture of Dorian Gray', 'Oscar Wilde', 174, 1, 'finished', 254, [26, 22]],
  ['Moby-Dick', 'Herman Melville', 2701, 0.21, 'paused', 720, [60, 45]],
  ['Little Women', 'Louisa May Alcott', 514, 1, 'finished', 449, [80, 64]],
  ['Dracula', 'Bram Stoker', 345, 1, 'finished', 418, [20, 12]],
  ['Wuthering Heights', 'Emily Brontë', 768, 1, 'finished', 416, [11, 4]],
]
const CLIPPINGS = [
  ['Middlemarch', 'What do we live for, if it is not to make life less difficult to each other?', 'Chapter 72', 3 * DAY],
  ['Middlemarch', 'It is a narrow mind which cannot look at a subject from various points of view.', 'Chapter 7', 6 * DAY],
  ['Frankenstein', 'Beware; for I am fearless, and therefore powerful.', 'Chapter 20', 2 * 3600],
  ['Frankenstein', 'Nothing is so painful to the human mind as a great and sudden change.', 'Chapter 10', DAY],
  ['Jane Eyre', 'I am no bird; and no net ensnares me: I am a free human being with an independent will.', 'Chapter 23', 30 * DAY],
]

// Capture setups: tag: [viewport, device scale, mobile, safe-area insets [top, bottom] in CSS px].
const DEVICES = {
  phone: [{ width: 360, height: 800 }, 3, true],
  t7: [{ width: 600, height: 960 }, 2, false],
  t10: [{ width: 1280, height: 800 }, 2, false],
  iphone: [{ width: 440, height: 956 }, 3, true, [62, 34]], // iPhone 6.9"
  ipad: [{ width: 1032, height: 1376 }, 2, false, [24, 20]], // iPad 13"
}
const ROUTES = { library: '', book: `book/${md5('Middlemarch')}`, stats: 'stats', clippings: 'clippings', settings: 'settings', send: 'send', days: 'stats' }

// Callout crops in capture pixels: [x, y, width, height]. Re-measure if the UI layout moves.
const CROPS = {
  phone: { chart: [48, 1325, 984, 690], quote: [45, 400, 990, 570], device: [48, 828, 984, 245], conn: [48, 262, 984, 500] },
  t7: { chart: [58, 890, 1084, 460], quote: [58, 272, 1084, 320], device: [58, 500, 1084, 180], conn: [54, 1048, 1092, 270] },
  t10: { chart: [600, 738, 1856, 400], quote: [604, 248, 1312, 280], device: [604, 466, 896, 160] },
  iphone: { chart: [48, 1511, 1224, 690], quote: [45, 586, 1230, 570], device: [48, 943, 1226, 245], conn: [48, 448, 1226, 450] },
  duo: {}, // measured below
  ipad: { chart: [600, 786, 1400, 400], quote: [604, 296, 1300, 280], device: [607, 512, 650, 165], conn: [607, 871, 666, 289], svc: [607, 1048, 1155, 298] },
}
// Whole UI cards for the App Store header and search images: [iphone screen, crop in capture pixels].
const CARDS = {
  book: ['library', [44, 972, 1232, 612]],
  days: ['days', [44, 204, 1232, 1176]],
  quote: ['clippings', [4, 424, 1312, 752]],
  chart: ['stats', [44, 1442, 1232, 680]],
  services: ['settings', [46, 446, 1230, 454]],
}
const CAPTIONS = {
  library: ['Your reading, everywhere', 'Every book you’re reading, in one place'],
  book: ['Pick up where you left off', 'Progress synced from your CrossPoint reader'],
  stats: ['How you read', 'Streaks, pages, and finished books'],
  clippings: ['Passages worth keeping', 'Your highlights, ready to share'],
  send: ['Send to reader', 'Books to your CrossPoint over Wi‑Fi'],
  settings: ['Connected services', 'Sync to the services you already use'],
}
// The iPhone Duo set runs the real app in this simulator; DUO=0 skips it.
// Its own simulator, named so `tauri ios dev` can't match a real iPhone Duo instead.
const DUO = process.env.DUO !== '0', DUO_SIM = 'CrossPoint Store Duo'
let simShot = {}, simPolled = false // what the simulator app shows; set once it first polls
// [output prefix, device, canvas size, frame device, [[screen, layout, crop]], scale]
// iOS canvases are drawn near the 1080-wide layouts and scaled up to Apple's exact pixel sizes.
const SETS = [
  ['phone', 'phone', [1080, 1920], 'phone', [
    ['library', 'top'], ['book', 'bottom'], ['stats', 'tiltcall', 'chart'],
    ['clippings', 'paper', 'quote'], ['send', 'split', 'device'], ['settings', 'paper', 'conn'],
  ]],
  ['tablet-7in', 't7', [1080, 1920], 'tablet', [
    ['library', 'p-top'], ['book', 'p-paper', 'conn'], ['stats', 'p-tiltcall', 'chart'],
    ['clippings', 'p-bottom'], ['send', 'p-split', 'device'],
  ]],
  ['tablet-10in', 't10', [2560, 1440], 'wide', [
    ['library', 'l-left'], ['book', 'l-right'], ['stats', 'l-top', 'chart'],
    ['clippings', 'l-paper', 'quote'], ['send', 'l-paper', 'device'],
  ]],
  ['iphone-6.9in', 'iphone', [1100, 2390], 'iphone', [
    ['library', 'top'], ['book', 'bottom'], ['stats', 'tiltcall', 'chart'],
    ['clippings', 'paper', 'quote'], ['send', 'split', 'device'], ['settings', 'paper', 'conn'],
  ], 1.2],
  ['ipad-13in', 'ipad', [1032, 1376], 'ipad', [
    ['library', 'p-top'], ['book', 'p-paper', 'conn'], ['stats', 'p-tiltcall', 'chart'],
    ['clippings', 'p-bottom'], ['send', 'p-split', 'device'], ['settings', 'p-paper', 'svc'],
  ], 2],
  // Captured from the iPhone Duo simulator (inner display), not Chrome; resized to exactly 2007x2853 below.
  ['iphone-duo', 'duo', [1032, 1467], 'duo', [
    ['library', 'p-top'], ['book', 'p-paper', 'conn'], ['stats', 'p-tiltcall', 'chart'],
    ['clippings', 'p-bottom'], ['send', 'p-split', 'device'], ['settings', 'p-paper', 'conn'],
  ], 2007 / 1032],
].filter(([prefix]) => prefix !== 'iphone-duo' || DUO)

const stops = []
try {
  mkdirSync(OUT, { recursive: true })
  mkdirSync(path.join(TMP, 'raw'))
  await startSyncServer()
  startReader(await fetchCovers())
  await seed()
  await startVite()

  const browser = await chromium.launch({ channel: 'chrome' })
  stops.push(() => browser.close())
  for (const [tag, [viewport, scale, mobile, insets]] of Object.entries(DEVICES)) {
    // Settings only where a store set uses it; the reading-days grid only for the App Store search card.
    const screens = Object.keys(ROUTES).filter((s) => (s !== 'settings' || ['phone', 'iphone', 'ipad'].includes(tag)) && (s !== 'days' || tag === 'iphone'))
    await capture(browser, tag, viewport, scale, mobile, screens, insets)
  }
  if (DUO) await captureDuo(Object.keys(ROUTES).filter((s) => s !== 'days'))
  for (const [prefix, tag, [w, h], dev, frames, scale] of SETS) {
    for (const [n, [screen, layout, crop]] of frames.entries()) {
      const [kick, head] = CAPTIONS[screen]
      const name = `${prefix}-${n + 1}-${screen}.png`
      await frame(browser, w, h, { layout, dev, kick, head, shot: raw(`${tag}-${screen}`), crop: crop && CROPS[tag][crop] }, name, scale)
      // A fractional scale can land a pixel off Apple's size; no alpha either.
      if (tag === 'duo') execFileSync('magick', [path.join(OUT, name), '-resize', '2007x2853!', '-alpha', 'off', `PNG24:${path.join(OUT, name)}`])
    }
  }
  const icon = `data:image/svg+xml;base64,${readFileSync(path.join(APP, 'src-tauri/icons/icon-ios.svg')).toString('base64')}`
  await frame(browser, 1024, 500, { layout: 'feature', dev: 'phone', kick: 'Your reading, everywhere', head: 'CrossPoint Sync', shot: raw('phone-library'), icon }, 'feature-graphic.jpg')
  // App Store Creative Assets (iOS 27+): product page header and search result card, PNG without alpha.
  const cards = Object.fromEntries(Object.entries(CARDS).map(([k, [screen, crop]]) => [k, [raw(`iphone-${screen}`), crop]]))
  await frame(browser, 1920, 823, { layout: 'header', kick: 'one place for your reading', head: 'Sync your CrossPoint Reader with all your favorite services', cards }, 'appstore-header.png', 2)
  await frame(browser, 1920, 1280, { layout: 'search', kick: 'for your CrossPoint Reader', head: 'Your reading, synced', cards }, 'appstore-search.png', 2)
  // Second option: the services it syncs to (Spotify is beta and Kindle hidden, so both stay out).
  const logos = [['hardcover', 'Hardcover'], ['readwise', 'Readwise'], ['bookfusion', 'BookFusion'], ['kosync', 'KOReader'],
    ['microblog', 'Micro.blog'], ['audiobookshelf', 'Audiobookshelf'], ['jellyfin', 'Jellyfin'], ['bookorbit', 'BookOrbit'], ['seekquel', 'Seekquel']]
    .map(([id, name]) => ({ name, src: pathToFileURL(path.join(APP, '..', 'assets/icons', `${id}.png`)).href }))
  await frame(browser, 1920, 823, { layout: 'header-logos', kick: 'one place for your reading', head: 'Sync your CrossPoint Reader with all your favorite services', logos }, 'appstore-header-logos.png', 2)
  await frame(browser, 1920, 1280, { layout: 'search-logos', kick: 'one place for your reading', head: 'Sync your CrossPoint Reader with all your favorite services', logos }, 'appstore-search-logos.png', 2)
  for (const name of ['appstore-header.png', 'appstore-search.png', 'appstore-header-logos.png', 'appstore-search-logos.png']) {
    execFileSync('magick', [path.join(OUT, name), '-alpha', 'off', `PNG24:${path.join(OUT, name)}`])
  }
  await renderIcon(browser, icon)
  console.log(`Store assets written to ${OUT}`)
} finally {
  for (const stop of stops.reverse()) await stop()
  // KEEP_RAW=1 keeps the raw captures, for re-measuring CROPS.
  if (process.env.KEEP_RAW) console.log(`Raw captures in ${TMP}/raw`)
  else rmSync(TMP, { recursive: true, force: true })
}

function raw(name) {
  return pathToFileURL(path.join(TMP, 'raw', `${name}.png`)).href
}

async function startSyncServer() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, PORT: String(SYNC_PORT), DATABASE_PATH: path.join(TMP, 'sync.sqlite'), TOKEN_ENC_KEY: randomBytes(32).toString('hex'), AUTH_RATE_LIMIT_PER_MINUTE: '0' },
  })
  stops.push(() => child.kill())
  for (let i = 0; i < 100; i++) {
    if (await fetch(`http://localhost:${SYNC_PORT}/healthz`).then((r) => r.ok, () => false)) return
    await sleep(200)
  }
  throw new Error('sync server did not start')
}

// Gutenberg's scanned covers are 200px wide; upscale them so they stay sharp at 3x.
async function fetchCovers() {
  mkdirSync(path.join(TMP, 'covers'))
  const covers = {}
  for (const [, , id] of BOOKS) {
    const res = await fetch(`https://gutenberg.pglaf.org/cache/epub/${id}/pg${id}.cover.medium.jpg`)
    if (!res.ok) throw new Error(`cover ${id}: HTTP ${res.status}`)
    const src = path.join(TMP, 'covers', `${id}-src.jpg`), dst = path.join(TMP, 'covers', `${id}.jpg`)
    writeFileSync(src, Buffer.from(await res.arrayBuffer()))
    execFileSync('magick', [src, '-filter', 'Lanczos', '-resize', '600x', dst])
    covers[id] = readFileSync(dst)
  }
  return covers
}

// Stands in for a CrossPoint X3's File Transfer server (and hosts the covers).
function startReader(covers) {
  const files = {
    '/': [['Books', true], ['Classics', true], ['Middlemarch - George Eliot.epub', false, 1843200], ['Frankenstein - Mary Shelley.epub', false, 512000], ['The Count of Monte Cristo - Alexandre Dumas.epub', false, 2621440]],
    '/Books': [['Jane Eyre - Charlotte Bronte.epub', false, 1048576]],
    '/Classics': [['Dracula - Bram Stoker.epub', false, 870400]],
  }
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    res.setHeader('access-control-allow-origin', '*')
    const cover = url.pathname.match(/^\/covers\/(\d+)\.jpg$/)
    if (cover) return res.setHeader('content-type', 'image/jpeg'), res.end(covers[cover[1]])
    res.setHeader('content-type', 'application/json')
    if (url.pathname === '/api/status') return res.end(JSON.stringify({ device: 'X3', version: '1.6.5', ip: '192.168.1.42', mode: 'STA', rssi: -52 }))
    if (url.pathname === '/api/files') {
      const list = files[url.searchParams.get('path')] ?? []
      return res.end(JSON.stringify(list.map(([name, isDirectory, size = 0]) => ({ name, isDirectory, size, isEpub: name.endsWith('.epub') }))))
    }
    res.end('{}')
  }).listen(READER_PORT)
  stops.push(() => server.close())
}

async function seed() {
  const headers = { 'content-type': 'application/json', 'x-auth-user': USER, 'x-auth-key': KEY }
  const api = async (method, route, body, h = headers) => {
    const res = await fetch(`http://localhost:${SYNC_PORT}${route}`, { method, headers: h, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`)
  }
  await api('POST', '/users/create', { username: USER, password: KEY }, { 'content-type': 'application/json' })
  for (const [title, authors, id, percentage, status, pages, [start, finish]] of BOOKS) {
    const document = md5(title)
    await api('PUT', '/syncs/progress', { document, progress: '/body/DocFragment[8]/body/p[4]/text()[1].9', percentage, device: 'CrossPoint X3', device_id: DEVICE, metadata: { title, authors, filename: `${title} - ${authors}.epub` } })
    if (status !== 'reading') await api('PUT', `/api/v1/documents/${document}/status`, { status })
    await api('PUT', `/api/v1/documents/${document}/dates`, status === 'finished' ? { start_date: iso(start), finished_date: iso(finish) } : { start_date: iso(start) })
    await api('PUT', `/api/v1/documents/${document}/info`, { cover_url: `http://localhost:${READER_PORT}/covers/${id}.jpg`, page_count: pages })
  }
  for (const [title, text, chapter, ago] of CLIPPINGS) {
    await api('PUT', `/api/v1/clippings/${md5(title)}`, { items: [{ id: md5(ago + text).slice(0, 16), spine: 3, start_page: 4, end_page: 4, pages: 30, start_word: 1, end_word: 20, words: 20, chapter, text, created_at: now - ago }] })
  }
  // Device stats snapshot: a 730-day reading-history bitmap, read most days lately.
  const bits = Buffer.alloc(92)
  for (let n = 0; n < 200; n++) if (n < 23 || Math.sin(n * 1.7) > -0.4) bits[n >> 3] |= 1 << (n & 7)
  await api('PUT', '/api/v1/stats/global', {
    device_id: DEVICE, device: 'CrossPoint X3', v: 5, sessions: 214, seconds: 361800, pages: 11840, completed: 6,
    tod: [36000, 52000, 168000, 105800], dow: [42000, 38000, 51000, 47000, 44000, 71000, 68800],
    anchor_day: Math.floor((now - Date.UTC(2000, 0, 1) / 1000) / DAY), history_b64: bits.toString('base64'), streak: 23,
  })

  // Linked services and a reading history can't come from the API (linking checks the
  // real service, and the log records server time), so write them directly.
  const db = new DatabaseSync(path.join(TMP, 'sync.sqlite'))
  db.exec('PRAGMA busy_timeout = 5000')
  const insertLink = db.prepare('INSERT INTO connector_accounts (user_id, connector_id, cred_enc, account_label, status, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)')
  insertLink.run('hardcover', 'x', 'maya', 'ok', now, now)
  insertLink.run('readwise-reader', 'x', 'maya@example.com', 'ok', now, now)
  const insertMatch = db.prepare("INSERT INTO connector_matches (user_id, connector_id, document, external_id, confidence, source, query_used, updated_at) VALUES (1, ?, ?, ?, 0.97, 'auto', ?, ?)")
  for (const title of ['Middlemarch', 'Frankenstein', 'The Count of Monte Cristo', 'Pride and Prejudice']) insertMatch.run('hardcover', md5(title), md5(title).slice(0, 6), title, now)
  insertMatch.run('readwise-reader', md5('Middlemarch'), 'rw1', 'Middlemarch', now)
  // Daily progress from each book's start to finish, skipping about one day in five.
  let r = 7
  const random = () => (r = (r * 16807) % 2147483647) / 2147483647
  const insertLog = db.prepare('INSERT INTO progress_log (user_id, document, device_id, percentage, at) VALUES (1, ?, ?, ?, ?)')
  db.exec('DELETE FROM progress_log')
  for (const [title, , , percentage, , , [start, finish]] of BOOKS) {
    const days = start - finish + 1
    for (let i = 0; i < days; i++) {
      if (i > 0 && i < days - 1 && random() < 0.2) continue
      const at = Math.min(now - (start - i) * DAY + Math.round((random() - 0.5) * 6 * 3600), now - 60)
      insertLog.run(md5(title), DEVICE, Number((percentage * (i + 1) / days).toFixed(4)), at)
    }
  }
  // Minutes read on each day of the history bitmap, so the Reading days grid shades them
  // against the median day: mostly typical days, some short, some long, longer at weekends.
  // (The upload takes 20 days at a time, so these go in directly too.)
  const insertDay = db.prepare('INSERT INTO stats_device_day (user_id, device_id, date, seconds, updated_at) VALUES (1, ?, ?, ?, ?)')
  for (let n = 0; n < 200; n++) {
    if (!(bits[n >> 3] & (1 << (n & 7)))) continue
    const x = random()
    const minutes = x < 0.2 ? 6 + x * 40 : x < 0.55 ? 20 + (x - 0.2) * 43 : x < 0.85 ? 40 + (x - 0.55) * 100 : 80 + (x - 0.85) * 466
    const weekend = [0, 6].includes(new Date((now - n * DAY) * 1000).getUTCDay())
    insertDay.run(DEVICE, iso(n), Math.round(minutes * 60 * (weekend ? 1.4 : 1)), now)
  }
  db.close()
}

async function startVite() {
  const { createServer } = await import(pathToFileURL(path.join(APP, 'node_modules/vite/dist/node/index.js')).href)
  const vite = await createServer({
    configFile: path.join(APP, 'vite.config.js'),
    root: APP,
    cacheDir: path.join(HERE, 'node_modules/.vite'),
    logLevel: 'warn',
    // All interfaces: `tauri ios dev` points the simulator at the Mac's LAN address.
    server: { port: VITE_PORT, strictPort: true, host: true },
    resolve: { alias: { '@tauri-apps/plugin-http': path.join(HERE, 'http-shim.js') } },
    plugins: [simDriver()],
  })
  await vite.listen()
  stops.push(() => vite.close())
}

// The simulator app loads ?sim: sign in to the local stand-ins, then follow /__shot ({route, anchor})
// set by captureDuo. Chrome never loads ?sim, so its captures are unaffected.
function simDriver() {
  const session = { server: `http://localhost:${SYNC_PORT}`, username: USER, key: KEY }
  const device = { host: `localhost:${READER_PORT}`, folder: '/', optimize: true, quality: 70, renameFromMetadata: true }
  const script = `if (location.search.includes('sim')) {
    localStorage.setItem('crosspoint-sync-session', ${JSON.stringify(JSON.stringify(session))})
    localStorage.setItem('crosspoint-device', ${JSON.stringify(JSON.stringify(device))})
    let shown
    setInterval(async () => {
      const { route, anchor } = await fetch('/__shot').then((r) => r.json())
      if (route === undefined || route + anchor === shown) return
      shown = route + anchor
      window.scrollTo(0, 0)
      location.hash = '#/' + route
      if (anchor) setTimeout(() => {
        const e = [...document.querySelectorAll('body *')].find((e) => !e.children.length && e.textContent.trim() === anchor)
        if (e) window.scrollBy(0, e.getBoundingClientRect().top - 24 - parseFloat(getComputedStyle(document.body).paddingTop))
      }, 2500)
    }, 300)
  }`
  return {
    name: 'sim-driver',
    transformIndexHtml: () => [{ tag: 'script', children: script, injectTo: 'head-prepend' }],
    configureServer: (server) => { server.middlewares.use('/__shot', (req, res) => (simPolled = true, res.end(JSON.stringify(simShot)))) },
  }
}

// Runs the real app in the iPhone Duo simulator (inner display, 2007x2853) against the stand-ins
// and screenshots each screen with simctl. The folded outer display isn't exposed by simctl.
async function captureDuo(screens) {
  const list = () => Object.values(JSON.parse(execFileSync('xcrun', ['simctl', 'list', 'devices', 'available', '-j'])).devices).flat()
  let sim = list().find((d) => d.name === DUO_SIM)
  if (!sim) execFileSync('xcrun', ['simctl', 'create', DUO_SIM, 'com.apple.CoreSimulator.SimDeviceType.iPhone-Duo']), sim = list().find((d) => d.name === DUO_SIM)
  const udid = sim.udid
  if (sim.state !== 'Booted') execFileSync('xcrun', ['simctl', 'bootstatus', udid, '-b'])
  const log = path.join(TMP, 'duo.log')
  const config = JSON.stringify({ build: { devUrl: `http://localhost:${VITE_PORT}/?sim=1`, beforeDevCommand: '' } })
  const child = spawn('npx', ['tauri', 'ios', 'dev', DUO_SIM, '--no-watch', '--config', config], { cwd: APP, detached: true, stdio: ['ignore', openSync(log, 'w'), openSync(log, 'a')] })
  stops.push(() => { try { process.kill(-child.pid) } catch {} })
  // First build takes minutes; the app is up once it polls /__shot.
  for (let i = 0; !simPolled; i++) {
    if (i > 1200 || child.exitCode !== null) throw new Error(`iPhone Duo app did not start, see:\n${readFileSync(log, 'utf8').slice(-2000)}`)
    await sleep(500)
  }
  execFileSync('xcrun', ['simctl', 'ui', udid, 'appearance', 'light'])
  execFileSync('xcrun', ['simctl', 'status_bar', udid, 'override', '--time', '9:41', '--batteryState', 'charged', '--batteryLevel', '100', '--cellularBars', '4', '--wifiBars', '3'])
  stops.push(() => execFileSync('xcrun', ['simctl', 'status_bar', udid, 'clear']))
  await sleep(3000)
  for (const screen of screens) {
    const anchor = screen === 'settings' ? 'Connected services' : ''
    simShot = { route: ROUTES[screen], anchor }
    await sleep(anchor ? 5000 : 4000) // covers and charts settle
    execFileSync('xcrun', ['simctl', 'io', udid, 'screenshot', path.join(TMP, 'raw', `duo-${screen}.png`)])
  }
}

async function capture(browser, tag, viewport, scale, mobile, screens, [top, bottom] = [0, 0]) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale, isMobile: mobile, hasTouch: true, colorScheme: 'light' })
  await ctx.addInitScript(({ session, device, top, bottom }) => {
    // The app pads for env(safe-area-inset-*), which a desktop browser reports as 0.
    if (top || bottom) document.addEventListener('DOMContentLoaded', () => document.head.insertAdjacentHTML('beforeend',
      `<style>body{padding-top:${top}px!important;padding-bottom:${bottom}px!important}nav.fixed.bottom-0{padding-bottom:${bottom}px!important}</style>`))
    localStorage.setItem('crosspoint-sync-session', JSON.stringify(session))
    localStorage.setItem('crosspoint-device', JSON.stringify(device))
    // Pretend to be the native app (shows Browse and Send). Native commands answer empty.
    let n = 0
    window.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { windowLabel: 'main', label: 'main' } },
      transformCallback: () => ++n,
      convertFileSrc: (p) => p,
      invoke: async (cmd) => (cmd === 'list_downloads' ? [] : null),
    }
  }, { session: { server: SERVER, username: USER, key: KEY }, device: { host: 'crosspoint.local', folder: '/', optimize: true, quality: 70, renameFromMetadata: true }, top, bottom })
  const proxy = (from, to) => async (route) => {
    const req = route.request()
    const res = await ctx.request.fetch(req.url().replace(from, to), { method: req.method(), headers: req.headers(), data: req.postDataBuffer() ?? undefined })
    let body = await res.body()
    // Spotify is in beta and kept out of store materials.
    if (req.url().endsWith('/api/v1/connectors')) {
      const json = JSON.parse(body)
      json.connectors = json.connectors.filter((c) => c.id !== 'spotify')
      body = JSON.stringify(json)
    }
    await route.fulfill({ response: res, body, headers: { ...res.headers(), 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' } })
  }
  await ctx.route(`${SERVER}/**`, proxy(SERVER, `http://localhost:${SYNC_PORT}`))
  await ctx.route(`${READER}/**`, proxy(READER, `http://localhost:${READER_PORT}`))
  const page = await ctx.newPage()
  for (const screen of screens) {
    await page.goto(`http://localhost:${VITE_PORT}/#/${ROUTES[screen]}`)
    await page.waitForTimeout(3500) // covers and charts settle
    // Scrolled captures: tablets show Connected services unscrolled; days is Stats down at its grid.
    const anchor = { settings: mobile && 'Connected services', days: 'Reading days' }[screen]
    if (anchor) {
      await page.getByText(anchor, { exact: true }).evaluate((e, top) => window.scrollBy(0, e.getBoundingClientRect().top - 24 - top), top)
      await page.waitForTimeout(500)
    }
    await page.screenshot({ path: path.join(TMP, 'raw', `${tag}-${screen}.png`) })
  }
  await ctx.close()
}

async function frame(browser, width, height, spec, name, scale = 1) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale })
  await page.goto(`${pathToFileURL(path.join(HERE, 'frame.html')).href}?spec=${encodeURIComponent(JSON.stringify(spec))}`)
  await page.waitForSelector('body[data-ready]', { state: 'attached' })
  await page.screenshot({ path: path.join(OUT, name), ...(name.endsWith('.jpg') && { type: 'jpeg', quality: 92 }) })
  await page.close()
}

// Play wants a 512x512 32-bit PNG.
async function renderIcon(browser, icon) {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } })
  await page.setContent(`<body style="margin:0"><img src="${icon}" width="512" height="512" style="display:block">`)
  await page.screenshot({ path: path.join(TMP, 'icon.png') })
  await page.close()
  execFileSync('magick', [path.join(TMP, 'icon.png'), `PNG32:${path.join(OUT, 'icon-512.png')}`])
}
