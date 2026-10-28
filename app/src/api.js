import SparkMD5 from 'spark-md5'
import { publishShortcuts } from './shortcutsCache.js'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

// In the app, requests go through Rust (plain-http LAN servers, any CORS_ORIGINS);
// in a plain browser, the webview fetch.
export const isApp = '__TAURI_INTERNALS__' in window
// Served by a sync server at /app/: that server is the only one to sign in to.
export function hostedServerUrl(url) {
  const match = url.pathname.match(/^(.*)\/app\/(?:index\.html)?$/)
  return /^https?:$/.test(url.protocol) && match ? url.origin + match[1] : null
}
export const hostedServer = !isApp ? hostedServerUrl(location) : null

// File bytes for raw-body commands (send_bytes, save_file). Android's WebView can't
// pass request bodies to Tauri's IPC protocol, so there the message is JSON-encoded
// and a Uint8Array would become a huge number array; send base64 text instead.
export async function ipcBytes(blob) {
  if (!/Android/i.test(navigator.userAgent)) return new Uint8Array(await blob.arrayBuffer())
  const url = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
  return url.slice(url.indexOf(',') + 1)
}
export const http = isApp ? tauriFetch : fetch

// kosync auth: x-auth-user + MD5(password), same credential the reader uses.
// ponytail: stored in localStorage; move to the OS keychain (tauri-plugin-stronghold) if that matters.
const KEY = 'crosspoint-sync-session'
const LAST_SERVER = 'crosspoint-sync-last-server'
export const DEFAULT_SERVER = 'https://sync.crosspointreader.com'

function read(key) {
  try {
    return JSON.parse(localStorage.getItem(key))
  } catch {
    return null
  }
}

export const loadSession = () => read(KEY)
export const lastServer = () => read(LAST_SERVER) ?? DEFAULT_SERVER

// After a password change: the same session with the new key.
export function saveSession(session) {
  localStorage.setItem(KEY, JSON.stringify(session))
}

export function logout() {
  sessionVersion++
  localStorage.removeItem(KEY)
  clearOffline()
  publishShortcuts(null)
}

// Offline: every successful GET is kept on the device; when the network is down
// the last copy is served and an event lets the UI say so.
// ponytail: localStorage (~5 MB); move to IndexedDB if libraries outgrow it.
const OFFLINE_PREFIX = 'crosspoint-offline:'
// Older copies may have been filled by the dashboard cookie's account.
const OFFLINE = `${OFFLINE_PREFIX}v2:`
export const offline = new EventTarget()
let sessionVersion = 0
const offlineCopies = new WeakSet()

function clearOffline() {
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(OFFLINE_PREFIX)) localStorage.removeItem(key)
  }
}

// store: false keeps the offline fallback but leaves saving to the caller.
async function call(session, path, init = {}, keepOffline = true, { offlineFallback = true, timestampSaved = false, store = true } = {}) {
  const version = sessionVersion
  const key = `${OFFLINE}${session.username}@${session.server}${path}`
  const isGet = keepOffline && (!init.method || init.method === 'GET')
  let res
  try {
    res = await http(session.server + path, {
      ...init,
      credentials: 'omit',
      cache: 'no-store',
      headers: {
        'content-type': 'application/json',
        'x-auth-user': session.username,
        'x-auth-key': session.key,
      },
    })
  } catch (e) {
    const saved = isGet && version === sessionVersion && localStorage.getItem(key)
    if (!saved || !offlineFallback) throw e
    offline.dispatchEvent(new Event('offline'))
    const data = JSON.parse(saved)
    offlineCopies.add(data)
    return data
  }
  if (res.status === 401) throw Object.assign(new Error('Signed out'), { status: 401 })
  if (!res.ok) {
    // Keep the server's reason (e.g. "Hardcover key is missing the read:me permission").
    const body = await res.json().catch(() => null)
    throw Object.assign(new Error(body?.message || `Server error ${res.status}`), { status: res.status })
  }
  const data = await res.json()
  if (isGet && version === sessionVersion) {
    offline.dispatchEvent(new Event('online'))
    if (store) keep(key, data, timestampSaved)
  }
  return data
}

