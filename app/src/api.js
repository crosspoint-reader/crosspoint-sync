import SparkMD5 from 'spark-md5'
import { publishShortcuts, supportsShortcuts } from './shortcutsCache.js'
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
  if (logoutPending) return logoutPending
  sessionVersion++
  clearOffline()
  logoutPending = Promise.resolve(publishShortcuts(null)).then(() => {
    // Discard reads started while native removal was waiting in the write queue.
    sessionVersion++
    clearOffline()
    localStorage.removeItem(KEY)
  }).finally(() => { logoutPending = null })
  return logoutPending
}

// Offline: every successful GET is kept on the device; when the network is down
// the last copy is served and an event lets the UI say so.
// ponytail: localStorage (~5 MB); move to IndexedDB if libraries outgrow it.
const OFFLINE_PREFIX = 'crosspoint-offline:'
// Older copies may have been filled by the dashboard cookie's account.
const OFFLINE = `${OFFLINE_PREFIX}v2:`
export const offline = new EventTarget()
let sessionVersion = 0
let readingVersion = 0
let logoutPending = null
let libraryReadSequence = 0
let latestLibraryRead = 0
let clippingReadSequence = 0
let latestClippingRead = 0
let latestHubRead = 0
const latestBookReads = new Map()

function finishClippingRead(version, sequence, document, fresh) {
  if (version !== sessionVersion) return
  const latest = document === undefined ? latestClippingRead : Math.max(latestHubRead, latestBookReads.get(document) ?? 0)
  if (sequence < latest) throw Object.assign(new Error('Reading data changed while loading'), { stale: true })
  // Cached fallbacks do not supersede a still-pending online refresh.
  if (!fresh) return
  latestClippingRead = Math.max(latestClippingRead, sequence)
  if (document === undefined) latestHubRead = sequence
  else latestBookReads.set(document, sequence)
}

function assertReadingVersion(session, reading) {
  if (session === sessionVersion && reading !== readingVersion) {
    throw Object.assign(new Error('Reading data changed while loading'), { stale: true })
  }
}
const offlineCopies = new WeakSet()

function clearOffline(session) {
  latestLibraryRead = 0
  latestClippingRead = latestHubRead = 0
  latestBookReads.clear()
  const prefix = session ? `${OFFLINE}${session.username}@${session.server}/` : OFFLINE_PREFIX
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith(prefix)) localStorage.removeItem(key)
  }
}

// store: false keeps the offline fallback but leaves saving to the caller.
async function call(session, path, init = {}, keepOffline = true, { offlineFallback = true, timestampSaved = false, store = true } = {}) {
  const version = sessionVersion
  const reading = readingVersion
  const readingGet = (!init.method || init.method === 'GET') && /^\/api\/v1\/(clippings|progress)([/?]|$)/.test(path)
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
    if (readingGet) assertReadingVersion(version, reading)
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
  if (readingGet) assertReadingVersion(version, reading)
  if (isGet && version === sessionVersion) {
    offline.dispatchEvent(new Event('online'))
    if (store) keep(key, data, timestampSaved)
  }
  return data
}

async function editBook(session, document, field, patch) {
  const version = sessionVersion
  const result = await call(session, `/api/v1/documents/${document}/${field}`, { method: 'PUT', body: JSON.stringify(patch) })
  // A later library refresh must not be overwritten by a pre-edit response.
  if (version === sessionVersion) {
    readingVersion++
    patchCachedBook(session, result.document ?? document, field, result)
    await syncShortcutsCache(session)?.catch(() => {})
  }
  return result
}

function keep(key, data, timestampSaved = false) {
  try {
    localStorage.setItem(key, JSON.stringify(data))
    if (timestampSaved) localStorage.setItem(`${key}:saved-at`, JSON.stringify(Date.now()))
    return true
  } catch {
    // storage full: offline copy just stays older
    return false
  }
}

// Remove a successful deletion from every saved representation of that book.
// An omitted id removes all of the book's clippings.
function removeCachedClipping(session, document, id) {
  const hubKey = `${OFFLINE}${session.username}@${session.server}/api/v1/clippings`
  const bookKey = `${hubKey}/${document}`
  for (const key of Object.keys(localStorage)) {
    const hub = key === hubKey
    if (!hub && key !== bookKey && !key.startsWith(`${bookKey}?`)) continue
    const data = read(key)
    if (!Array.isArray(data?.items)) continue
    const items = data.items.filter((c) => (id !== undefined && c.id !== id) || (hub && c.document !== document))
    if (items.length === data.items.length) continue
    // Removing one item doesn't make a capped response a complete collection.
    const truncated = hub && data.items.length >= 5000 ? { truncated: true } : {}
    keep(key, { ...data, ...truncated, items })
  }
}

