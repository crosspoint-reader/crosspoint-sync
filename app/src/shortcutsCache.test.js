// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue() }))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
window.__TAURI_INTERNALS__ = {}
vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone OS 26_0')
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
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone OS 26_0')
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 })
  window.__TAURI_INTERNALS__ = {}
  await logout()
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
  await logout()
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
  await logout()
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
  await logout()
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
  await logout()
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
  await logout()
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
  await logout()
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
it('keeps failed legacy batches out of later snapshots and offline book loads', async () => {
  http.mockResolvedValueOnce(response({ items: [{ id: 'saved', text: 'Previously loaded' }], more: false }))
  await api.clippings(session, 'one')
  await flush()
  http.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    .mockResolvedValueOnce(response({ items: [{ id: 'partial', text: 'Partial batch' }], more: false }))
    .mockRejectedValueOnce(new Error('connection lost'))
  await expect(api.allClippings(session, [book, { ...book, document: 'two' }])).rejects.toThrow('connection lost')
  apiModule.syncShortcutsCache(session)
  await flush()
  expect(snapshot().clippings.items.map((c) => c.id)).toEqual(['saved'])
  http.mockRejectedValueOnce(new Error('offline'))
  expect((await api.clippings(session, 'one')).map((c) => c.id)).toEqual(['saved'])
})
it('does not persist a late successful book after another legacy batch request has failed', async () => {
  let finishLate
  http.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockReturnValueOnce(new Promise((r) => { finishLate = r }))
  await expect(api.allClippings(session, [book, { ...book, document: 'two' }])).rejects.toThrow('connection lost')
  finishLate(response({ items: [{ id: 'late', text: 'Late partial batch' }], more: false }))
  await flush()
  apiModule.syncShortcutsCache(session)
  await flush()
  expect(snapshot().clippings).toBeNull()
})
it('records an empty legacy clipping collection and restores it offline', async () => {
  http.mockResolvedValueOnce(response({ items: [] }))
  await api.books(session)
  http.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
  expect(await api.allClippings(session, [])).toEqual([])
  await flush()
  expect(snapshot().clippings).toEqual({ items: [] })
  expect(apiModule.cached.clippings(session)).toEqual([])
  apiModule.syncShortcutsCache(session)
  http.mockRejectedValueOnce(new Error('offline'))
  expect(await api.allClippings(session, [])).toEqual([])
  await flush()
  expect(snapshot().clippings).toEqual({ items: [] })
})
it.each([
  ['Android', 'Mozilla/5.0 (Linux; Android 16)', 5],
  ['macOS', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', 0],
  ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 5],
  ['Linux', 'Mozilla/5.0 (X11; Linux x86_64)', 0],
])('skips cache reads and native IPC for Shortcuts on %s', (_, agent, touches) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(agent)
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: touches })
  const readCache = vi.spyOn(Object.getPrototypeOf(localStorage), 'getItem')
  try {
    apiModule.syncShortcutsCache(session)
    expect(readCache).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    readCache.mockRestore()
  }
})
it.each([
  ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0)', 5],
  ['iPad', 'Mozilla/5.0 (iPad; CPU OS 26_0)', 5],
  ['iPad desktop user agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X)', 5],
])('publishes cached data on %s', async (_, agent, touches) => {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(agent)
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: touches })
  localStorage.setItem('crosspoint-offline:v2:reader@https://sync.test/api/v1/progress?limit=500', JSON.stringify({ items: [book] }))
  apiModule.syncShortcutsCache(session)
  await flush()
  expect(snapshot().books.items[0].title).toBe('One')
})
it('skips Shortcuts cache work in an iPhone browser without the native bridge', () => {
  delete window.__TAURI_INTERNALS__
  const readCache = vi.spyOn(Object.getPrototypeOf(localStorage), 'getItem')
  try {
    apiModule.syncShortcutsCache(session)
    expect(readCache).not.toHaveBeenCalled()
    expect(invoke).not.toHaveBeenCalled()
  } finally {
    readCache.mockRestore()
  }
})

function limitStorage(limit) {
  const prototype = Object.getPrototypeOf(localStorage)
  const original = prototype.setItem
  return vi.spyOn(prototype, 'setItem').mockImplementation(function (key, value) {
    const size = Object.keys(this).filter((k) => k !== key)
      .reduce((total, k) => total + k.length + this.getItem(k).length, 0) + key.length + String(value).length
    if (size > limit) throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
    return original.call(this, key, value)
  })
}
it('stores a single complete clipping copy when quota only permits one representation', async () => {
  const clip = { id: 'large', text: 'x'.repeat(2400), created_at: 1 }
  const quota = limitStorage(3500)
  try {
    http.mockResolvedValueOnce(response({ items: [clip], more: false }))
    await api.clippings(session, 'one')
    await flush()
    expect(snapshot().clippings.items[0].text).toBe(clip.text)
    expect(Object.keys(localStorage).filter((k) => k.includes('/clippings/one?'))).toEqual([])
    http.mockRejectedValueOnce(new Error('offline'))
    expect(await api.clippings(session, 'one')).toEqual([clip])
  } finally {
    quota.mockRestore()
  }
})
it('migrates complete legacy pages within single-copy storage quota', async () => {
  const pageKey = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/clippings/one?cursor=0&limit=100'
  const clip = { id: 'legacy-large', text: 'x'.repeat(2400), created_at: 1 }
  localStorage.setItem(pageKey, JSON.stringify({ items: [clip], more: false }))
  const quota = limitStorage(3500)
  try {
    http.mockRejectedValue(new Error('offline'))
    expect(await api.clippings(session, 'one')).toEqual([clip])
    await flush()
    expect(snapshot().clippings.items[0]).toMatchObject({ id: 'legacy-large', cachedAt: null })
    expect(localStorage.getItem(pageKey)).toBeNull()
    expect(await api.clippings(session, 'one')).toEqual([clip])
  } finally {
    quota.mockRestore()
  }
})
it('restores legacy pages if a new complete clipping payload cannot fit', async () => {
  const pageKey = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/clippings/one?cursor=0&limit=100'
  const saved = { items: [{ id: 'saved', text: 'Existing' }], more: false }
  localStorage.setItem(pageKey, JSON.stringify(saved))
  const quota = limitStorage(1000)
  try {
    http.mockResolvedValueOnce(response({ items: [{ id: 'large', text: 'x'.repeat(2400) }], more: false }))
    await api.clippings(session, 'one')
    expect(JSON.parse(localStorage.getItem(pageKey))).toEqual(saved)
    http.mockRejectedValueOnce(new Error('offline'))
    expect(await api.clippings(session, 'one')).toEqual(saved.items)
  } finally {
    quota.mockRestore()
  }
})