function keep(key, data, timestampSaved = false) {
  try {
    localStorage.setItem(key, JSON.stringify(data))
    if (timestampSaved) localStorage.setItem(`${key}:saved-at`, JSON.stringify(Date.now()))
  } catch {
    // storage full: offline copy just stays older
  }
}

const PROGRESS = '/api/v1/progress?limit=500'

// Every synced book: follows the server's pages, then saves the whole list as the first page's offline copy.
// A page that fails leaves the previous complete copy in place.
async function allProgress(session) {
  const version = sessionVersion
  const first = await call(session, PROGRESS, {}, true, { store: false })
  const items = [...first.items]
  for (let next = first.next, seen = new Set(); next; ) {
    // A loop would otherwise end early and save a short list as the whole library.
    if (seen.has(next)) throw new Error('Server repeated a page cursor')
    seen.add(next)
    const page = await call(session, `${PROGRESS}&cursor=${encodeURIComponent(next)}`, {}, false)
    items.push(...page.items)
    next = page.next
  }
  const all = { items, next: null }
  if (version === sessionVersion) {
    keep(`${OFFLINE}${session.username}@${session.server}${PROGRESS}`, all, !offlineCopies.has(first))
    syncShortcutsCache(session)
  }
  return all
}

// "192.168.1.20:8080" or "sync.example.com" -> candidate base URLs, https first.
export function serverCandidates(input) {
  const s = input.trim().replace(/\/+$/, '')
  return /^https?:\/\//i.test(s) ? [s] : [`https://${s}`, `http://${s}`]
}

// First candidate that answers /healthz like a crosspoint-sync server (the app needs /api/v1, so stock kosync servers are out).
async function resolveServer(input) {
  for (const base of serverCandidates(input)) {
    try {
      const res = await http(`${base}/healthz`, { signal: AbortSignal.timeout(6000) })
      if (res.ok && (await res.json()).status === 'ok') return base
    } catch {
      // unreachable over this scheme; try the next
    }
  }
  throw new Error(`Could not reach a CrossPoint Sync server at ${input.trim()}.`)
}

/** Create a sync account (the same registration a reader does), then sign in to it. */
export async function register(server, username, password) {
  const base = await resolveServer(server)
  const res = await http(`${base}/users/create`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/vnd.koreader.v1+json' },
    body: JSON.stringify({ username: username.trim(), password: SparkMD5.hash(password) }),
  })
  if (res.status !== 201) {
    const body = await res.json().catch(() => null)
    throw new Error(
      res.status === 402 ? 'That username is taken.' : body?.message === 'Registration is disabled' ? 'This server does not allow new accounts.' : body?.message || `Server error ${res.status}`
    )
  }
  return login(base, username, password)
}

export async function login(server, username, password) {
  const session = {
    server: await resolveServer(server),
    username: username.trim(),
    key: SparkMD5.hash(password),
  }
  // Sign-in must be verified online, never accepted from an old offline copy.
  await call(session, '/users/auth', {}, false)
  sessionVersion++
  clearOffline()
  publishShortcuts(null)
  localStorage.setItem(KEY, JSON.stringify(session))
  localStorage.setItem(LAST_SERVER, JSON.stringify(session.server))
  return session
}

// The last saved copy of a GET (the offline cache), for painting before the network answers.
function saved(session, path) {
  try {
    return JSON.parse(localStorage.getItem(`${OFFLINE}${session.username}@${session.server}${path}`))
  } catch {
    return null
  }
}
// A book marked finished reads as 100% wherever the reader left off; the reader's
// real position stays in device_percentage (and on the server, which syncs it back).
const bookList = (r) =>
  r.items
    .filter((b) => b.title || b.filename)
    .map((b) => (b.status === 'finished' ? { ...b, device_percentage: b.percentage, percentage: 1 } : b))

