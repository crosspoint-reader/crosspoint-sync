import { http } from '../api.js'

// metadata.dev identifies the book and rewrites the EPUB's cover, title, author,
// description and series; the book's text is not touched. This uploads the whole
// file to that service, so it only runs when the user turned the setting on.
const API = 'https://api.metadata.dev/epub'
const LIMIT = 30 * 1024 * 1024 // the service's upload limit
const brief = (value) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return text.length > 80 ? `${text.slice(0, 80)}…` : text
}

// The repaired file, or null when it can't be repaired (the reason is logged):
// sending then carries on with the file as it was.
export async function repairEpub(file, onProgress = () => {}) {
  const start = performance.now()
  const log = (tag, message) => onProgress({ stage: 'repairing', log: { tag, message, elapsed: (performance.now() - start) / 1000 } })
  const skip = (why) => (log('INFO', `${why}; sent with its own cover and details.`), null)
  onProgress({ stage: 'repairing' })
  if (file.size > LIMIT) return skip('Too large for metadata.dev (30 MB limit)')
  try {
    const res = await http(API, { method: 'POST', headers: { 'content-type': 'application/epub+zip' }, body: file, signal: AbortSignal.timeout(90_000) })
    if (!res.ok) return skip(res.status === 404 ? "metadata.dev couldn't identify this book" : `metadata.dev couldn't repair this book (${res.status})`)
    const fixed = await res.blob()
    let report = {}
    try {
      report = JSON.parse(decodeURIComponent(res.headers.get('x-report') ?? '{}'))
    } catch {
      // the repaired file is still good without its report
    }
    for (const issue of report.issues ?? []) if (issue.now != null) log('FIX', `${issue.field}: ${issue.was == null ? 'missing' : brief(issue.was)} → ${brief(issue.now)}`)
    for (const note of report.notes ?? []) log('INFO', String(note))
    return new File([fixed], file.name, { type: 'application/epub+zip', lastModified: file.lastModified })
  } catch (e) {
    return skip(`Couldn't reach metadata.dev (${e?.message ?? e})`)
  }
}