const clippingOrder = (a, b) => a.spine - b.spine || (a.start_offset ?? a.para ?? a.start_page) - (b.start_offset ?? b.para ?? b.start_page)

// Stage complete clipping reads so a failed legacy batch cannot alter later snapshots.
async function readClippings(s, doc) {
  const complete = saved(s, `/api/v1/clippings/${doc}`)
  const items = []
  let fromCache = false
  try {
    for (let cursor = 0; ; ) {
      const path = `/api/v1/clippings/${doc}?cursor=${cursor}&limit=100`
      const page = await call(s, path, {}, true, { store: false, offlineFallback: !complete })
      fromCache ||= offlineCopies.has(page)
      items.push(...page.items)
      if (!page.more) break
      cursor = page.cursor
    }
  } catch (error) {
    if (!complete || error.status || error.stale) throw error
    offline.dispatchEvent(new Event('offline'))
    return { items: complete.items, fromCache: true }
  }
  const live = items.filter((c) => !c.deleted).sort(clippingOrder)
  return { items: live, fromCache }
}

function cacheClippings(s, doc, result, savedAt = Date.now()) {
  const key = `${OFFLINE}${s.username}@${s.server}/api/v1/clippings/${doc}`
  const previous = result.fromCache && read(key)
  const record = previous
    ? { items: previous.items, savedAt: Object.hasOwn(previous, 'savedAt') ? previous.savedAt : read(`${key}:saved-at`) }
    : { items: result.items, savedAt: result.fromCache ? null : savedAt }
  // Store one complete representation, including freshness. Free legacy page
  // copies first so migration doesn't require twice the payload's storage quota.
  const legacy = Object.keys(localStorage).filter((k) => k.startsWith(`${key}?`) || k === `${key}:saved-at`)
    .map((k) => [k, localStorage.getItem(k)])
  for (const [k] of legacy) localStorage.removeItem(k)
  try {
    localStorage.setItem(key, JSON.stringify(record))
    return true
  } catch {
    // setItem is atomic; the prior aggregate remains. Restore legacy fallbacks.
    for (const [k, value] of legacy) {
      try { localStorage.setItem(k, value) } catch { /* storage unavailable */ }
    }
    return false
  }
}

function cacheClippingsHub(s, data) {
  const key = `${OFFLINE}${s.username}@${s.server}/api/v1/clippings`
  const savedAt = offlineCopies.has(data)
    ? Object.hasOwn(data, 'savedAt') ? data.savedAt : read(`${key}:saved-at`)
    : Date.now()
  // One atomic write keeps payload and freshness consistent even at quota.
  if (!keep(key, { ...data, savedAt }) || !Number.isFinite(savedAt) || data.truncated || data.items.length >= 5000) return
  // A complete hub proves both presence and absence for every older book copy.
  // Persist that knowledge before a later capped response can use those copies.
  const documents = new Set(Object.keys(localStorage).filter((k) => k.startsWith(`${key}/`))
    .map((k) => k.slice(key.length + 1).split('?')[0].replace(/:saved-at$/, '')))
  const byDocument = new Map()
  for (const c of data.items) {
    if (!byDocument.has(c.document)) byDocument.set(c.document, [])
    byDocument.get(c.document).push(c)
  }
  for (const doc of documents) {
    const bookKey = `${key}/${doc}`
    const per = read(bookKey)
    const at = per && Object.hasOwn(per, 'savedAt') ? per.savedAt : read(`${bookKey}:saved-at`)
    if ((at ?? 0) > savedAt || (offlineCopies.has(data) && at === savedAt)) continue
    const previous = new Map(per?.items.map((c) => [c.id, c]) ?? [])
    const items = (byDocument.get(doc) ?? []).map(({ document, ...c }) => ({ ...previous.get(c.id), ...c })).sort(clippingOrder)
    if (!cacheClippings(s, doc, { items, fromCache: false }, savedAt)) {
      // Failed replacement must not leave a disproven copy available to revive.
      for (const k of Object.keys(localStorage)) {
        if (k === bookKey || k === `${bookKey}:saved-at` || k.startsWith(`${bookKey}?`)) localStorage.removeItem(k)
      }
    }
  }
}

function invalidateClippingCaches(s, documents) {
  const hubKey = `${OFFLINE}${s.username}@${s.server}/api/v1/clippings`
  const hub = read(hubKey)
  if (Array.isArray(hub?.items)) {
    const items = hub.items.filter((c) => !documents.includes(c.document))
    // Retain unrelated passages and their original freshness. The affected
    // books still need a fetch, so this filtered hub is an incomplete copy.
    if (items.length !== hub.items.length && !keep(hubKey, { ...hub, items, truncated: true })) {
      localStorage.removeItem(hubKey)
      localStorage.removeItem(`${hubKey}:saved-at`)
    }
  }
  for (const key of Object.keys(localStorage)) {
    if (documents.some((doc) => {
      const bookKey = `${hubKey}/${doc}`
      return key === bookKey || key === `${bookKey}:saved-at` || key.startsWith(`${bookKey}?`)
    })) localStorage.removeItem(key)
  }
}