// A credential-free mirror of the data already saved by this app. No requests.
export function syncShortcutsCache(session) {
  if (!isApp) return
  if (!session) return publishShortcuts(null)
  const prefix = `${OFFLINE}${session.username}@${session.server}`
  const books = saved(session, PROGRESS)
  const all = saved(session, '/api/v1/clippings')
  const allAt = read(`${prefix}/api/v1/clippings:saved-at`)
  let clippings = all ? { items: all.items.map((c) => ({ ...c, cachedAt: allAt })) } : null
  // Complete per-book fetches supersede older hub data, including deletions.
  const perPrefix = `${prefix}/api/v1/clippings/`
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(perPrefix) || key.includes('?') || key.endsWith(':saved-at')) continue
    const doc = key.slice(perPrefix.length)
    const per = read(key)
    const at = read(`${key}:saved-at`)
    if (!per) continue
    if (all && (at ?? 0) < (allAt ?? 0)) {
      if (all.items.length >= 5000) {
        // The capped hub cannot establish that omitted passages were deleted.
        const known = new Set(clippings.items.filter((c) => c.document === doc).map((c) => c.id))
        clippings.items.push(...per.items.filter((c) => !known.has(c.id)).map((c) => ({ ...c, document: doc, cachedAt: at })))
      }
      continue
    }
    clippings ??= { items: [] }
    clippings.items = clippings.items.filter((c) => c.document !== doc)
    clippings.items.push(...per.items.map((c) => ({ ...c, document: doc, cachedAt: at })))
  }
  // Allowlist fields rather than exposing server responses or session credentials.
  publishShortcuts({
    account: JSON.stringify([session.server, session.username]),
    books: books ? {
      savedAt: read(`${prefix}${PROGRESS}:saved-at`),
      items: bookList(books).map((b) => ({
        document: b.document, title: b.title || b.filename, author: b.author ?? '',
        status: b.status ?? 'reading', percentage: b.percentage, timestamp: b.timestamp,
      })),
    } : null,
    clippings: clippings ? { items: clippings.items.map((c) => ({
      document: c.document, id: c.id, text: c.text ?? '', note: c.note ?? '',
      chapter: c.chapter ?? '', created_at: c.created_at ?? 0, cachedAt: c.cachedAt,
    })) } : null,
  })
}

export const cached = {
  books: (s) => {
    const r = saved(s, PROGRESS)
    return r ? bookList(r) : null
  },
  summary: (s) => saved(s, '/api/v1/stats/summary'),
  clippings: (s) => saved(s, '/api/v1/clippings')?.items ?? null,
  activity: (s) => saved(s, `/api/v1/stats/activity?tz=${new Date().getTimezoneOffset()}`),
  activityUpdatedAt: (s) => {
    const at = saved(s, `/api/v1/stats/activity?tz=${new Date().getTimezoneOffset()}:saved-at`)
    return Number.isFinite(at) && at > 0 ? at : null
  },
}