it.each(['hub', 'book', 'legacy'])('rejects a %s clipping read started before a successful deletion', async (source) => {
  const clip = { document: 'one', id: 'remove', text: 'Removed' }
  http.mockResolvedValueOnce(response({ items: [clip] }))
  await api.allClippings(session, [])
  let resolve
  if (source === 'legacy') http.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = source === 'book' ? api.clippings(session, 'one') : api.allClippings(session, [book])
  const rejected = expect(pending).rejects.toThrow('Reading data changed')
  await flush()
  http.mockResolvedValueOnce(response({ ok: true }))
  await api.deleteClipping(session, 'one', 'remove')
  resolve(response({ items: [clip], more: false }))
  await rejected
  await flush()
  expect(snapshot().clippings.items).toEqual([])
  http.mockRejectedValue(new Error('offline'))
  expect(await api.allClippings(session, [])).toEqual([])
})

it('applies both concurrent clipping deletions', async () => {
  http.mockResolvedValueOnce(response({ items: ['a', 'b'].map((id) => ({ document: 'one', id })) }))
  await api.allClippings(session, [])
  let resolveA, resolveB
  http.mockReturnValueOnce(new Promise((r) => { resolveA = r }))
    .mockReturnValueOnce(new Promise((r) => { resolveB = r }))
  const a = api.deleteClipping(session, 'one', 'a')
  const b = api.deleteClipping(session, 'one', 'b')
  resolveA(response({ ok: true }))
  await a
  resolveB(response({ ok: true }))
  await b
  expect(snapshot().clippings.items).toEqual([])
})

it('does not fall back to a complete clipping copy captured before deletion', async () => {
  const clip = { id: 'remove', text: 'Removed' }
  http.mockResolvedValueOnce(response({ items: [clip], more: false }))
  await api.clippings(session, 'one')
  let reject
  http.mockReturnValueOnce(new Promise((_, r) => { reject = r }))
  const pending = api.clippings(session, 'one')
  const rejected = expect(pending).rejects.toThrow('Reading data changed')
  http.mockResolvedValueOnce(response({ ok: true }))
  await api.deleteClipping(session, 'one', 'remove')
  reject(new Error('offline'))
  await rejected
  expect(snapshot().clippings.items).toEqual([])
})

it('prunes a removed book and its clippings before any library reload', async () => {
  const prefix = 'crosspoint-offline:v2:reader@https://sync.test'
  http.mockResolvedValueOnce(response({ items: [book, { ...book, document: 'two', title: 'Two' }] }))
  await api.books(session)
  http.mockResolvedValueOnce(response({ items: [{ document: 'one', id: 'remove' }, { document: 'two', id: 'keep' }] }))
  await api.allClippings(session, [])
  http.mockResolvedValueOnce(response({ items: [{ id: 'remove' }], more: false }))
  await api.clippings(session, 'one')
  localStorage.setItem(`${prefix}/api/v1/clippings/one?cursor=0&limit=100`, JSON.stringify({ items: [{ id: 'remove' }] }))
  http.mockResolvedValueOnce(response({ ok: true }))
  await api.removeBook(session, 'one')
  expect(snapshot().books.items.map((b) => b.document)).toEqual(['two'])
  expect(snapshot().clippings.items.map((c) => c.id)).toEqual(['keep'])
  expect(Object.keys(localStorage).some((key) => key.startsWith(`${prefix}/api/v1/clippings/one`))).toBe(false)
  http.mockRejectedValue(new Error('offline'))
  expect((await api.books(session)).map((b) => b.document)).toEqual(['two'])
  expect((await api.allClippings(session, [])).map((c) => c.id)).toEqual(['keep'])
})

it.each(['books', 'clippings'])('rejects a delayed %s read after removing its book', async (source) => {
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = source === 'books' ? api.books(session) : api.clippings(session, 'one')
  const rejected = expect(pending).rejects.toThrow('Reading data changed')
  http.mockResolvedValueOnce(response({ ok: true }))
  await api.removeBook(session, 'one')
  resolve(response({ items: source === 'books' ? [book] : [{ id: 'removed' }], more: false }))
  await rejected
  expect(snapshot().books).toBeNull()
  expect(snapshot().clippings).toBeNull()
})

