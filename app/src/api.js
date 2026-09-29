import SparkMD5 from 'spark-md5'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'

// In the app, requests go through Rust (plain-http LAN servers, any CORS_ORIGINS);
// in a plain browser, the webview fetch.
const http = '__TAURI_INTERNALS__' in window ? tauriFetch : fetch

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

async function call(session, path, init = {}) {
  const res = await http(session.server + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      'x-auth-user': session.username,
      'x-auth-key': session.key,
    },
  })
  if (res.status === 401) throw Object.assign(new Error('Signed out'), { status: 401 })
  if (!res.ok) throw new Error(`Server error ${res.status}`)
  return res.json()
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
  books: (s) => call(s, '/api/v1/progress?limit=500').then((r) => r.items),
  summary: (s) => call(s, '/api/v1/stats/summary'),
  // tz: minutes behind UTC, so the server buckets pages into local days.
  activity: (s) => call(s, `/api/v1/stats/activity?tz=${new Date().getTimezoneOffset()}`),
  bookStats: (s, doc) => call(s, `/api/v1/stats/books/${doc}`),
  cover: (s, doc) => call(s, `/api/v1/documents/${doc}/cover`),
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
