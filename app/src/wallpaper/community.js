import { http, isApp } from '../api.js'

// readme.club's community e-ink wallpapers.
//
// In the app: its /wallpapers pages, which take ?category=, ?q= and ?page= and
// embed each page's records as JSON (32 per page, ~3.9k in all). Those pages
// send no CORS header, so this needs the app's native fetch. Picking one reads
// the original image off the wallpaper's own page.
// In a plain browser: the RSS feed of the 50 newest (CORS-enabled, no categories).
// ponytail: this reads readme.club's page markup, not an API; swap in their API if they publish one.
const SITE = 'https://www.readme.club'
export const FEED = `${SITE}/wallpapers/rss.xml`

export const CATEGORIES = [
  ['', 'All'],
  ['dark', 'Dark'],
  ['light', 'Light'],
  ['minimalist', 'Minimalist'],
  ['pop_culture', 'Pop culture'],
  ['custom', 'Custom'],
  ['other', 'Other'],
]
export const canFilter = isApp

const memo = new Map()
const TTL = 10 * 60 * 1000
function cached(key, load) {
  const hit = memo.get(key)
  if (hit && Date.now() - hit.at < TTL) return hit.value
  const value = load().catch((e) => {
    memo.delete(key)
    throw e
  })
  memo.set(key, { at: Date.now(), value })
  return value
}

async function text(url) {
  const res = await http(url)
  if (!res.ok) throw new Error(`readme.club answered ${res.status}`)
  return res.text()
}

// One page of wallpapers: { items: [{ id, title, thumb, page, image? }], total }.
export function communityPage({ category = '', q = '', page = 1 } = {}) {
  if (!canFilter) return cached('rss', rssPage)
  const params = new URLSearchParams()
  if (category) params.set('category', category)
  if (q.trim()) params.set('q', q.trim())
  if (page > 1) params.set('page', String(page))
  const url = `${SITE}/wallpapers${params.size ? `?${params}` : ''}`
  return cached(url, async () => {
    const html = await text(url)
    // Detail links end in the first 8 hex digits of the record id.
    const links = new Map()
    for (const [, path, short] of html.matchAll(/href="(\/wallpapers\/[a-z0-9-]*?-([0-9a-f]{8}))"/g)) links.set(short, path)
    const items = []
    let total = 0
    for (const [json] of html.matchAll(/\{"id":"[0-9a-f-]{36}","title":.*?"total_count":\d+\}/g)) {
      let r
      try {
        r = JSON.parse(json)
      } catch {
        continue
      }
      total = r.total_count
      const path = links.get(r.id.slice(0, 8))
      if (r.is_nsfw || !path || !r.thumbnail_path) continue
      items.push({ id: r.id, title: r.title || 'Untitled', thumb: r.thumbnail_path, page: SITE + path, device: r.target_device })
    }
    return { items, total }
  })
}

async function rssPage() {
  const res = await fetch(FEED)
  if (!res.ok) throw new Error(`readme.club answered ${res.status}`)
  const doc = new DOMParser().parseFromString(await res.text(), 'application/xml')
  const tag = (el, t) => el.getElementsByTagName(t)[0]?.textContent?.trim() ?? ''
  const items = [...doc.getElementsByTagName('item')]
    .map((it) => {
      const image = it.getElementsByTagName('enclosure')[0]?.getAttribute('url') ?? ''
      return { id: image, title: tag(it, 'title') || 'Untitled', thumb: image, image, page: tag(it, 'link') }
    })
    .filter((w) => w.image.startsWith('https://'))
  return { items, total: items.length }
}

/** Full-size image URL for a picked wallpaper. */
export function fullImage(w) {
  if (w.image) return Promise.resolve(w.image)
  return cached(`img ${w.page}`, async () => {
    const html = await text(w.page)
    const m = html.match(/https:\/\/api\.readme\.club\/storage\/v1\/object\/public\/wallpapers\/[^"'\\\s]+/)
    // The thumbnail is still a usable (smaller) source if the page layout changes.
    return m ? m[0] : w.thumb
  })
}