it('keeps cached books when removal fails', async () => {
  http.mockResolvedValueOnce(response({ items: [book] }))
  await api.books(session)
  await flush()
  const before = snapshot()
  http.mockRejectedValue(new Error('offline'))
  await expect(api.removeBook(session, 'one')).rejects.toThrow('offline')
  expect(snapshot()).toEqual(before)
  expect(apiModule.cached.books(session)).toHaveLength(1)
})

it('does not prune a new session when an old book removal completes', async () => {
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = api.removeBook(session, 'one')
  await logout()
  http.mockResolvedValueOnce(response({ items: [book] }))
  await api.books(session)
  resolve(response({ ok: true }))
  await pending
  await flush()
  expect(snapshot().books.items).toHaveLength(1)
})

it('announces offline state when falling back to complete book clippings', async () => {
  const clip = { id: 'saved', text: 'Cached passage' }
  http.mockResolvedValueOnce(response({ items: [clip], more: false }))
  await api.clippings(session, 'one')
  const onOffline = vi.fn()
  apiModule.offline.addEventListener('offline', onOffline)
  try {
    http.mockRejectedValueOnce(new Error('offline'))
    expect(await api.clippings(session, 'one')).toEqual([clip])
    expect(onOffline).toHaveBeenCalledOnce()
  } finally {
    apiModule.offline.removeEventListener('offline', onOffline)
  }
})

it('saves hub freshness with its payload when quota only permits one record', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/clippings'
  localStorage.setItem(`${key}/one`, JSON.stringify({ items: [{ id: 'old' }], savedAt: 100 }))
  const fresh = [{ document: 'one', id: 'fresh' }]
  const used = Object.keys(localStorage).reduce((total, k) => total + k.length + localStorage.getItem(k).length, 0)
  const storage = limitStorage(used + key.length + JSON.stringify({ items: fresh, savedAt: 200 }).length)
  const now = vi.spyOn(Date, 'now').mockReturnValue(200)
  try {
    http.mockResolvedValueOnce(response({ items: fresh }))
    await api.allClippings(session, [])
    await flush()
    expect(snapshot().clippings.items).toMatchObject([{ id: 'fresh', cachedAt: 200 }])
    expect(JSON.parse(localStorage.getItem(key))).toEqual({ items: fresh, savedAt: 200 })
    now.mockReturnValue(300)
    http.mockRejectedValueOnce(new Error('offline'))
    await api.allClippings(session, [])
    await flush()
    expect(snapshot().clippings.items).toMatchObject([{ id: 'fresh', cachedAt: 200 }])
  } finally {
    storage.mockRestore()
    now.mockRestore()
  }
})

it.each(['legacy', 'embedded'])('preserves %s hub freshness on offline reads', async (format) => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/clippings'
  const items = [{ document: 'one', id: 'old-hub' }]
  localStorage.setItem(key, JSON.stringify(format === 'embedded' ? { items, savedAt: 100 } : { items }))
  if (format === 'legacy') localStorage.setItem(`${key}:saved-at`, '100')
  localStorage.setItem(`${key}/one`, JSON.stringify({ items: [{ id: 'newer-book' }], savedAt: 150 }))
  http.mockRejectedValueOnce(new Error('offline'))
  await api.allClippings(session, [])
  await flush()
  expect(snapshot().clippings.items).toMatchObject([{ id: 'newer-book', cachedAt: 150 }])
  expect(JSON.parse(localStorage.getItem(key))).toEqual({ items, savedAt: 100 })
})

it('retains both old hub data and freshness when a replacement exceeds quota', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/clippings'
  const previous = { items: [{ document: 'one', id: 'saved' }], savedAt: 100 }
  localStorage.setItem(key, JSON.stringify(previous))
  const storage = limitStorage(key.length + JSON.stringify(previous).length)
  try {
    http.mockResolvedValueOnce(response({ items: [{ document: 'one', id: 'new', text: 'x'.repeat(2000) }] }))
    await api.allClippings(session, [])
    await flush()
    expect(JSON.parse(localStorage.getItem(key))).toEqual(previous)
    expect(snapshot().clippings.items).toMatchObject([{ id: 'saved', cachedAt: 100 }])
  } finally {
    storage.mockRestore()
  }
})

it('saves book freshness with its payload when quota only permits one record', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/progress?limit=500'
  // An upgraded cache can already contain the payload without freshness metadata.
  localStorage.setItem(key, JSON.stringify({ items: [book], next: null }))
  const fresh = { ...book, title: 'Updated title' }
  const record = { items: [fresh], next: null, savedAt: 200 }
  const storage = limitStorage(key.length + JSON.stringify(record).length)
  const now = vi.spyOn(Date, 'now').mockReturnValue(200)
  try {
    http.mockResolvedValueOnce(response({ items: [fresh] }))
    await api.books(session)
    await flush()
    expect(snapshot().books).toMatchObject({ savedAt: 200, items: [{ title: 'Updated title' }] })
    expect(JSON.parse(localStorage.getItem(key))).toEqual(record)
    now.mockReturnValue(300)
    http.mockRejectedValueOnce(new Error('offline'))
    await api.books(session)
    await flush()
    expect(snapshot().books.savedAt).toBe(200)
  } finally {
    storage.mockRestore()
    now.mockRestore()
  }
})

it.each(['legacy', 'embedded'])('preserves %s book freshness on offline reads', async (format) => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/progress?limit=500'
  const previous = { items: [book], next: null }
  localStorage.setItem(key, JSON.stringify(format === 'embedded' ? { ...previous, savedAt: 100 } : previous))
  if (format === 'legacy') localStorage.setItem(`${key}:saved-at`, '100')
  http.mockRejectedValueOnce(new Error('offline'))
  await api.books(session)
  await flush()
  expect(snapshot().books.savedAt).toBe(100)
  expect(JSON.parse(localStorage.getItem(key))).toEqual({ ...previous, savedAt: 100 })
})

