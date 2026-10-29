// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
// Node's experimental localStorage can shadow jsdom's storage in Vitest.
vi.stubGlobal('localStorage', new JSDOM('', { url: 'https://app.test' }).window.localStorage)
const { api, cached, loadSession, login, logout, saveSession, hostedServerUrl } = await import('./api.js')
const session = (username, server = 'https://sync.test') => ({ server, username, key: 'key' })
const prefix = (s) => `crosspoint-offline:v2:${s.username}@${s.server}`
const progress = '/api/v1/progress?limit=500'
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })

beforeEach(async () => {
  await logout()
  localStorage.clear()
  fetchMock.mockReset()
})

describe('prefixed server URLs', () => {
  it.each(['', '/reading', '/services/reading'])('detects the hosted server at %j', (basePath) => {
    expect(hostedServerUrl(new URL(`https://sync.test${basePath}/app/`))).toBe(`https://sync.test${basePath}`)
  })
  it.each(['', '/reading', '/services/reading'])('detects the hosted server from the explicit index URL at %j', (basePath) => {
    expect(hostedServerUrl(new URL(`https://sync.test${basePath}/app/index.html`))).toBe(`https://sync.test${basePath}`)
  })
  it.each(['https://sync.test/application/', 'https://sync.test/app/assets/', 'tauri://localhost/app/'])('does not mistake %s for a hosted app', (url) => {
    expect(hostedServerUrl(new URL(url))).toBeNull()
  })
  it('preserves the prefix during server discovery, authentication and API calls', async () => {
    fetchMock.mockResolvedValueOnce(response({ status: 'ok' }))
      .mockResolvedValueOnce(response({ authorized: true }))
      .mockResolvedValueOnce(response({ items: [] }))
    const s = await login('https://sync.test/reading/', 'reader', 'password')
    await api.books(s)
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://sync.test/reading/healthz', 'https://sync.test/reading/users/auth',
      `https://sync.test/reading${progress}`,
    ])
  })
});

it('rejects a failed activity refresh while retaining its saved copy for display', async () => {
  const s = session('reader')
  const saved = { books: [], days: [], reading_days: [] }
  expect(cached.activityUpdatedAt(s)).toBeNull()
  const before = Date.now()
  fetchMock.mockResolvedValueOnce(response(saved))
  await api.activity(s)
  expect(cached.activity(s)).toEqual(saved)
  const savedAt = cached.activityUpdatedAt(s)
  expect(savedAt).toBeGreaterThanOrEqual(before)
  expect(savedAt).toBeLessThanOrEqual(Date.now())
  expect(cached.activityUpdatedAt(session('other-reader'))).toBeNull()
  fetchMock.mockRejectedValue(new Error('offline'))
  await expect(api.activity(s)).rejects.toThrow('offline')
  expect(cached.activity(s)).toEqual(saved)
  expect(cached.activityUpdatedAt(s)).toBe(savedAt)
})

