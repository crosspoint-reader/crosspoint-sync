// @vitest-environment jsdom
import { StrictMode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const settingsCallbacks = vi.hoisted(() => ({ onSession: null, onLogout: null }))

vi.mock('./api.js', () => ({
  DEFAULT_SERVER: 'https://sync.test', isApp: false, hostedServer: null,
  loadSession: vi.fn(), lastServer: vi.fn(() => 'https://sync.test'),
  login: vi.fn(), register: vi.fn(), logout: vi.fn(), saveSession: vi.fn(), syncShortcutsCache: vi.fn(),
  offline: new EventTarget(),
  api: { books: vi.fn(), summary: vi.fn(), activity: vi.fn() },
  cached: { books: () => [], summary: () => null, activity: () => null, activityUpdatedAt: () => null },
}))
vi.mock('./theme.js', () => ({ useTheme: () => ['system', vi.fn()] }))
vi.mock('./widget.js', () => ({ clearWidget: vi.fn(), updateWidget: vi.fn() }))
vi.mock('./tabbar.js', () => ({ nativeTabBar: false, mountTabBar: vi.fn(), selectNativeTab: vi.fn(), useNativeButton: vi.fn(), useSheet: vi.fn() }))
vi.mock('./Settings.jsx', () => ({ default: ({ onLogout, onSession }) => {
  settingsCallbacks.onSession = onSession
  settingsCallbacks.onLogout = onLogout
  return <button onClick={onLogout}>Sign out</button>
}, Matches: () => null }))
vi.mock('./Library.jsx', () => ({ default: () => null }))
vi.mock('./Book.jsx', () => ({ default: () => null }))
vi.mock('./Stats.jsx', () => ({ default: () => null }))
vi.mock('./Send.jsx', () => ({ default: () => null }))
vi.mock('./Wallpaper.jsx', () => ({ default: () => null }))
vi.mock('./Browse.jsx', () => ({ default: () => null }))
vi.mock('./Clippings.jsx', () => ({ default: () => null }))
vi.mock('./Install.jsx', () => ({ default: () => null }))
const { api, loadSession, logout, saveSession } = await import('./api.js')
const { default: App } = await import('./App.jsx')

beforeEach(() => {
  location.hash = '#/settings'
  loadSession.mockReturnValue({ server: 'https://sync.test', username: 'reader', key: 'secret' })
  api.books.mockReset().mockResolvedValue([])
  api.summary.mockReset().mockResolvedValue({})
  api.activity.mockReset().mockResolvedValue([])
  logout.mockReset().mockResolvedValue()
  saveSession.mockClear()
})
afterEach(cleanup)

it('shows the sign-in form only after logout confirms native removal', async () => {
  let finish
  logout.mockReturnValueOnce(new Promise((r) => { finish = r }))
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
  expect(screen.getByText('Signing out…')).toBeTruthy()
  await act(async () => { finish() })
  expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy()
})

it('surfaces native removal errors and lets the user retry before signing out', async () => {
  logout.mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValueOnce()
  render(<App />)
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  const retry = await screen.findByRole('button', { name: 'Retry sign out' })
  expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('disk unavailable')
  fireEvent.click(retry)
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy())
  expect(logout).toHaveBeenCalledTimes(2)
})

it('also waits for native removal when an expired session triggers logout', async () => {
  let finish
  logout.mockReturnValueOnce(new Promise((r) => { finish = r }))
  api.activity.mockRejectedValueOnce(Object.assign(new Error('Signed out'), { status: 401 }))
  render(<App />)
  await screen.findByText('Signing out…')
  expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
  await act(async () => { finish() })
  expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy()
})

it.each(['pending', 'complete'])('ignores a stale password-change callback when logout is %s', async (phase) => {
  let finish
  logout.mockReturnValueOnce(new Promise((r) => { finish = r }))
  render(<App />)
  const oldSessionCallback = settingsCallbacks.onSession
  const oldLogoutCallback = settingsCallbacks.onLogout
  fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
  if (phase === 'complete') await act(async () => { finish() })
  await act(async () => { oldSessionCallback({ server: 'https://sync.test', username: 'reader', key: 'new-password-key' }) })
  expect(saveSession).not.toHaveBeenCalled()
  if (phase === 'pending') await act(async () => { finish() })
  expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy()
  await act(async () => { await oldLogoutCallback() })
  expect(logout).toHaveBeenCalledOnce()
})

it('continues accepting password updates for the active session', async () => {
  render(<App />)
  const updated = { server: 'https://sync.test', username: 'reader', key: 'new-password-key' }
  await act(async () => { settingsCallbacks.onSession(updated) })
  expect(saveSession).toHaveBeenCalledWith(updated)
  expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
})

it('waits for startup cleanup before showing sign-in when no session is saved', async () => {
  loadSession.mockReturnValue(null)
  let finish
  logout.mockReturnValueOnce(new Promise((r) => { finish = r }))
  render(<App />)
  expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
  expect(screen.getByText('Signing out…')).toBeTruthy()
  await act(async () => { finish() })
  expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy()
  expect(logout).toHaveBeenCalledOnce()
})

it('offers startup cleanup retry rather than sign-in when native removal fails', async () => {
  loadSession.mockReturnValue(null)
  logout.mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValueOnce()
  render(<App />)
  const retry = await screen.findByRole('button', { name: 'Retry sign out' })
  expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
  expect(screen.getByRole('alert').textContent).toContain('disk unavailable')
  fireEvent.click(retry)
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy())
  expect(logout).toHaveBeenCalledTimes(2)
})

it('shares startup cleanup across StrictMode effect replays', async () => {
  loadSession.mockReturnValue(null)
  let finish
  logout.mockReturnValueOnce(new Promise((r) => { finish = r }))
  render(<StrictMode><App /></StrictMode>)
  expect(logout).toHaveBeenCalledOnce()
  expect(screen.queryByRole('heading', { name: 'Sign in' })).toBeNull()
  await act(async () => { finish() })
  expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy()
})
