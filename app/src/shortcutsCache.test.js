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
it('publishes the legacy clipping batch once, only after every book has completed', async () => {
  let finishSecond
  http.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    .mockResolvedValueOnce(response({ items: [{ id: 'a', text: 'First', created_at: 1 }], more: false }))
    .mockReturnValueOnce(new Promise((r) => { finishSecond = r }))
  const pending = api.allClippings(session, [book, { ...book, document: 'two' }])
  await flush()
  expect(invoke.mock.calls.filter(([name]) => name === 'update_shortcuts')).toHaveLength(0)
  finishSecond(response({ items: [{ id: 'b', text: 'Second', created_at: 2 }], more: false }))
  expect((await pending).map((c) => c.id)).toEqual(['b', 'a'])
  await flush()
  expect(invoke.mock.calls.filter(([name]) => name === 'update_shortcuts')).toHaveLength(1)
  expect(snapshot().clippings.items.map((c) => c.id).sort()).toEqual(['a', 'b'])
})
it('does not publish a legacy clipping batch that finishes after logout', async () => {
  let finishSecond
  http.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    .mockResolvedValueOnce(response({ items: [{ id: 'a', text: 'First' }], more: false }))
    .mockReturnValueOnce(new Promise((r) => { finishSecond = r }))
  const pending = api.allClippings(session, [book, { ...book, document: 'two' }])
  await flush()
  logout()
  finishSecond(response({ items: [{ id: 'b', text: 'Second' }], more: false }))
  await pending
  await flush()
  const publications = invoke.mock.calls.filter(([name]) => name === 'update_shortcuts')
  expect(publications.map(([, args]) => args.json)).toEqual([null])
})
it('does not publish partial legacy clipping data if a book fetch fails', async () => {
  http.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    .mockResolvedValueOnce(response({ items: [{ id: 'a', text: 'First' }], more: false }))
    .mockRejectedValueOnce(new Error('connection lost'))
  await expect(api.allClippings(session, [book, { ...book, document: 'two' }])).rejects.toThrow('connection lost')
  await flush()
  expect(invoke.mock.calls.filter(([name]) => name === 'update_shortcuts')).toHaveLength(0)
})
it('clears reading caches before resolving clearData, waits for native clearing and keeps sign-in', async () => {
  apiModule.saveSession(session)
  localStorage.setItem('crosspoint-theme', 'dark')
  localStorage.setItem('crosspoint-offline:v2:other@https://sync.test/api/v1/clippings', JSON.stringify({ items: [] }))
  http.mockResolvedValueOnce(response({ items: [book] }))
  await api.books(session)
  http.mockResolvedValueOnce(response({ items: [{ document: 'one', id: 'old', text: 'Old' }] }))
  await api.allClippings(session, [])
  await flush()
  let finishNative
  invoke.mockImplementationOnce(() => new Promise((r) => { finishNative = r }))
  http.mockResolvedValueOnce(response({ ok: true }))
  let finished = false
  const pending = api.clearData(session).then(() => { finished = true })
  try {
    await flush()
    expect(apiModule.cached.books(session)).toBeNull()
    expect(apiModule.cached.clippings(session)).toBeNull()
    expect(snapshot()).toBeNull()
    expect(finished).toBe(false)
    expect(apiModule.loadSession()).toEqual(session)
    expect(localStorage.getItem('crosspoint-theme')).toBe('dark')
    expect(localStorage.getItem('crosspoint-offline:v2:other@https://sync.test/api/v1/clippings')).not.toBeNull()
    finishNative()
    await pending
  } finally {
    finishNative?.()
    invoke.mockReset().mockResolvedValue()
  }
})
it('does not restore reading data from a fetch that completes after clearData', async () => {
  let finishFetch
  http.mockReturnValueOnce(new Promise((r) => { finishFetch = r }))
  const pending = api.books(session)
  http.mockResolvedValueOnce(response({ ok: true }))
  await api.clearData(session)
  finishFetch(response({ items: [book] }))
  await pending
  await flush()
  expect(apiModule.cached.books(session)).toBeNull()
  expect(snapshot()).toBeNull()
})
it('retains cached data if clearing reading data fails', async () => {
  http.mockResolvedValueOnce(response({ items: [book] }))
  await api.books(session)
  await flush()
  const before = snapshot()
  http.mockRejectedValueOnce(new Error('offline'))
  await expect(api.clearData(session)).rejects.toThrow('offline')
  await flush()
  expect(apiModule.cached.books(session)).toHaveLength(1)
  expect(snapshot()).toEqual(before)
})
it('does not clear a newly selected account after a delayed old-account clearData response', async () => {
  let finishClear
  http.mockReturnValueOnce(new Promise((r) => { finishClear = r }))
  const pending = api.clearData(session)
  logout()
  const other = { ...session, username: 'other' }
  http.mockResolvedValueOnce(response({ items: [book] }))
  await api.books(other)
  finishClear(response({ ok: true }))
  await pending
  await flush()
  expect(snapshot().account).toBe('["https://sync.test","other"]')
  expect(apiModule.cached.books(other)).toHaveLength(1)
})
it('removes known deleted clips from hub, per-book and page caches without losing older book history', async () => {
  const prefix = 'crosspoint-offline:v2:reader@https://sync.test'
  const clips = [{ id: 'remove', text: 'Deleted', created_at: 2 }, { id: 'keep', text: 'Older passage', created_at: 1 }]
  const hub = [{ ...clips[0], document: 'one' }, ...Array.from({ length: 4999 }, (_, i) => ({
    document: 'two', id: i === 0 ? 'remove' : `other-${i}`, text: 'Other book', created_at: 3,
  }))]
  localStorage.setItem(`${prefix}/api/v1/progress?limit=500`, JSON.stringify({ items: [book] }))
  localStorage.setItem(`${prefix}/api/v1/clippings`, JSON.stringify({ items: hub }))
  localStorage.setItem(`${prefix}/api/v1/clippings:saved-at`, '200')
  localStorage.setItem(`${prefix}/api/v1/clippings/one`, JSON.stringify({ items: clips }))
  localStorage.setItem(`${prefix}/api/v1/clippings/one:saved-at`, '100')
  localStorage.setItem(`${prefix}/api/v1/clippings/one?cursor=0&limit=100`, JSON.stringify({ items: clips, more: false }))
  apiModule.syncShortcutsCache(session)
  await flush()
  http.mockResolvedValueOnce(response({ ok: true }))
  await api.deleteClipping(session, 'one', 'remove')
  await flush()
  expect(snapshot().clippings.items.some((c) => c.document === 'one' && c.id === 'remove')).toBe(false)
  expect(snapshot().clippings.items.some((c) => c.document === 'one' && c.id === 'keep')).toBe(true)
  expect(snapshot().clippings.items.some((c) => c.document === 'two' && c.id === 'remove')).toBe(true)
  expect(localStorage.getItem(`${prefix}/api/v1/clippings/one:saved-at`)).toBe('100')
  // A subsequent capped hub refresh must not resurrect the deleted per-book item.
  http.mockResolvedValueOnce(response({ items: [...hub.slice(1), { document: 'two', id: 'extra', text: 'Newest', created_at: 4 }] }))
  await api.allClippings(session, [])
  await flush()
  expect(snapshot().clippings.items.filter((c) => c.document === 'one').map((c) => c.id)).toEqual(['keep'])
  // Cached pages must also be pruned, or an offline book open could restore it.
  http.mockRejectedValue(new Error('offline'))
  expect((await api.clippings(session, 'one')).map((c) => c.id)).toEqual(['keep'])
})
it('retains clipping caches when a server deletion fails', async () => {
  http.mockResolvedValueOnce(response({ items: [{ id: 'keep', text: 'Saved' }], more: false }))
  await api.clippings(session, 'one')
  await flush()
  const before = snapshot()
  http.mockRejectedValueOnce(new Error('offline'))
  await expect(api.deleteClipping(session, 'one', 'keep')).rejects.toThrow('offline')
  await flush()
  expect(snapshot()).toEqual(before)
})
it('does not republish the old account when its clipping deletion completes after switching accounts', async () => {
  let finishDelete
  http.mockReturnValueOnce(new Promise((r) => { finishDelete = r }))
  const pending = api.deleteClipping(session, 'one', 'old')
  logout()
  const other = { ...session, username: 'other' }
  http.mockResolvedValueOnce(response({ items: [book] }))
  await api.books(other)
  finishDelete(response({ ok: true }))
  await pending
  await flush()
  expect(snapshot().account).toBe('["https://sync.test","other"]')
})
it('keeps a successful clipping deletion successful when native publication fails', async () => {
  http.mockResolvedValueOnce(response({ items: [{ id: 'remove', text: 'Saved' }], more: false }))
  await api.clippings(session, 'one')
  await flush()
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    invoke.mockRejectedValueOnce(new Error('native write failed'))
    http.mockResolvedValueOnce(response({ ok: true }))
    await expect(api.deleteClipping(session, 'one', 'remove')).resolves.toEqual({ ok: true })
    // The successful deletion still prunes offline data; later publications retry.
    http.mockRejectedValueOnce(new Error('offline'))
    expect(await api.clippings(session, 'one')).toEqual([])
    await flush()
    expect(snapshot().clippings.items).toEqual([])
  } finally {
    warning.mockRestore()
  }
})