describe('account data isolation', () => {
  it('ignores legacy copies that may contain a different account after upgrading', async () => {
    localStorage.setItem(`crosspoint-offline:uxj3@https://sync.test${progress}`, JSON.stringify({ items: [{ title: 'uxj4 book' }] }))
    expect(cached.books(session('uxj3'))).toBeNull()
    await logout()
    expect(Object.keys(localStorage)).toHaveLength(0)
  })

  it('uses only the selected account credentials and bypasses the HTTP cache', async () => {
    fetchMock.mockResolvedValue(response({ items: [] }))
    await api.books(session('uxj3'))
    expect(fetchMock).toHaveBeenCalledWith(`https://sync.test${progress}`, expect.objectContaining({
      credentials: 'omit', cache: 'no-store', headers: expect.objectContaining({ 'x-auth-user': 'uxj3', 'x-auth-key': 'key' }),
    }))
  })

  it('keeps offline copies separate by account and server', async () => {
    const a = session('uxj4')
    fetchMock.mockResolvedValueOnce(response({ items: [{ document: 'shared', title: 'uxj4 book' }] }))
    await api.books(a)
    fetchMock.mockRejectedValue(new Error('offline'))
    expect((await api.books(a))[0].title).toBe('uxj4 book')
    expect(cached.books(session('uxj3'))).toBeNull()
    expect(cached.books(session('uxj4', 'https://other.test'))).toBeNull()
    await expect(api.books(session('uxj3'))).rejects.toThrow('offline')
  })

  it('sign-out removes account data but preserves device preferences', async () => {
    saveSession(session('uxj4'))
    localStorage.setItem('crosspoint-theme', 'dark')
    localStorage.setItem(`${prefix(session('uxj4'))}${progress}`, JSON.stringify({ items: [] }))
    await logout()
    expect(loadSession()).toBeNull()
    expect(cached.books(session('uxj4'))).toBeNull()
    expect(localStorage.getItem('crosspoint-theme')).toBe('dark')
  })

  it('cannot sign in offline using a previously cached authentication response', async () => {
    localStorage.setItem(`${prefix(session('uxj3'))}/users/auth`, JSON.stringify({ authorized: true }))
    fetchMock.mockResolvedValueOnce(response({ status: 'ok' })).mockRejectedValueOnce(new Error('offline'))
    await expect(login('https://sync.test', 'uxj3', 'password')).rejects.toThrow('offline')
    expect(loadSession()).toBeNull()
  })

  it('does not fall back to saved data when the server rejects the credentials', async () => {
    localStorage.setItem(`${prefix(session('uxj3'))}${progress}`, JSON.stringify({ items: [{ title: 'saved book' }] }))
    fetchMock.mockResolvedValue(response({ message: 'Unauthorized' }, 401))
    await expect(api.books(session('uxj3'))).rejects.toMatchObject({ status: 401 })
  })

  it('a verified sign-in clears old copies that may have been filled from a different account cookie', async () => {
    localStorage.setItem(`${prefix(session('uxj3'))}${progress}`, JSON.stringify({ items: [{ title: 'uxj4 book' }] }))
    fetchMock.mockResolvedValueOnce(response({ status: 'ok' })).mockResolvedValueOnce(response({ authorized: true }))
    await login('https://sync.test', 'uxj3', 'password')
    expect(loadSession().username).toBe('uxj3')
    expect(cached.books(session('uxj3'))).toBeNull()
  })

  it('a delayed old-account response cannot restore data after signing out and back in', async () => {
    let resolve
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolve = r }))
    const pending = api.books(session('uxj4'))
    await logout()
    fetchMock.mockResolvedValueOnce(response({ status: 'ok' })).mockResolvedValueOnce(response({ authorized: true }))
    await login('https://sync.test', 'uxj3', 'password')
    resolve(response({ items: [{ title: 'old account' }] }))
    await pending
    expect(cached.books(session('uxj4'))).toBeNull()
    expect(cached.books(session('uxj3'))).toBeNull()
  })
})

