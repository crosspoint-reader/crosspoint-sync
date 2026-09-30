import SparkMD5 from 'spark-md5'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

// In the app, requests go through Rust (plain-http LAN servers, any CORS_ORIGINS);
// in a plain browser, the webview fetch.
export const isApp = '__TAURI_INTERNALS__' in window

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

export function logout() {
  localStorage.removeItem(KEY)
}

// Offline: every successful GET is kept on the device; when the network is down
// the last copy is served and an event lets the UI say so.
// ponytail: localStorage (~5 MB); move to IndexedDB if libraries outgrow it.
const OFFLINE = 'crosspoint-offline:'
export const offline = new EventTarget()

async function call(session, path, init = {}) {
  const key = `${OFFLINE}${session.username}@${session.server}${path}`
  const isGet = !init.method || init.method === 'GET'
  let res
  try {
    res = await http(session.server + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-auth-user': session.username,
        'x-auth-key': session.key,
      },
    })
  } catch (e) {
    const saved = isGet && localStorage.getItem(key)
    if (!saved) throw e
    offline.dispatchEvent(new Event('offline'))
    return JSON.parse(saved)
  }
  if (res.status === 401) throw Object.assign(new Error('Signed out'), { status: 401 })
  if (!res.ok) throw Object.assign(new Error(`Server error ${res.status}`), { status: res.status })
  const data = await res.json()
  if (isGet) {
    offline.dispatchEvent(new Event('online'))
    try {
      localStorage.setItem(key, JSON.stringify(data))
    } catch {
      // storage full: offline copy just stays older
    }
  }
  return data
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

export async function login(server, username, password) {
  const session = {
    server: await resolveServer(server),
    username: username.trim(),
    key: SparkMD5.hash(password),
  }
  await call(session, '/users/auth')
  localStorage.setItem(KEY, JSON.stringify(session))
  localStorage.setItem(LAST_SERVER, JSON.stringify(session.server))
  return session
}

export const api = {
  // Books a device synced without any metadata can't be shown meaningfully; hide them.
  books: (s) => call(s, '/api/v1/progress?limit=500').then((r) => r.items.filter((b) => b.title || b.filename)),
  summary: (s) => call(s, '/api/v1/stats/summary'),
  // tz: minutes behind UTC, so the server buckets pages into local days.
  activity: (s) => call(s, `/api/v1/stats/activity?tz=${new Date().getTimezoneOffset()}`),
  bookStats: (s, doc) => call(s, `/api/v1/stats/books/${doc}`),
  cover: (s, doc) => call(s, `/api/v1/documents/${doc}/cover`),
  setInfo: (s, doc, patch) => call(s, `/api/v1/documents/${doc}/info`, { method: 'PUT', body: JSON.stringify(patch) }),
  coverCandidates: (s, doc, q) => call(s, `/api/v1/documents/${doc}/cover/candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`).then((r) => r.items),
  // `document` becomes an alias of `into`: its progress, clippings and stats move there.
  merge: (s, document, into) => call(s, '/api/v1/documents/merge', { method: 'POST', body: JSON.stringify({ document, into }) }),
  unmerge: (s, alias) => call(s, `/api/v1/documents/merge/${alias}`, { method: 'DELETE' }),
  // Every clipping across books; older servers without /clippings get fetched book by book.
  async allClippings(s, books) {
    try {
      return (await call(s, '/api/v1/clippings')).items
    } catch (e) {
      if (e.status !== 404) throw e
      const per = await Promise.all(books.map((b) => api.clippings(s, b.document).then((items) => items.map((c) => ({ ...c, document: b.document })))))
      return per.flat().sort((a, b) => b.created_at - a.created_at)
    }
  },
  setStatus: (s, doc, status) =>
    call(s, `/api/v1/documents/${doc}/status`, { method: 'PUT', body: JSON.stringify({ status }) }),
  async clippings(s, doc) {
    const items = []
    for (let cursor = 0; ; ) {
      const page = await call(s, `/api/v1/clippings/${doc}?cursor=${cursor}&limit=100`)
      items.push(...page.items)
      if (!page.more) break
      cursor = page.cursor
    }
    return items.filter((c) => !c.deleted)
      .sort((a, b) => a.spine - b.spine || (a.start_offset ?? a.para ?? a.start_page) - (b.start_offset ?? b.para ?? b.start_page))
  },
}
