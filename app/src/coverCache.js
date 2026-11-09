import { http } from './api.js'

// Shared by library covers and widget publishing. Exact URLs keep corrected
// covers separate; never fall back to the last image downloaded for another book.
export async function coverBlob(url) {
  let cache
  try {
    cache = await caches.open('crosspoint-covers-v1')
    const saved = await cache.match(url)
    if (saved) return await saved.blob()
  } catch { /* Storage may be unavailable in a WebView. */ }
  // The app's <img> requests use the WebView cache, unlike Tauri's HTTP client.
  let blob
  const validate = async bytes => {
    const image = await createImageBitmap(bytes)
    image.close()
    return bytes
  }
  try {
    const response = await fetch(url, { cache: 'force-cache' })
    if (response.ok) blob = await validate(await response.blob())
  } catch { /* CORS, offline, or a cached non-image response. */ }
  if (!blob) {
    const response = await http(url)
    if (!response.ok) throw new Error('Cover unavailable')
    blob = await validate(await response.blob())
  }
  try { await cache?.put(url, new Response(blob)) } catch { /* Best effort. */ }
  return blob
}