const PROGRESS = '/api/v1/progress?limit=500'

function patchCachedBook(session, document, field, result) {
  const key = `${OFFLINE}${session.username}@${session.server}${PROGRESS}`
  const progress = read(key)
  if (!progress?.items.some((b) => b.document === document)) return
  // Clearing a manual status needs server-side reading stats to derive it.
  if (field === 'status' && result.status === null) {
    localStorage.removeItem(key)
    localStorage.removeItem(`${key}:saved-at`)
    return
  }
  const fields = field === 'info'
    ? ['title', 'author', 'language', 'cover_url', 'page_count', 'genres', 'moods', 'content_warnings', 'series', 'series_position', 'release_year']
    : field === 'status' ? ['status', 'status_at'] : ['status']
  const patch = Object.fromEntries(fields.filter((f) => Object.hasOwn(result, f) && (f !== 'status' || result[f] !== null)).map((f) => [f, result[f]]))
  const items = progress.items.map((b) => {
    if (b.document !== document) return b
    const edited = { ...b, ...patch }
    if (field === 'status' && patch.status) edited.pause_reason = patch.status === 'paused' ? 'manual' : null
    if (field === 'dates' && patch.status && patch.status !== b.status) {
      delete edited.status_at // The dates response does not include this timestamp.
      edited.pause_reason = null
    }
    return edited
  })
  // Keep the library's fetch time and the reader's Last Sync unchanged.
  if (!keep(key, { ...progress, items })) {
    localStorage.removeItem(key)
    localStorage.removeItem(`${key}:saved-at`)
  }
}

function removeCachedBook(session, document) {
  const prefix = `${OFFLINE}${session.username}@${session.server}`
  const key = `${prefix}${PROGRESS}`
  const progress = read(key)
  if (Array.isArray(progress?.items)) {
    keep(key, { ...progress, items: progress.items.filter((b) => b.document !== document) })
  }
  removeCachedClipping(session, document)
  // Discard complete and legacy per-book copies, including freshness metadata.
  for (const key of Object.keys(localStorage)) {
    for (const kind of ['progress', 'clippings']) {
      const bookKey = `${prefix}/api/v1/${kind}/${document}`
      if (key === bookKey || key === `${bookKey}:saved-at` || key.startsWith(`${bookKey}?`)) localStorage.removeItem(key)
    }
  }
}

