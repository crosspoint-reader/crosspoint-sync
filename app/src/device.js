import { invoke } from '@tauri-apps/api/core'
import { http, isApp } from './api.js'

// CrossPoint's on-device file server (File Transfer screen). Same protocol
// common-stacks uses: GET /api/status, GET /api/files?path=, POST /upload?path=.
export const DEFAULT_HOST = 'crosspoint.local'
export const EXTENSIONS = ['epub', 'md', 'txt']

const ext = (name) => name.split('.').pop().toLowerCase()
export const isBook = (file) => EXTENSIONS.includes(ext(file.name))

// Resolve crosspoint.local ourselves: Android's system resolver can't.
async function baseUrl(host) {
  const url = new URL(`http://${host.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '') || DEFAULT_HOST}`)
  if (isApp && url.hostname.endsWith('.local')) {
    const ip = await invoke('resolve_local', { host: url.hostname })
    if (ip) url.hostname = ip
  }
  return url.origin
}

export async function connect(host) {
  const base = await baseUrl(host)
  const res = await http(`${base}/api/status`, { signal: AbortSignal.timeout(6000) })
  if (!res.ok) throw new Error(`${host} answered, but it doesn't look like a CrossPoint reader.`)
  return { base, status: await res.json() }
}

export async function folders(base, path = '/') {
  const res = await http(`${base}/api/files?path=${encodeURIComponent(path)}`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) return []
  return (await res.json()).filter((f) => f.isDirectory).map((f) => f.name).sort()
}

// Reader settings shared by Send and Browse. optimize/quality drive the EPUB image optimizer.
const PREFS = 'crosspoint-device'
const DEFAULTS = { host: DEFAULT_HOST, folder: '/', optimize: false, quality: 70, renameFromMetadata: false }
export function loadDevicePrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREFS)) }
  } catch {
    return DEFAULTS
  }
}
export function saveDevicePrefs(p) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p))
  } catch {
    // per-device convenience only
  }
}

// File manager: the same endpoints CrossPoint's own web page uses.
export async function listFiles(base, path = '/') {
  const res = await http(`${base}/api/files?path=${encodeURIComponent(path)}`, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`Couldn't open ${path}`)
  return (await res.json())
    .filter((f) => !f.name.startsWith('.'))
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, undefined, { numeric: true }))
}

async function post(base, endpoint, fields) {
  const res = await http(`${base}/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  })
  if (!res.ok) throw new Error((await res.text()).trim() || `${endpoint} failed`)
}

export const joinPath = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`)
export const renameFile = (base, path, name) => post(base, 'rename', { path, name })
export const makeFolder = (base, path, name) => post(base, 'mkdir', { path, name })
export const deleteFiles = (base, paths) => post(base, 'delete', { paths: JSON.stringify(paths) })
