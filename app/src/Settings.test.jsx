// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const env = vi.hoisted(() => ({ isApp: false }))
vi.mock('./api.js', () => ({
  get isApp() { return env.isApp },
  api: { oauthBegin: vi.fn(), oauthComplete: vi.fn(), connectors: vi.fn(), linkConnector: vi.fn() },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
let deliver = null
vi.mock('@tauri-apps/plugin-deep-link', () => ({ onOpenUrl: vi.fn(async (fn) => { deliver = fn; return () => (deliver = null) }) }))

const { api } = await import('./api.js')
const { openUrl } = await import('@tauri-apps/plugin-opener')
const { LinkForm } = await import('./Settings.jsx')

const session = { server: 'https://sync.test' }
const spotify = { id: 'spotify', name: 'Spotify', credential_kind: 'oauth' }
const AUTH = 'https://accounts.spotify.com/authorize?state=s1'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.useRealTimers()
  env.isApp = false
  deliver = null
})

describe('LinkForm', () => {
  it('never shows a token field for an unknown sign-in kind; asks to update the app', () => {
    render(<LinkForm session={session} conn={{ id: 'future', name: 'Future', credential_kind: 'magic' }} onLinked={() => {}} />)
    expect(screen.getByText('Update the CrossPoint Sync app to link Future.')).toBeTruthy()
    expect(screen.queryByPlaceholderText('Paste token')).toBeNull()
  })

  it('still shows the token field for token services', () => {
    render(<LinkForm session={session} conn={{ id: 'readwise', name: 'Readwise', credential_kind: 'token' }} onLinked={() => {}} />)
    expect(screen.getByPlaceholderText('Paste token')).toBeTruthy()
  })

  it('Spotify is a sign-in button, not a token field', () => {
    render(<LinkForm session={session} conn={spotify} onLinked={() => {}} />)
    expect(screen.getByRole('button', { name: 'Sign in with Spotify' })).toBeTruthy()
    expect(screen.queryByPlaceholderText('Paste token')).toBeNull()
  })

  it('web: begins on the server and sends this tab to Spotify', async () => {
    api.oauthBegin.mockResolvedValue({ authorize_url: AUTH })
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    render(<LinkForm session={session} conn={spotify} onLinked={() => {}} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(assign).toHaveBeenCalledWith(AUTH))
    expect(api.oauthBegin).toHaveBeenCalledWith(session, 'spotify', 'web')
    vi.unstubAllGlobals()
  })

  it('app: opens the browser and finishes when the app link delivers the redirect', async () => {
    env.isApp = true
    api.oauthBegin.mockResolvedValue({ authorize_url: AUTH })
    api.oauthComplete.mockResolvedValue({ linked: true })
    const onLinked = vi.fn()
    render(<LinkForm session={session} conn={spotify} onLinked={onLinked} />)
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith(AUTH))
    expect(api.oauthBegin).toHaveBeenCalledWith(session, 'spotify', 'app')
    await act(async () => deliver(['https://sync.test/connectors/spotify/callback?state=s1&code=c1']))
    expect(api.oauthComplete).toHaveBeenCalledWith(session, 'spotify', { state: 's1', code: 'c1', error: undefined })
    await waitFor(() => expect(onLinked).toHaveBeenCalled())
  })

  it("app: when no app link fires, notices that the callback page linked it", async () => {
    vi.useFakeTimers()
    env.isApp = true
    api.oauthBegin.mockResolvedValue({ authorize_url: AUTH })
    api.connectors.mockResolvedValueOnce({ connectors: [{ id: 'spotify', linked: false }] })
      .mockResolvedValue({ connectors: [{ id: 'spotify', linked: true }] })
    const onLinked = vi.fn()
    render(<LinkForm session={session} conn={spotify} onLinked={onLinked} />)
    await act(async () => fireEvent.click(screen.getByRole('button')))
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(onLinked).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(onLinked).toHaveBeenCalled()
    expect(api.oauthComplete).not.toHaveBeenCalled()
  })
})