it('retains both old book data and freshness when a replacement exceeds quota', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/progress?limit=500'
  const previous = { items: [book], next: null, savedAt: 100 }
  localStorage.setItem(key, JSON.stringify(previous))
  const storage = limitStorage(key.length + JSON.stringify(previous).length)
  try {
    http.mockResolvedValueOnce(response({ items: [{ ...book, title: 'x'.repeat(2000) }] }))
    await api.books(session)
    await flush()
    expect(JSON.parse(localStorage.getItem(key))).toEqual(previous)
    expect(snapshot().books).toMatchObject({ savedAt: 100, items: [{ title: book.title }] })
  } finally {
    storage.mockRestore()
  }
})

it('invalidates merged clipping caches before reloads and preserves unrelated per-book copies', async () => {
  const prefix = 'crosspoint-offline:v2:reader@https://sync.test'
  http.mockResolvedValueOnce(response({ items: [book, { ...book, document: 'two' }] }))
  await api.books(session)
  http.mockResolvedValueOnce(response({ items: [{ document: 'one', id: 'source' }, { document: 'two', id: 'target' }] }))
  await api.allClippings(session, [])
  for (const doc of ['one', 'two', 'other']) {
    http.mockResolvedValueOnce(response({ items: [{ id: doc }], more: false }))
    await api.clippings(session, doc)
  }
  localStorage.setItem(`${prefix}/api/v1/clippings/one?cursor=0&limit=100`, JSON.stringify({ items: [{ id: 'legacy' }] }))
  http.mockResolvedValueOnce(response({ ok: true }))
  await api.merge(session, 'one', 'two')
  expect(JSON.parse(localStorage.getItem(`${prefix}/api/v1/clippings`))).toMatchObject({ items: [], truncated: true })
  expect(Object.keys(localStorage).some((key) => /^.*\/clippings\/(one|two)([?:]|$)/.test(key))).toBe(false)
  expect(localStorage.getItem(`${prefix}/api/v1/clippings/other`)).not.toBeNull()
  expect(snapshot().clippings.items.map((c) => c.document)).toEqual(['other'])
  // Successful library reload cannot expose passages under an obsolete identity.
  http.mockResolvedValueOnce(response({ items: [{ ...book, document: 'two' }] }))
  await api.books(session)
  http.mockRejectedValueOnce(new Error('offline'))
  await expect(api.clippings(session, 'two')).rejects.toThrow('offline')
  await flush()
  expect(snapshot().clippings.items.map((c) => c.document)).toEqual(['other'])
})

it('rejects clipping reads started before a merge', async () => {
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = api.allClippings(session, [])
  const rejected = expect(pending).rejects.toThrow('Reading data changed')
  http.mockResolvedValueOnce(response({ ok: true }))
  await api.merge(session, 'one', 'two')
  resolve(response({ items: [{ document: 'one', id: 'old' }] }))
  await rejected
  expect(snapshot().clippings).toBeNull()
})

it('keeps clipping caches when a merge fails', async () => {
  http.mockResolvedValueOnce(response({ items: [{ document: 'one', id: 'keep' }] }))
  await api.allClippings(session, [])
  await flush()
  const previous = snapshot()
  http.mockRejectedValueOnce(new Error('offline'))
  await expect(api.merge(session, 'one', 'two')).rejects.toThrow('offline')
  expect(snapshot()).toEqual(previous)
})

it('ignores an old session merge completion', async () => {
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = api.merge(session, 'one', 'two')
  await logout()
  http.mockResolvedValueOnce(response({ items: [{ document: 'one', id: 'new-session' }] }))
  await api.allClippings(session, [])
  resolve(response({ ok: true }))
  await pending
  await flush()
  expect(snapshot().clippings.items.map((c) => c.id)).toEqual(['new-session'])
})

it('retains complete hub deletion evidence when a later hub reaches its cap', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/clippings'
  const old = [{ id: 'deleted', text: 'Gone' }, { id: 'kept', text: 'Old text' }]
  localStorage.setItem(`${key}/one`, JSON.stringify({ items: old, savedAt: 100 }))
  localStorage.setItem(`${key}/one?cursor=0&limit=100`, JSON.stringify({ items: old, more: false }))
  localStorage.setItem(`${key}/empty?cursor=0&limit=100`, JSON.stringify({ items: [{ id: 'also-deleted' }], more: false }))
  const now = vi.spyOn(Date, 'now').mockReturnValue(200)
  try {
    http.mockResolvedValueOnce(response({ items: [{ document: 'one', id: 'kept', text: 'Edited text' }] }))
    await api.allClippings(session, [])
    now.mockReturnValue(300)
    http.mockResolvedValueOnce(response({ items: Array.from({ length: 5000 }, (_, i) => ({ document: 'other', id: `c${i}` })) }))
    await api.allClippings(session, [])
    await flush()
    expect(snapshot().clippings.items.filter((c) => c.document === 'one')).toMatchObject([{ id: 'kept', text: 'Edited text', cachedAt: 200 }])
    expect(snapshot().clippings.items.some((c) => c.id === 'deleted' || c.id === 'also-deleted')).toBe(false)
    http.mockRejectedValue(new Error('offline'))
    expect(await api.clippings(session, 'one')).toEqual([{ id: 'kept', text: 'Edited text' }])
    expect(await api.clippings(session, 'empty')).toEqual([])
  } finally {
    now.mockRestore()
  }
})

