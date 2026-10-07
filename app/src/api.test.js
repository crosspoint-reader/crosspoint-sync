// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JSDOM } from 'jsdom'

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)
// Node's experimental localStorage can shadow jsdom's storage in Vitest.
vi.stubGlobal('localStorage', new JSDOM('', { url: 'https://app.test' }).window.localStorage)
const { api, cached, loadSession, login, logout, saveSession } = await import('./api.js')
const session = (username, server = 'https://sync.test') => ({ server, username, key: 'key' })
const prefix = (s) => `crosspoint-offline:v2:${s.username}@${s.server}`
const progress = '/api/v1/progress?limit=500'
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data })

beforeEach(() => {
  logout()
  localStorage.clear()
  fetchMock.mockReset()
})

describe('account data isolation', () => {
  it('ignores legacy copies that may contain a different account after upgrading', () => {
    localStorage.setItem(`crosspoint-offline:uxj3@https://sync.test${progress}`, JSON.stringify({ items: [{ title: 'uxj4 book' }] }))
    expect(cached.books(session('uxj3'))).toBeNull()
    logout()
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
    logout()
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
    logout()
    fetchMock.mockResolvedValueOnce(response({ status: 'ok' })).mockResolvedValueOnce(response({ authorized: true }))
    await login('https://sync.test', 'uxj3', 'password')
    resolve(response({ items: [{ title: 'old account' }] }))
    await pending
    expect(cached.books(session('uxj4'))).toBeNull()
    expect(cached.books(session('uxj3'))).toBeNull()
  })
})