export const api = {
  // Books a device synced without any metadata can't be shown meaningfully; hide them.
  books: (s) => allProgress(s).then(bookList),
  // The hidden ones, so they can be merged into the book they really are.
  untitledBooks: (s) => allProgress(s).then((r) => r.items.filter((b) => !b.title && !b.filename)),
  summary: (s) => call(s, '/api/v1/stats/summary'),
  // tz: minutes behind UTC, so the server buckets pages into local days.
  // Saved activity paints immediately via cached.activity, but a failed refresh
  // must reject so the screen can warn about stale data and retry.
  activity: (s) => call(s, `/api/v1/stats/activity?tz=${new Date().getTimezoneOffset()}`, {}, true, { offlineFallback: false, timestampSaved: true }),
  bookStats: (s, doc) => call(s, `/api/v1/stats/books/${doc}`),
  cover: (s, doc) => call(s, `/api/v1/documents/${doc}/cover`),
  next: (s, doc) => call(s, `/api/v1/documents/${doc}/next`),
  about: (s, doc) => call(s, `/api/v1/documents/${doc}/about`),
  // Connected services (same endpoints as the web dashboard).
  connectors: (s) => call(s, '/api/v1/connectors'),
  linkConnector: (s, id, credential) => call(s, `/api/v1/connectors/${id}`, { method: 'PUT', body: JSON.stringify({ credential }) }),
  unlinkConnector: (s, id) => call(s, `/api/v1/connectors/${id}`, { method: 'DELETE' }),
  syncConnector: (s, id) => call(s, `/api/v1/connectors/${id}/sync`, { method: 'POST' }),
  syncBook: (s, id, doc) => call(s, `/api/v1/connectors/${id}/sync/${doc}`, { method: 'POST' }),
  setConnectorOptions: (s, id, options) => call(s, `/api/v1/connectors/${id}/options`, { method: 'PUT', body: JSON.stringify(options) }),
  beginLink: (s, id) => call(s, `/api/v1/connectors/${id}/link/begin`, { method: 'POST' }),
  // Browser sign-in (OAuth): the server holds PKCE; the app finishes it only when its app link catches the redirect.
  oauthBegin: (s, id, client) => call(s, `/api/v1/connectors/${id}/oauth/begin`, { method: 'POST', body: JSON.stringify({ client }) }),
  setClientId: (s, id, clientId) =>
    call(s, `/api/v1/connectors/${id}/client-id`, { method: 'PUT', body: JSON.stringify({ client_id: clientId }) }),
  removeClientId: (s, id) => call(s, `/api/v1/connectors/${id}/client-id`, { method: 'DELETE' }),
  oauthComplete: (s, id, params) => call(s, `/api/v1/connectors/${id}/oauth/complete`, { method: 'POST', body: JSON.stringify(params) }),
  pollLink: (s, id, deviceCode) =>
    call(s, `/api/v1/connectors/${id}/link/poll`, { method: 'POST', body: JSON.stringify({ device_code: deviceCode }) }),
  // Matches review (which book at the service each synced title maps to).
  async review(s, id) {
    const url = `/api/v1/connectors/${id}/review`
    const first = await call(s, url)
    const books = [...first.books]
    for (let next = first.next, seen = new Set(); next; ) {
      if (seen.has(next)) throw new Error('Server repeated a page cursor')
      seen.add(next)
      const page = await call(s, `${url}?cursor=${encodeURIComponent(next)}`, {}, false)
      books.push(...page.books)
      next = page.next
    }
    return books
  },
  candidates: (s, id) => call(s, `/api/v1/connectors/${id}/candidates`).then((r) => r.books ?? []),
  searchConnector: (s, id, q) => call(s, `/api/v1/connectors/${id}/search?q=${encodeURIComponent(q)}`).then((r) => r.books ?? []),
  bookMatches: (s, doc) => call(s, `/api/v1/documents/${doc}/matches`).then((r) => r.services),
  // Spotify audiobook position, and "Resume in Spotify" (a user tap; never background sync).
  spotifyPosition: (s, doc) => call(s, `/api/v1/connectors/spotify/position/${doc}`),
  spotifySync: (s, doc) => call(s, `/api/v1/connectors/spotify/sync/${doc}`, { method: 'POST' }),
  spotifyResume: (s, doc) => call(s, `/api/v1/connectors/spotify/resume/${doc}`, { method: 'POST' }),
  // Calibration: the audiobook's tracks, and "my reader is here = this track at this time".
  spotifyTracks: (s, doc) => call(s, `/api/v1/connectors/spotify/tracks/${doc}`),
  setSpotifyAnchor: (s, doc, track, positionMs) =>
    call(s, `/api/v1/connectors/spotify/anchor/${doc}`, { method: 'PUT', body: JSON.stringify({ track, position_ms: positionMs }) }),
  clearSpotifyAnchor: (s, doc) => call(s, `/api/v1/connectors/spotify/anchor/${doc}`, { method: 'DELETE' }),
  // pick: a search/candidate row, or null for "don't sync this book".
  setMatch: (s, id, doc, pick) =>
    call(s, `/api/v1/connectors/${id}/matches/${doc}`, {
      method: 'PUT',
      body: JSON.stringify(pick ? { external_id: pick.externalId, external_edition: pick.edition ?? null, title: pick.title, author: pick.author } : { external_id: null }),
    }),
  // Days without progress before a book auto-pauses: { days } (0 = never).
  autoPause: (s) => call(s, '/api/v1/account/auto-pause'),
  setAutoPause: (s, days) => call(s, '/api/v1/account/auto-pause', { method: 'PUT', body: JSON.stringify({ days }) }),
  // Public reading profile: { slug } (null = off).
  profile: (s) => call(s, '/api/v1/profile'),
  setProfile: (s, enabled) => call(s, '/api/v1/profile', { method: 'PUT', body: JSON.stringify({ enabled }) }),
  // The sync account itself.
  changePassword: (s, password) => call(s, '/api/v1/account/password', { method: 'POST', body: JSON.stringify({ key: SparkMD5.hash(password) }) }),
  clearData: (s) => call(s, '/api/v1/account/data', { method: 'DELETE' }),
  deleteAccount: (s) => call(s, '/api/v1/account', { method: 'DELETE' }),
  removeBook: (s, doc) => call(s, `/api/v1/progress/${doc}`, { method: 'DELETE' }),
  // Manual reading dates: { start_date, finished_date } as 'YYYY-MM-DD', null clears, omitted = unchanged.
  setDates: (s, doc, dates) => call(s, `/api/v1/documents/${doc}/dates`, { method: 'PUT', body: JSON.stringify(dates) }),
  setInfo: (s, doc, patch) => call(s, `/api/v1/documents/${doc}/info`, { method: 'PUT', body: JSON.stringify(patch) }),
  coverCandidates: (s, doc, q) => call(s, `/api/v1/documents/${doc}/cover/candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => r.items),
  // `document` becomes an alias of `into`: its progress, clippings and stats move there.
  merge: (s, document, into, stats = true) => call(s, '/api/v1/documents/merge', { method: 'POST', body: JSON.stringify({ document, into, stats }) }),
  unmerge: (s, alias) => call(s, `/api/v1/documents/merge/${alias}`, { method: 'DELETE' }),
  // Every clipping across books; older servers without /clippings get fetched book by book.
  async allClippings(s, books) {
    const version = sessionVersion
    try {
      const data = await call(s, '/api/v1/clippings', {}, true, { timestampSaved: true })
      if (version === sessionVersion) syncShortcutsCache(s)
      return data.items
    } catch (e) {
      if (version !== sessionVersion || e.status !== 404) throw e
      const per = await Promise.all(books.map((b) => api.clippings(s, b.document).then((items) => items.map((c) => ({ ...c, document: b.document })))))
      return per.flat().sort((a, b) => b.created_at - a.created_at)
    }
  },
  deleteClipping: (s, doc, id) =>
    call(s, `/api/v1/clippings/${doc}`, { method: 'PUT', body: JSON.stringify({ items: [{ id, deleted: 1 }] }) }),
  setStatus: (s, doc, status) =>
    call(s, `/api/v1/documents/${doc}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  async clippings(s, doc) {
    const version = sessionVersion
    const items = []
    let fromCache = false
    for (let cursor = 0; ; ) {
      const page = await call(s, `/api/v1/clippings/${doc}?cursor=${cursor}&limit=100`)
      fromCache ||= offlineCopies.has(page)
      items.push(...page.items)
      if (!page.more) break
      cursor = page.cursor
    }
    const live = items.filter((c) => !c.deleted)
      .sort((a, b) => a.spine - b.spine || (a.start_offset ?? a.para ?? a.start_page) - (b.start_offset ?? b.para ?? b.start_page))
    if (version === sessionVersion) {
      // Migrate a complete legacy offline copy, but never overwrite a newer
      // complete snapshot with potentially mixed-age cached pages.
      if (!fromCache || !saved(s, `/api/v1/clippings/${doc}`)) {
        keep(`${OFFLINE}${s.username}@${s.server}/api/v1/clippings/${doc}`, { items: live }, !fromCache)
      }
      syncShortcutsCache(s)
    }
    return live
  },
}