it('preserves per-book data newer than a complete cached hub', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/clippings'
  localStorage.setItem(key, JSON.stringify({ items: [], savedAt: 100 }))
  const recent = { items: [{ id: 'newer' }], savedAt: 200 }
  localStorage.setItem(`${key}/one`, JSON.stringify(recent))
  http.mockRejectedValueOnce(new Error('offline'))
  await api.allClippings(session, [])
  await flush()
  expect(JSON.parse(localStorage.getItem(`${key}/one`))).toEqual(recent)
  expect(snapshot().clippings.items).toMatchObject([{ id: 'newer', cachedAt: 200 }])
})

it('preserves hub freshness when reconciling older book copies offline', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/clippings'
  localStorage.setItem(key, JSON.stringify({ items: [], savedAt: 200 }))
  localStorage.setItem(`${key}/one`, JSON.stringify({ items: [{ id: 'deleted' }], savedAt: 100 }))
  http.mockRejectedValueOnce(new Error('offline'))
  await api.allClippings(session, [])
  expect(JSON.parse(localStorage.getItem(`${key}/one`))).toEqual({ items: [], savedAt: 200 })
})

it('keeps book clipping order and extra location fields when reconciling a hub', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/clippings'
  localStorage.setItem(`${key}/one`, JSON.stringify({ items: [{ id: 'first', spine: 1, start_page: 12, color: 'yellow' }], savedAt: 100 }))
  http.mockResolvedValueOnce(response({ items: [
    { document: 'one', id: 'last', spine: 2, text: 'Later passage' },
    { document: 'one', id: 'first', spine: 1, text: 'Edited passage' },
  ] }))
  await api.allClippings(session, [])
  http.mockRejectedValueOnce(new Error('offline'))
  expect(await api.clippings(session, 'one')).toEqual([
    { id: 'first', spine: 1, start_page: 12, color: 'yellow', text: 'Edited passage' },
    { id: 'last', spine: 2, text: 'Later passage' },
  ])
})

it('discards disproven copies if replacing them from the hub fails', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/clippings'
  localStorage.setItem(`${key}/one`, JSON.stringify({ items: [{ id: 'deleted' }], savedAt: 100 }))
  const proto = Object.getPrototypeOf(localStorage)
  const setItem = proto.setItem
  const storage = vi.spyOn(proto, 'setItem').mockImplementation(function (k, value) {
    if (k === `${key}/one`) throw new DOMException('Quota exceeded', 'QuotaExceededError')
    return setItem.call(this, k, value)
  })
  try {
    http.mockResolvedValueOnce(response({ items: [] }))
    await api.allClippings(session, [])
    await flush()
    expect(localStorage.getItem(`${key}/one`)).toBeNull()
    expect(snapshot().clippings.items).toEqual([])
  } finally {
    storage.mockRestore()
  }
})

it('preserves a book copy with an equal timestamp when replaying an offline hub', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/clippings'
  localStorage.setItem(key, JSON.stringify({ items: [], savedAt: 200 }))
  const per = { items: [{ id: 'possibly-newer' }], savedAt: 200 }
  localStorage.setItem(`${key}/one`, JSON.stringify(per))
  http.mockRejectedValueOnce(new Error('offline'))
  await api.allClippings(session, [])
  expect(JSON.parse(localStorage.getItem(`${key}/one`))).toEqual(per)
})

it.each([false, true])('preserves unrelated hub-only clippings during a merge (capped: %s)', async (capped) => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/clippings'
  const unrelated = Array.from({ length: capped ? 4998 : 1 }, (_, i) => ({ document: 'other', id: `other-${i}`, text: 'Unrelated' }))
  localStorage.setItem(key, JSON.stringify({ items: [
    { document: 'one', id: 'source' }, { document: 'two', id: 'target' }, ...unrelated,
  ], savedAt: 100 }))
  if (capped) localStorage.setItem(`${key}/other`, JSON.stringify({ items: [{ id: 'history' }], savedAt: 90 }))
  http.mockResolvedValueOnce(response({ ok: true }))
  await api.merge(session, 'one', 'two')
  const saved = JSON.parse(localStorage.getItem(key))
  expect(saved).toEqual({ items: unrelated, savedAt: 100, truncated: true })
  expect(snapshot().clippings.items.filter((c) => c.id !== 'history')).toHaveLength(unrelated.length)
  if (capped) expect(snapshot().clippings.items.some((c) => c.id === 'history')).toBe(true)
  // The normal target refresh must retain unrelated books in the native copy.
  http.mockResolvedValueOnce(response({ items: [{ id: 'merged' }], more: false }))
  await api.clippings(session, 'two')
  await flush()
  expect(snapshot().clippings.items.filter((c) => c.document === 'other')).toHaveLength(unrelated.length + Number(capped))
  http.mockRejectedValueOnce(new Error('offline'))
  expect(await api.allClippings(session, [])).toEqual(unrelated)
  await flush()
  expect(snapshot().clippings.items.some((c) => c.document === 'two' && c.id === 'merged')).toBe(true)
})

