// @vitest-environment node
import { Blob } from 'node:buffer'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
vi.mock('./api.js', () => ({ http: vi.fn() }))
const { http } = await import('./api.js')
const { coverBlob } = await import('./coverCache.js')
let saved
beforeEach(() => {
  saved = new Map()
  vi.stubGlobal('caches', { open: vi.fn(async () => ({ match: async url => saved.get(url), put: async (url, response) => saved.set(url, response) })) })
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  http.mockReset()
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue({ close() {} }))
})
afterEach(() => vi.unstubAllGlobals())
it('reuses an app-cached cover offline and never substitutes another URL', async () => {
  const blob = new Blob(['cover A'])
  http.mockResolvedValueOnce(new Response(blob))
  expect(await (await coverBlob('https://covers.test/a')).text()).toBe('cover A')
  http.mockRejectedValue(new Error('offline'))
  expect(await (await coverBlob('https://covers.test/a')).text()).toBe('cover A')
  await expect(coverBlob('https://covers.test/b')).rejects.toThrow('offline')
  expect(http).toHaveBeenCalledTimes(2)
})
it('can import a cover from the WebView HTTP cache', async () => {
  fetch.mockResolvedValue(new Response(new Blob(['webview cover'])))
  expect(await (await coverBlob('https://covers.test/c')).text()).toBe('webview cover')
  expect(fetch).toHaveBeenCalledWith('https://covers.test/c', { cache: 'force-cache' })
  expect(http).not.toHaveBeenCalled()
})
it('still downloads when persistent cache storage is unavailable', async () => {
  caches.open.mockRejectedValue(new Error('storage unavailable'))
  http.mockResolvedValue(new Response(new Blob(['cover'])))
  expect(await (await coverBlob('https://covers.test/d')).text()).toBe('cover')
})
it('does not cache unsuccessful HTTP responses', async () => {
  http.mockResolvedValue(new Response('', { status: 404 }))
  await expect(coverBlob('https://covers.test/missing')).rejects.toThrow()
  expect(saved.size).toBe(0)
})

it('does not poison the cache with a successful response that is not an image', async () => {
  http.mockResolvedValueOnce(new Response('captive portal'))
  createImageBitmap.mockRejectedValueOnce(new Error('invalid image'))
  await expect(coverBlob('https://covers.test/retry')).rejects.toThrow('invalid image')
  expect(saved.size).toBe(0)
  http.mockResolvedValueOnce(new Response('image bytes'))
  expect(await (await coverBlob('https://covers.test/retry')).text()).toBe('image bytes')
})