describe('book list paging', () => {
  const book = (n) => ({ document: `d${n}`, title: `Book ${n}` })
  const page = (ns, next) => response({ items: ns.map(book), next })
  const titles = (r) => r.map((b) => b.title)

  it('follows every page and saves the whole list for offline use', async () => {
    const s = session('pager')
    fetchMock.mockResolvedValueOnce(page([1, 2], '100:d2')).mockResolvedValueOnce(page([3], '99:d3')).mockResolvedValueOnce(page([4], null))
    expect(titles(await api.books(s))).toEqual(['Book 1', 'Book 2', 'Book 3', 'Book 4'])
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `https://sync.test${progress}`,
      `https://sync.test${progress}&cursor=100%3Ad2`,
      `https://sync.test${progress}&cursor=99%3Ad3`,
    ])
    expect(titles(cached.books(s))).toEqual(['Book 1', 'Book 2', 'Book 3', 'Book 4'])
    // Later pages are not saved under their own keys (cursors change with every sync).
    expect(Object.keys(localStorage).filter((k) => k.includes('cursor'))).toEqual([])
  })

  it('makes one request when everything fits on the first page', async () => {
    fetchMock.mockResolvedValueOnce(page([1], null))
    expect(titles(await api.books(session('pager')))).toEqual(['Book 1'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the full saved list when a later page fails', async () => {
    const s = session('pager')
    fetchMock.mockResolvedValueOnce(page([1, 2], '1:d2')).mockResolvedValueOnce(page([3], null))
    await api.books(s)
    fetchMock.mockResolvedValueOnce(page([5, 1], '1:d1')).mockRejectedValueOnce(new Error('dropped'))
    await expect(api.books(s)).rejects.toThrow('dropped')
    expect(titles(cached.books(s))).toEqual(['Book 1', 'Book 2', 'Book 3'])
  })

  it('keeps the full saved list when two loads overlap and one fails', async () => {
    const s = session('pager')
    fetchMock.mockResolvedValueOnce(page([1, 2], '1:d2')).mockResolvedValueOnce(page([3], null))
    await api.books(s)
    fetchMock.mockResolvedValueOnce(page([1, 2], '1:d2')).mockResolvedValueOnce(page([1, 2], '1:d2'))
      .mockRejectedValueOnce(new Error('dropped')).mockResolvedValueOnce(page([3], null))
    const [a, b] = await Promise.allSettled([api.books(s), api.untitledBooks(s)])
    expect([a.status, b.status].sort()).toEqual(['fulfilled', 'rejected'])
    expect(titles(cached.books(s))).toEqual(['Book 1', 'Book 2', 'Book 3'])
  })

  it('shows the whole saved list when offline', async () => {
    const s = session('pager')
    fetchMock.mockResolvedValueOnce(page([1], '1:d1')).mockResolvedValueOnce(page([2], null))
    await api.books(s)
    fetchMock.mockReset()
    fetchMock.mockRejectedValue(new Error('offline'))
    expect(titles(await api.books(s))).toEqual(['Book 1', 'Book 2'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails without saving a short list when the server repeats a cursor', async () => {
    const s = session('pager')
    fetchMock.mockResolvedValueOnce(page([1], '1:d1')).mockResolvedValueOnce(page([2], '2:d2')).mockResolvedValueOnce(page([3], null))
    await api.books(s)
    fetchMock.mockResolvedValueOnce(page([1], '1:d1')).mockResolvedValue(page([2], '1:d1'))
    await expect(api.books(s)).rejects.toThrow('repeated')
    expect(fetchMock).toHaveBeenCalledTimes(5)
    expect(titles(cached.books(s))).toEqual(['Book 1', 'Book 2', 'Book 3'])
  })

  it('fails when a review list repeats a cursor', async () => {
    fetchMock.mockResolvedValueOnce(response({ books: [{ document: 'a' }], next: '1:a' })).mockResolvedValue(response({ books: [{ document: 'b' }], next: '1:a' }))
    await expect(api.review(session('pager'), 'hardcover')).rejects.toThrow('repeated')
  })

  it('does not save the list for an account that signed out meanwhile', async () => {
    const s = session('pager')
    fetchMock.mockResolvedValueOnce(page([1], '1:d1')).mockImplementationOnce(async () => {
      await logout()
      return page([2], null)
    })
    await api.books(s)
    expect(cached.books(s)).toBeNull()
  })

  it('finds untitled books on later pages', async () => {
    fetchMock.mockResolvedValueOnce(page([1], '1:d1')).mockResolvedValueOnce(response({ items: [{ document: 'u1', title: null, filename: null }], next: null }))
    expect((await api.untitledBooks(session('pager'))).map((b) => b.document)).toEqual(['u1'])
  })
})

it('loads every page of a connector review list', async () => {
  fetchMock.mockResolvedValueOnce(response({ books: [{ document: 'a' }], next: '1:a' }))
    .mockResolvedValueOnce(response({ books: [{ document: 'b' }], next: null }))
  expect((await api.review(session('pager'), 'hardcover')).map((b) => b.document)).toEqual(['a', 'b'])
  expect(fetchMock.mock.calls[1][0]).toBe('https://sync.test/api/v1/connectors/hardcover/review?cursor=1%3Aa')
})
