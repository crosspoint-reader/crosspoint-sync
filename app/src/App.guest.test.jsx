// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { JSDOM } from 'jsdom'

// Node's experimental localStorage can shadow jsdom's storage in Vitest.
vi.stubGlobal('localStorage', new JSDOM('', { url: 'https://app.test' }).window.localStorage)

vi.mock('./api.js', () => ({
  DEFAULT_SERVER: 'https://sync.test', isApp: true, hostedServer: null,
  loadSession: vi.fn(() => null), lastServer: vi.fn(() => 'https://sync.test'),
  login: vi.fn(), register: vi.fn(), logout: vi.fn(async () => {}), saveSession: vi.fn(), syncShortcutsCache: vi.fn(),
  offline: new EventTarget(), api: {}, cached: {},
}))
vi.mock('./theme.js', () => ({ useTheme: () => ['system', vi.fn()] }))
vi.mock('./widget.js', () => ({ clearWidget: vi.fn(), updateWidget: vi.fn() }))
vi.mock('./tabbar.js', () => ({ nativeTabBar: false, mountTabBar: vi.fn(), selectNativeTab: vi.fn(), useNativeButton: vi.fn(), useSheet: vi.fn() }))
vi.mock('./Settings.jsx', () => ({ default: ({ session, onSignIn }) => (session ? null : <button onClick={onSignIn}>Guest settings</button>), Matches: () => null }))
vi.mock('./Browse.jsx', () => ({ default: () => <p>Browse page</p> }))
vi.mock('./Send.jsx', () => ({ default: () => <p>Send page</p> }))
vi.mock('./Install.jsx', () => ({ default: () => null }))
vi.mock('./Library.jsx', () => ({ default: () => null }))
vi.mock('./Book.jsx', () => ({ default: () => null }))
vi.mock('./Stats.jsx', () => ({ default: () => null }))
vi.mock('./Clippings.jsx', () => ({ default: () => null }))
const { default: App } = await import('./App.jsx')
afterEach(() => {
  cleanup()
  localStorage.clear()
})

it('skips sign-in to Browse, Send and Settings, and remembers it until signing in', async () => {
  location.hash = ''
  render(<App />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }))
  expect(screen.getByText('Browse page')).toBeTruthy()
  expect(screen.getAllByRole('link').map((a) => a.textContent).filter((t) => ['Browse', 'Send', 'Settings', 'Library', 'Stats'].includes(t))).toEqual(['Browse', 'Send', 'Settings', 'Browse', 'Send', 'Settings'])

  cleanup()
  render(<App />)
  await act(async () => {})
  expect(screen.getByText('Browse page')).toBeTruthy()

  await act(async () => { location.hash = '#/settings'; dispatchEvent(new HashChangeEvent('hashchange')) })
  fireEvent.click(screen.getByRole('button', { name: 'Guest settings' }))
  expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy()
  expect(localStorage.getItem('crosspoint-guest')).toBeNull()
})