it('invalidates both merged books when the library reload is offline', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/progress?limit=500'
  const books = [book, { ...book, document: 'two', title: 'Target' }, { ...book, document: 'other', title: 'Unrelated' }]
  localStorage.setItem(key, JSON.stringify({ items: books, next: null, savedAt: 100 }))
  http.mockResolvedValueOnce(response({ ok: true }))
  await api.merge(session, 'one', 'two')
  expect(apiModule.cached.books(session).map((b) => b.document)).toEqual(['other'])
  expect(snapshot().books.items.map((b) => b.document)).toEqual(['other'])
  expect(snapshot().books.savedAt).toBe(100)
  http.mockRejectedValueOnce(new Error('offline'))
  expect((await api.books(session)).map((b) => b.document)).toEqual(['other'])
  await flush()
  expect(snapshot().books.items.map((b) => b.document)).toEqual(['other'])
  expect(snapshot().books.savedAt).toBe(100)
})

it('rejects library reads begun before a merge', async () => {
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = api.books(session)
  const rejected = expect(pending).rejects.toThrow('Reading data changed')
  http.mockResolvedValueOnce(response({ ok: true }))
  await api.merge(session, 'one', 'two')
  resolve(response({ items: [book, { ...book, document: 'two' }] }))
  await rejected
  expect(apiModule.cached.books(session)).toBeNull()
})

it('retains cached books when the merge request fails', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/progress?limit=500'
  const previous = { items: [book, { ...book, document: 'two' }], next: null, savedAt: 100 }
  localStorage.setItem(key, JSON.stringify(previous))
  http.mockRejectedValueOnce(new Error('offline'))
  await expect(api.merge(session, 'one', 'two')).rejects.toThrow('offline')
  expect(JSON.parse(localStorage.getItem(key))).toEqual(previous)
})

const bookEdits = [
  ['status', () => api.setStatus(session, 'one', 'finished'), { ...book, status: 'finished' }],
  ['metadata', () => api.setInfo(session, 'one', { title: 'Edited title', author: 'Edited author' }), { ...book, title: 'Edited title', author: 'Edited author' }],
  ['dates', () => api.setDates(session, 'one', { finished_date: '2026-10-28' }), { ...book, status: 'finished' }],
]

it.each(bookEdits)('rejects pre-%s library reads that finish after the edited library loads', async (_, edit, updated) => {
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = api.books(session)
  const rejected = expect(pending).rejects.toThrow('Reading data changed')
  http.mockResolvedValueOnce(response({ ok: true }))
  await edit()
  http.mockResolvedValueOnce(response({ items: [updated] }))
  await api.books(session)
  await flush()
  const fresh = snapshot()
  resolve(response({ items: [{ ...book, status: 'reading', title: 'Old title', author: 'Old author' }] }))
  await rejected
  await flush()
  expect(snapshot()).toEqual(fresh)
  expect(apiModule.cached.books(session)[0]).toMatchObject({ ...updated, percentage: updated.status === 'finished' ? 1 : updated.percentage })
})

it.each(bookEdits)('does not invalidate library reads when a %s edit fails', async (_, edit) => {
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = api.books(session)
  http.mockRejectedValueOnce(new Error('offline'))
  await expect(edit()).rejects.toThrow('offline')
  resolve(response({ items: [book] }))
  await expect(pending).resolves.toHaveLength(1)
  expect(apiModule.cached.books(session)).toHaveLength(1)
})

it.each(bookEdits)('ignores an old session %s edit completing during a new library read', async (_, edit) => {
  let resolveEdit, resolveBooks
  http.mockReturnValueOnce(new Promise((r) => { resolveEdit = r }))
  const editing = edit()
  await logout()
  http.mockReturnValueOnce(new Promise((r) => { resolveBooks = r }))
  const reading = api.books(session)
  resolveEdit(response({ ok: true }))
  await editing
  resolveBooks(response({ items: [book] }))
  await expect(reading).resolves.toHaveLength(1)
  await flush()
  expect(snapshot().books.items).toHaveLength(1)
})

it.each([
  ['status', () => api.setStatus(session, 'one', 'finished'), { document: 'one', status: 'finished', status_at: 200 }, { status: 'finished', percentage: 1 }],
  ['metadata', () => api.setInfo(session, 'one', { title: '  Edited  ', author: '' }), { document: 'one', title: 'Edited', author: null }, { title: 'Edited', author: null }],
  ['dates', () => api.setDates(session, 'one', { finished_date: '2026-10-28' }), { document: 'one', status: 'finished', finished_date: 1793145600 }, { status: 'finished', percentage: 1 }],
])('patches confirmed %s edits before an offline library reload', async (_, edit, result, expected) => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/progress?limit=500'
  const initial = { ...book, status: 'reading', percentage: 0.3, title: 'Old title', author: 'Old author' }
  localStorage.setItem(key, JSON.stringify({ items: [initial, { ...book, document: 'other' }], next: null, savedAt: 100 }))
  http.mockResolvedValueOnce(response(result))
  await expect(edit()).resolves.toEqual(result)
  expect(apiModule.cached.books(session)[0]).toMatchObject(expected)
  expect(snapshot().books.items[0]).toMatchObject({ ...expected, author: expected.author ?? (expected.author === null ? '' : 'Old author') })
  expect(snapshot().books.savedAt).toBe(100)
  http.mockRejectedValueOnce(new Error('offline'))
  const reloaded = await api.books(session)
  await flush()
  expect(reloaded[0]).toMatchObject(expected)
  expect(reloaded[1].document).toBe('other')
  expect(snapshot().books.savedAt).toBe(100)
  expect(snapshot().books.items[0].timestamp).toBe(initial.timestamp)
})