// Every synced book: follows the server's pages, then saves the whole list as the first page's offline copy.
// A page that fails leaves the previous complete copy in place.
async function allProgress(session) {
  const version = sessionVersion
  const reading = readingVersion
  const sequence = ++libraryReadSequence
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
  assertReadingVersion(version, reading)
  const all = { items, next: null }
  if (version === sessionVersion) {
    if (sequence < latestLibraryRead) throw Object.assign(new Error('Reading data changed while loading'), { stale: true })
    if (!offlineCopies.has(first)) latestLibraryRead = sequence
    const key = `${OFFLINE}${session.username}@${session.server}${PROGRESS}`
    const savedAt = offlineCopies.has(first)
      ? Object.hasOwn(first, 'savedAt') ? first.savedAt : read(`${key}:saved-at`)
      : Date.now()
    // Commit the complete library and its freshness in one atomic write.
    keep(key, { ...all, savedAt })
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
  if (!supportsShortcuts()) return
  if (session && logoutPending) return
  if (!session) return publishShortcuts(null)
  const prefix = `${OFFLINE}${session.username}@${session.server}`
  const books = saved(session, PROGRESS)
  const all = saved(session, '/api/v1/clippings')
  const allAt = all && Object.hasOwn(all, 'savedAt') ? all.savedAt : read(`${prefix}/api/v1/clippings:saved-at`)
  let clippings = all ? { items: all.items.map((c) => ({ ...c, cachedAt: allAt })) } : null
  // Complete per-book fetches supersede older hub data, including deletions.
  const perPrefix = `${prefix}/api/v1/clippings/`
  for (const key of Object.keys(localStorage)) {
    if (!key.startsWith(perPrefix) || key.includes('?') || key.endsWith(':saved-at')) continue
    const doc = key.slice(perPrefix.length)
    const per = read(key)
    if (!per) continue
    const at = Object.hasOwn(per, 'savedAt') ? per.savedAt : read(`${key}:saved-at`)
    if (all && (at ?? 0) < (allAt ?? 0)) {
      if (all.truncated || all.items.length >= 5000) {
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
  return publishShortcuts({
    account: JSON.stringify([session.server, session.username]),
    books: books ? {
      savedAt: Object.hasOwn(books, 'savedAt') ? books.savedAt : read(`${prefix}${PROGRESS}:saved-at`),
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
  async clearData(s) {
    const version = sessionVersion
    const result = await call(s, '/api/v1/account/data', { method: 'DELETE' })
    if (version === sessionVersion) {
      sessionVersion++ // Older in-flight reads must not restore pre-clear data.
      clearOffline(s)
      await publishShortcuts(null) // Settings reloads as soon as this resolves.
    }
    return result
  },
  deleteAccount: (s) => call(s, '/api/v1/account', { method: 'DELETE' }),
  async removeBook(s, doc) {
    const version = sessionVersion
    const result = await call(s, `/api/v1/progress/${doc}`, { method: 'DELETE' })
    if (version === sessionVersion) {
      readingVersion++
      removeCachedBook(s, doc)
      await syncShortcutsCache(s)?.catch(() => {})
    }
    return result
  },
  // Manual reading dates: { start_date, finished_date } as 'YYYY-MM-DD', null clears, omitted = unchanged.
  setDates: (s, doc, dates) => editBook(s, doc, 'dates', dates),
  setInfo: (s, doc, patch) => editBook(s, doc, 'info', patch),
  coverCandidates: (s, doc, q) => call(s, `/api/v1/documents/${doc}/cover/candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => r.items),
  // `document` becomes an alias of `into`: its progress, clippings and stats move there.
  async merge(s, document, into, stats = true) {
    const version = sessionVersion
    const result = await call(s, '/api/v1/documents/merge', { method: 'POST', body: JSON.stringify({ document, into, stats }) })
    if (version === sessionVersion) {
      readingVersion++
      invalidateClippingCaches(s, [document, into])
      removeCachedBook(s, document)
      // The server selects furthest progress and assigns a new Last Sync.
      // Its merge response lacks those values; fetch before exposing the target.
      removeCachedBook(s, into)
      await syncShortcutsCache(s)?.catch(() => {})
    }
    return result
  },
  unmerge: (s, alias) => call(s, `/api/v1/documents/merge/${alias}`, { method: 'DELETE' }),
  // Every clipping across books; older servers without /clippings get fetched book by book.
  async allClippings(s, books) {
    const version = sessionVersion
    const reading = readingVersion
    const sequence = ++clippingReadSequence
    try {
      const data = await call(s, '/api/v1/clippings', {}, true, { store: false })
      assertReadingVersion(version, reading)
      finishClippingRead(version, sequence, undefined, !offlineCopies.has(data))
      if (version === sessionVersion) {
        cacheClippingsHub(s, data)
        syncShortcutsCache(s)
      }
      return data.items
    } catch (e) {
      if (version !== sessionVersion || e.status !== 404) throw e
      assertReadingVersion(version, reading)
      const per = await Promise.all(books.map(async (b) => ({ document: b.document, ...await readClippings(s, b.document) })))
      assertReadingVersion(version, reading)
      const fresh = per.every((result) => !result.fromCache)
      finishClippingRead(version, sequence, undefined, fresh)
      if (!fresh) {
        for (const result of per) {
          if (!result.fromCache) finishClippingRead(version, sequence, result.document, true)
        }
      }
      if (version === sessionVersion) {
        if (!per.length) cacheClippingsHub(s, { items: [] })
        for (const result of per) cacheClippings(s, result.document, result)
        syncShortcutsCache(s)
      }
      return per.flatMap((result) => result.items.map((c) => ({ ...c, document: result.document })))
        .sort((a, b) => b.created_at - a.created_at)
    }
  },
  async deleteClipping(s, doc, id) {
    const version = sessionVersion
    const result = await call(s, `/api/v1/clippings/${doc}`, { method: 'PUT', body: JSON.stringify({ items: [{ id, deleted: 1 }] }) })
    if (version === sessionVersion) {
      readingVersion++ // Reads begun before this deletion cannot restore it.
      removeCachedClipping(s, doc, id)
      // Native publication already logs failures; the server deletion succeeded.
      await syncShortcutsCache(s)?.catch(() => {})
    }
    return result
  },
  setStatus: (s, doc, status) => editBook(s, doc, 'status', { status }),
  async clippings(s, doc, { syncShortcuts = true } = {}) {
    const version = sessionVersion
    const reading = readingVersion
    const sequence = ++clippingReadSequence
    const result = await readClippings(s, doc)
    assertReadingVersion(version, reading)
    finishClippingRead(version, sequence, doc, !result.fromCache)
    if (version === sessionVersion) {
      cacheClippings(s, doc, result)
      if (syncShortcuts) syncShortcutsCache(s)
    }
    return result.items
  },
}
