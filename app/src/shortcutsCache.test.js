// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue() }))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
window.__TAURI_INTERNALS__ = {}
vi.stubGlobal('localStorage', new JSDOM('', { url: 'https://app.test' }).window.localStorage)
const { invoke } = await import('@tauri-apps/api/core')
const { fetch: http } = await import('@tauri-apps/plugin-http')
const apiModule = await import('./api.js')
const { api, logout } = apiModule
const session = { server: 'https://sync.test', username: 'reader', key: 'secret' }
const response = (data) => ({ ok: true, status: 200, json: async () => data })
const book = { document: 'one', title: 'One', status: 'finished', percentage: 0.9, timestamp: 100 }
const flush = async () => { await new Promise((r) => setTimeout(r, 0)) }
const snapshot = () => {
  const calls = invoke.mock.calls.filter(([name]) => name === 'update_shortcuts')
  const json = calls.at(-1)?.[1].json
  return json ? JSON.parse(json) : null
}
beforeEach(async () => {
  logout()
  await flush()
  localStorage.clear()
  invoke.mockClear()
  http.mockReset()
})
it('publishes a complete library with normalized progress, fetch time and no credentials', async () => {
  http.mockResolvedValueOnce(response({ items: [book], next: 'next' }))
    .mockResolvedValueOnce(response({ items: [{ document: 'two', filename: 'Two', status: 'reading', percentage: 0.2, timestamp: 110 }], next: null }))
  await api.books(session)
  await flush()
  expect(snapshot()).toMatchObject({ account: '["https://sync.test","reader"]', books: { items: [
    { document: 'one', title: 'One', percentage: 1, timestamp: 100 },
    { document: 'two', title: 'Two', percentage: 0.2 },
  ] } })
  expect(snapshot().books.savedAt).toBeGreaterThan(0)
  expect(JSON.stringify(snapshot())).not.toContain('secret')
})
it('preserves fetch time on offline reads and when restoring the app cache', async () => {
  http.mockResolvedValueOnce(response({ items: [book] }))
  await api.books(session)
  await flush()
  const saved = snapshot().books.savedAt
  http.mockRejectedValue(new Error('offline'))
  await api.books(session)
  apiModule.syncShortcutsCache(session)
  await flush()
  expect(snapshot().books.savedAt).toBe(saved)
})
it('keeps the previous complete library if a later page fails', async () => {
  http.mockResolvedValueOnce(response({ items: [book] }))
  await api.books(session)
  await flush()
  const saved = snapshot()
  http.mockResolvedValueOnce(response({ items: [], next: 'next' })).mockRejectedValueOnce(new Error('offline'))
  await expect(api.books(session)).rejects.toThrow('offline')
  await flush()
  expect(snapshot()).toEqual(saved)
})
it('replaces one book’s clippings without retaining deletions or losing another book', async () => {
  http.mockResolvedValueOnce(response({ items: [book, { ...book, document: 'two', title: 'Two' }] }))
  await api.books(session)
  http.mockResolvedValueOnce(response({ items: [{ document: 'one', id: 'old', text: 'old' }, { document: 'two', id: 'other', text: 'other' }] }))
  await api.allClippings(session, [])
  http.mockResolvedValueOnce(response({ items: [{ id: 'new', text: 'new', created_at: 200 }], more: false }))
  await api.clippings(session, 'one')
  await flush()
  expect(snapshot().clippings.items.map((c) => c.id).sort()).toEqual(['new', 'other'])
  expect(snapshot().clippings.items.find((c) => c.id === 'new').document).toBe('one')
})
it('clears shared data on logout and ignores delayed responses', async () => {
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = api.books(session)
  logout()
  resolve(response({ items: [book] }))
  await pending
  await flush()
  expect(snapshot()).toBeNull()
})
it('makes complete legacy per-book caches available offline without inventing freshness', async () => {
  const prefix = 'crosspoint-offline:v2:reader@https://sync.test'
  localStorage.setItem(`${prefix}/api/v1/progress?limit=500`, JSON.stringify({ items: [book] }))
  localStorage.setItem(`${prefix}/api/v1/clippings/one?cursor=0&limit=100`, JSON.stringify({ items: [{ id: 'legacy', text: 'Saved before upgrade' }], more: false }))
  http.mockRejectedValue(new Error('offline'))
  await api.clippings(session, 'one')
  await flush()
  expect(snapshot().clippings.items).toMatchObject([{ id: 'legacy', cachedAt: null }])
})
it('does not republish old clippings after logout', async () => {
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = api.allClippings(session, [])
  logout()
  resolve(response({ items: [{ document: 'one', id: 'old' }] }))
  await pending
  await flush()
  expect(snapshot()).toBeNull()
})
it('keeps distinct accounts and servers from resolving each other’s data', async () => {
  http.mockResolvedValueOnce(response({ items: [book] }))
  await api.books(session)
  apiModule.syncShortcutsCache({ ...session, server: 'https://another.test' })
  await flush()
  expect(snapshot()).toMatchObject({ account: '["https://another.test","reader"]', books: null, clippings: null })
})
it('retains older per-book clippings when the newer all-book response reaches its 5000-item cap', async () => {
  http.mockResolvedValueOnce(response({ items: [book] }))
  await api.books(session)
  http.mockResolvedValueOnce(response({ items: [{ id: 'old', text: 'Old passage', created_at: 1 }], more: false }))
  await api.clippings(session, 'one')
  await new Promise((r) => setTimeout(r, 5))
  http.mockResolvedValueOnce(response({ items: Array.from({ length: 5000 }, (_, i) => ({ document: 'two', id: String(i), text: 'Newer', created_at: 300 })) }))
  await api.allClippings(session, [])
  await flush()
  expect(snapshot().clippings.items.some((c) => c.id === 'old')).toBe(true)
})
it('clears a leftover native snapshot when launched without a session', async () => {
  http.mockResolvedValueOnce(response({ items: [book] }))
  await api.books(session)
  apiModule.syncShortcutsCache(null)
  await flush()
  expect(snapshot()).toBeNull()
})
it('does not start legacy fallback requests for a signed-out account after a delayed 404', async () => {
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = api.allClippings(session, [book])
  logout()
  resolve({ ok: false, status: 404, json: async () => ({}) })
  http.mockResolvedValue(response({ items: [{ id: 'old', text: 'Old account' }], more: false }))
  await pending.catch(() => {})
  await flush()
  expect(snapshot()).toBeNull()
  expect(http).toHaveBeenCalledTimes(1)
})
