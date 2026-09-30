import { Channel, invoke } from '@tauri-apps/api/core'
import { connect } from './device.js'
import { ipcBytes } from './api.js'

// OPDS catalogs the user added. Stored per device.
// ponytail: credentials sit in localStorage like the sync login; move both to the OS keychain together.
const KEY = 'crosspoint-catalogs'
const STARTERS = [{ id: 'gutenberg', name: 'Project Gutenberg', url: 'https://m.gutenberg.org/ebooks.opds/', auth: { kind: 'none' } }]

export function loadCatalogs() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? STARTERS
  } catch {
    return STARTERS
  }
}

export function saveCatalogs(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    // stays in memory for this session
  }
}

// Feeds are cached for 10 minutes (like common-stacks) so returning to Browse is instant.
const TTL = 10 * 60 * 1000
const cache = new Map()
function memo(key, load) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.value
  const value = load().catch((e) => {
    cache.delete(key)
    throw e
  })
  cache.set(key, { at: Date.now(), value })
  return value
}
const authKey = (cat) => JSON.stringify(cat.auth ?? null)
export const feed = (cat, url = cat.url) => memo(`f ${authKey(cat)} ${url}`, () => invoke('opds_feed', { url, auth: cat.auth }))
export const search = (cat, query) => memo(`s ${authKey(cat)} ${cat.url} ${query}`, () => invoke('opds_search', { url: cat.url, query, auth: cat.auth }))

// Rows worth showing from a feed's navigation: drop page chrome (start, self, html alternates).
export const navRows = (links) =>
  links.filter((l) => !['start', 'self', 'alternate', 'search', 'up'].includes(l.rel) && !/html/.test(l.mime ?? ''))

// Formats CrossPoint reads, best first.
const FORMATS = [
  ['application/epub+zip', 'EPUB'],
  ['text/markdown', 'Markdown'],
  ['text/plain', 'Text'],
]
export function readable(entry) {
  return entry.acquisitions
    .map((a) => {
      const rank = FORMATS.findIndex(([m]) => a.mime?.startsWith(m))
      return rank < 0 ? null : { ...a, rank, label: a.title || FORMATS[rank][1] }
    })
    .filter(Boolean)
    .sort((a, b) => a.rank - b.rank)
}

const onProgress = (cb) => {
  const ch = new Channel()
  ch.onmessage = cb
  return ch
}

export const download = (cat, entry, acq, progress = () => {}) =>
  invoke('download_book', {
    url: acq.href,
    mime: acq.mime,
    auth: cat.auth,
    meta: { title: entry.title, author: entry.authors[0]?.replace(/^([^,]+), ([^,]+)$/, '$2 $1') ?? null, cover: entry.cover ?? entry.thumbnail ?? null, source: cat.name },
    onProgress: onProgress(progress),
  })

export const downloads = () => invoke('list_downloads')
export const removeDownload = (name) => invoke('delete_download', { name })

// Reader connection, cached briefly so a burst of sends doesn't re-resolve crosspoint.local each time.
let cached = null
export async function reader(prefs) {
  if (cached && cached.host === prefs.host && Date.now() - cached.at < 60_000) return cached.base
  const { base } = await connect(prefs.host)
  cached = { host: prefs.host, base, at: Date.now() }
  return base
}

const quality = (prefs) => (prefs.optimize ? prefs.quality : null)

export async function sendDownload(name, prefs, progress = () => {}) {
  const base = await reader(prefs)
  return invoke('send_download', { name, base, folder: prefs.folder, quality: quality(prefs), rename: prefs.renameFromMetadata, onProgress: onProgress(progress) })
}

// Files picked in the webview go to Rust as raw bytes (optimizer, metadata rename and upload live there).
// Both sends resolve to the file name used on the reader.
export async function sendFile(file, prefs) {
  const base = await reader(prefs)
  const headers = { 'x-name': encodeURIComponent(file.name), 'x-base': encodeURIComponent(base), 'x-folder': encodeURIComponent(prefs.folder) }
  if (prefs.optimize) headers['x-quality'] = String(prefs.quality)
  if (prefs.renameFromMetadata) headers['x-rename'] = '1'
  return invoke('send_bytes', await ipcBytes(file), { headers })
}