it('invalidates library data if an edited title cannot fit in its cached record', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/progress?limit=500'
  const record = { items: [book], next: null, savedAt: 100 }
  localStorage.setItem(key, JSON.stringify(record))
  const storage = limitStorage(key.length + JSON.stringify(record).length)
  try {
    http.mockResolvedValueOnce(response({ document: 'one', title: 'x'.repeat(500) }))
    await api.setInfo(session, 'one', { title: 'x'.repeat(500) })
    expect(apiModule.cached.books(session)).toBeNull()
    expect(snapshot().books).toBeNull()
  } finally {
    storage.mockRestore()
  }
})

it('requires a new library copy when clearing a manual status needs server derivation', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/progress?limit=500'
  localStorage.setItem(key, JSON.stringify({ items: [{ ...book, status: 'paused' }], next: null, savedAt: 100 }))
  http.mockResolvedValueOnce(response({ document: 'one', status: null, status_at: 200 }))
  await api.setStatus(session, 'one', null)
  expect(apiModule.cached.books(session)).toBeNull()
  expect(snapshot().books).toBeNull()
})

it.each(['book-after-hub', 'hub-after-book', 'same-book'])('rejects older overlapping clipping results (%s)', async (order) => {
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = order === 'hub-after-book' ? api.allClippings(session, []) : api.clippings(session, 'one')
  const rejected = expect(pending).rejects.toThrow('Reading data changed')
  http.mockResolvedValueOnce(response({ items: [], more: false }))
  if (order === 'book-after-hub') await api.allClippings(session, [])
  else await api.clippings(session, 'one')
  await flush()
  const fresh = snapshot()
  resolve(response({ items: [{ document: 'one', id: 'deleted', text: 'Deleted elsewhere' }], more: false }))
  await rejected
  await flush()
  expect(snapshot()).toEqual(fresh)
  apiModule.syncShortcutsCache(session)
  await flush()
  expect(snapshot().clippings.items).toEqual([])
})

it('allows independent book clipping requests to finish in either order', async () => {
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const first = api.clippings(session, 'one')
  http.mockResolvedValueOnce(response({ items: [{ id: 'second' }], more: false }))
  await api.clippings(session, 'two')
  resolve(response({ items: [{ id: 'first' }], more: false }))
  await first
  await flush()
  expect(snapshot().clippings.items.map((c) => c.id).sort()).toEqual(['first', 'second'])
})

it('does not invalidate an online clipping request when a newer request fails', async () => {
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = api.clippings(session, 'one')
  http.mockRejectedValueOnce(new Error('offline'))
  await expect(api.allClippings(session, [])).rejects.toThrow('offline')
  resolve(response({ items: [{ id: 'valid' }], more: false }))
  await expect(pending).resolves.toEqual([{ id: 'valid' }])
})

it('does not let an older legacy clipping batch overwrite a newer hub', async () => {
  let resolve
  http.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    .mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = api.allClippings(session, [book])
  const rejected = expect(pending).rejects.toThrow('Reading data changed')
  await flush()
  http.mockResolvedValueOnce(response({ items: [] }))
  await api.allClippings(session, [])
  resolve(response({ items: [{ id: 'deleted' }], more: false }))
  await rejected
  await flush()
  expect(snapshot().clippings.items).toEqual([])
})

it('does not let a newer offline fallback cancel a pending online clipping refresh', async () => {
  localStorage.setItem('crosspoint-offline:v2:reader@https://sync.test/api/v1/clippings', JSON.stringify({ items: [], savedAt: 100 }))
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = api.clippings(session, 'one')
  http.mockRejectedValueOnce(new Error('offline'))
  await api.allClippings(session, [])
  resolve(response({ items: [{ id: 'fresh' }], more: false }))
  await expect(pending).resolves.toEqual([{ id: 'fresh' }])
  await flush()
  expect(snapshot().clippings.items).toMatchObject([{ id: 'fresh' }])
})

it.each(['one', 'two'])('tracks only online books in a mixed legacy clipping batch (pending: %s)', async (pendingDoc) => {
  const prefix = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/clippings'
  localStorage.setItem(`${prefix}/two`, JSON.stringify({ items: [{ id: 'cached-two' }], savedAt: 100 }))
  let resolve
  http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
  const pending = api.clippings(session, pendingDoc)
  const settled = pendingDoc === 'one'
    ? expect(pending).rejects.toThrow('Reading data changed')
    : expect(pending).resolves.toEqual([{ id: 'fresh-two' }])
  http.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    .mockResolvedValueOnce(response({ items: [], more: false }))
    .mockRejectedValueOnce(new Error('offline'))
  await api.allClippings(session, [book, { ...book, document: 'two' }])
  resolve(response({ items: [{ id: pendingDoc === 'one' ? 'deleted' : 'fresh-two' }], more: false }))
  await settled
  await flush()
  expect(snapshot().clippings.items.some((c) => c.id === 'deleted')).toBe(false)
  if (pendingDoc === 'two') expect(snapshot().clippings.items.some((c) => c.id === 'fresh-two')).toBe(true)
})

it('requires fresh merge destination progress while retaining unrelated cached books', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/progress?limit=500'
  const source = { ...book, status: 'reading', percentage: 0.8, timestamp: 20 }
  const target = { ...book, document: 'two', status: 'reading', percentage: 0.2, timestamp: 10 }
  const other = { ...book, document: 'other', status: 'reading', percentage: 0.1, timestamp: 5 }
  localStorage.setItem(key, JSON.stringify({ items: [source, target, other], next: null, savedAt: 100 }))
  http.mockResolvedValueOnce(response({ document: 'two', merged: 'one', stats: true }))
  await api.merge(session, 'one', 'two')
  expect(apiModule.cached.books(session)).toEqual([other])
  expect(snapshot().books.items.map((b) => b.document)).toEqual(['other'])
  http.mockRejectedValueOnce(new Error('offline'))
  expect(await api.books(session)).toEqual([other])
  const merged = { ...target, percentage: 0.8, timestamp: 201 }
  http.mockResolvedValueOnce(response({ items: [merged, other] }))
  await api.books(session)
  await flush()
  expect(snapshot().books.items[0]).toMatchObject({ document: 'two', percentage: 0.8, timestamp: 201 })
})

it('waits for queued snapshot writes and native removal before completing logout', async () => {
  apiModule.saveSession(session)
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/progress?limit=500'
  localStorage.setItem(key, JSON.stringify({ items: [book], savedAt: 100 }))
  let finishWrite, finishClear
  invoke.mockImplementationOnce(() => new Promise((r) => { finishWrite = r }))
    .mockImplementationOnce(() => new Promise((r) => { finishClear = r }))
  const writing = apiModule.syncShortcutsCache(session)
  await flush()
  let completed = false
  const signingOut = logout()
  Promise.resolve(signingOut).then(() => { completed = true })
  await flush()
  expect(completed).toBe(false)
  expect(apiModule.loadSession()).toEqual(session)
  finishWrite()
  await writing
  await flush()
  expect(invoke.mock.calls.at(-1)[1].json).toBeNull()
  expect(completed).toBe(false)
  finishClear()
  await signingOut
  expect(apiModule.loadSession()).toBeNull()
})

it('surfaces failed snapshot removal and allows logout to be retried', async () => {
  apiModule.saveSession(session)
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    invoke.mockRejectedValueOnce(new Error('disk unavailable'))
    await expect(logout()).rejects.toThrow('disk unavailable')
    expect(apiModule.loadSession()).toEqual(session)
    await logout()
    expect(apiModule.loadSession()).toBeNull()
  } finally {
    warn.mockRestore()
  }
})

it('blocks snapshot publication and discards reads started while logout is pending', async () => {
  apiModule.saveSession(session)
  let finishClear, finishRead
  invoke.mockImplementationOnce(() => new Promise((r) => { finishClear = r }))
  const signingOut = logout()
  await flush()
  http.mockResolvedValueOnce(response({ items: [book] }))
  await api.books(session)
  await flush()
  expect(invoke.mock.calls.every(([, args]) => args.json === null)).toBe(true)
  http.mockReturnValueOnce(new Promise((r) => { finishRead = r }))
  const reading = api.books(session)
  finishClear()
  await signingOut
  finishRead(response({ items: [book] }))
  await reading
  await flush()
  expect(apiModule.cached.books(session)).toBeNull()
  expect(invoke.mock.calls.every(([, args]) => args.json === null)).toBe(true)
})

it('shares one native removal for overlapping logout attempts', async () => {
  let finish
  invoke.mockImplementationOnce(() => new Promise((r) => { finish = r }))
  const first = logout()
  const second = logout()
  expect(first).toBe(second)
  await flush()
  expect(invoke).toHaveBeenCalledOnce()
  finish()
  await first
})

it.each(['single-page', 'later-page'])('rejects an older library refresh after a newer one completes (%s)', async (paging) => {
  let finish
  if (paging === 'later-page') http.mockResolvedValueOnce(response({ items: [{ ...book, status: 'reading', percentage: 0.2 }], next: 'next' }))
  http.mockReturnValueOnce(new Promise((r) => { finish = r }))
  const pending = api.books(session)
  const rejected = expect(pending).rejects.toThrow('Reading data changed')
  await flush()
  const updated = { ...book, status: 'reading', percentage: 0.7, timestamp: 200 }
  http.mockResolvedValueOnce(response({ items: [updated] }))
  await api.books(session)
  await flush()
  const fresh = snapshot()
  finish(response({ items: [{ ...book, status: 'reading', percentage: 0.2, timestamp: 100 }] }))
  await rejected
  await flush()
  expect(apiModule.cached.books(session)).toEqual([updated])
  expect(snapshot()).toEqual(fresh)
})

it('does not let a later offline library fallback supersede a pending online refresh', async () => {
  const key = 'crosspoint-offline:v2:reader@https://sync.test/api/v1/progress?limit=500'
  localStorage.setItem(key, JSON.stringify({ items: [book], next: null, savedAt: 100 }))
  let finish
  http.mockReturnValueOnce(new Promise((r) => { finish = r }))
  const pending = api.books(session)
  http.mockRejectedValueOnce(new Error('offline'))
  await api.books(session)
  const fresh = { ...book, status: 'reading', percentage: 0.5, timestamp: 200 }
  finish(response({ items: [fresh] }))
  await expect(pending).resolves.toEqual([fresh])
  await flush()
  expect(snapshot().books.items[0]).toMatchObject({ percentage: 0.5, timestamp: 200 })
})

it('publishes newly discovered book clippings after an initially empty legacy batch', async () => {
  http.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
  await api.allClippings(session, [])
  http.mockResolvedValueOnce(response({ items: [book] }))
  await api.books(session)
  http.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })
    .mockResolvedValueOnce(response({ items: [{ id: 'new', text: 'Newly discovered passage' }], more: false }))
  await api.allClippings(session, [book])
  await flush()
  expect(snapshot().books.items.map((b) => b.document)).toEqual(['one'])
  expect(snapshot().clippings.items).toMatchObject([{ document: 'one', id: 'new', text: 'Newly discovered passage' }])
})
