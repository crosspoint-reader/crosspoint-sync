// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const env = vi.hoisted(() => ({ isApp: false }))
vi.mock('./api.js', () => ({
  get isApp() { return env.isApp },
  api: { oauthBegin: vi.fn(), oauthComplete: vi.fn(), connectors: vi.fn(), linkConnector: vi.fn(), setClientId: vi.fn(), removeClientId: vi.fn(), syncConnector: vi.fn(), unlinkConnector: vi.fn(), clearData: vi.fn(), deleteAccount: vi.fn() },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))
let deliver = null
vi.mock('@tauri-apps/plugin-deep-link', () => ({ onOpenUrl: vi.fn(async (fn) => { deliver = fn; return () => (deliver = null) }) }))

const { api } = await import('./api.js')
const { openUrl } = await import('@tauri-apps/plugin-opener')
const { default: Settings, LinkForm } = await import('./Settings.jsx')
vi.mock('./tabbar.js', async (orig) => ({ ...(await orig()), useNativeBack: vi.fn() }))
const { useNativeBack } = await import('./tabbar.js')
vi.mock('./ui.jsx', async (orig) => ({ ...(await orig()), notify: vi.fn() }))

const session = { server: 'https://sync.test' }
const OWN = 'abcdef0123456789abcdef0123456789'
const REDIRECT = 'https://books.example.net/connectors/spotify/callback'
const oauth = (o = {}) => ({ redirect_uri: REDIRECT, client_id: OWN, shared: false, ...o })
const spotify = { id: 'spotify', name: 'Spotify', credential_kind: 'oauth', oauth: oauth() }
const signIn = () => screen.getByRole('button', { name: 'Sign in with Spotify' })
const AUTH = 'https://accounts.spotify.com/authorize?state=s1'

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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
    expect(signIn()).toBeTruthy()
    expect(screen.queryByPlaceholderText('Paste token')).toBeNull()
  })

  it('web: begins on the server and sends this tab to Spotify', async () => {
    api.oauthBegin.mockResolvedValue({ authorize_url: AUTH })
    const assign = vi.fn()
    vi.stubGlobal('location', { ...window.location, assign })
    render(<LinkForm session={session} conn={spotify} onLinked={() => {}} />)
    fireEvent.click(signIn())
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
    fireEvent.click(signIn())
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
    await act(async () => fireEvent.click(signIn()))
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(onLinked).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTimeAsync(3000))
    expect(onLinked).toHaveBeenCalled()
    expect(api.oauthComplete).not.toHaveBeenCalled()
  })
})

describe('Spotify Client ID setup', () => {
  const setup = (o) => render(<LinkForm session={session} conn={{ ...spotify, oauth: oauth(o) }} onLinked={() => {}} />)
  const input = () => screen.getByPlaceholderText('Client ID')
  const saveButton = () => screen.getByRole('button', { name: 'Save Client ID' })

  it("shows the three steps with this server's redirect URI when there's no Client ID yet", () => {
    setup({ client_id: null })
    expect(screen.getByText('Create an app')).toBeTruthy()
    expect(screen.getByText('Add this redirect URI')).toBeTruthy()
    expect(screen.getByText('Paste the Client ID')).toBeTruthy()
    expect(screen.getByText(REDIRECT)).toBeTruthy()
    expect(screen.getByText(/needs Premium, and as the app.s owner it.s allowed in automatically/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in with Spotify' })).toBeNull()
  })

  it('copies the redirect URI', async () => {
    const writeText = vi.fn().mockResolvedValue()
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    setup({ client_id: null })
    fireEvent.click(screen.getByRole('button', { name: 'Copy redirect URI' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(REDIRECT))
    vi.unstubAllGlobals()
  })

  it('checks the format before saving', () => {
    setup({ client_id: null })
    fireEvent.change(input(), { target: { value: 'nope' } })
    expect(screen.getByText('A Client ID is 32 letters and numbers.')).toBeTruthy()
    expect(saveButton().disabled).toBe(true)
    fireEvent.change(input(), { target: { value: ` ${OWN} ` } })
    expect(saveButton().disabled).toBe(false)
  })

  it('saves it, then offers sign-in with that app', async () => {
    api.setClientId.mockResolvedValue({ client_id: OWN })
    setup({ client_id: null })
    fireEvent.change(input(), { target: { value: OWN } })
    fireEvent.click(saveButton())
    await waitFor(() => expect(signIn()).toBeTruthy())
    expect(api.setClientId).toHaveBeenCalledWith(session, 'spotify', OWN)
    expect(screen.getByText('…6789')).toBeTruthy()
  })

  it("shows Spotify's rejection, pointing at the step", async () => {
    api.setClientId.mockRejectedValue(new Error("Spotify doesn't recognize this Client ID. Copy it again from your app's Settings in the Spotify dashboard (step 3)."))
    setup({ client_id: null })
    fireEvent.change(input(), { target: { value: OWN } })
    fireEvent.click(saveButton())
    expect(await screen.findByText(/doesn't recognize this Client ID.*step 3/)).toBeTruthy()
  })

  it('can change or remove it later', async () => {
    api.removeClientId.mockResolvedValue({ client_id: null })
    setup()
    expect(screen.getByText(/INVALID_CLIENT: Invalid redirect URI/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    expect(input()).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(screen.getByText('Create an app')).toBeTruthy()) // no shared app: back to the steps
    expect(api.removeClientId).toHaveBeenCalledWith(session, 'spotify')
  })

  it("with the server's shared app, signs in directly and offers your own as an option", () => {
    setup({ client_id: null, shared: true })
    expect(signIn()).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Use your own Spotify app' }))
    expect(screen.getByText('Create an app')).toBeTruthy()
  })
})


it('Settings provides a Library back destination for both native and HTML navigation', async () => {
  api.connectors.mockResolvedValue({ connectors: [] })
  render(<Settings session={{ ...session, username: 'reader' }} theme={['system', vi.fn()]} onSession={vi.fn()} onLogout={vi.fn()} />)
  expect(screen.getByRole('link', { name: 'Back to Library' }).getAttribute('href')).toBe('#/')
  expect(useNativeBack).toHaveBeenCalledWith('#/')
  await waitFor(() => expect(api.connectors).toHaveBeenCalled())
})

describe('service delivery status', () => {
  const reader = { ...session, username: 'reader' }
  const connector = (extra = {}) => ({ id: 'bookorbit', name: 'BookOrbit', linked: true,
    status: 'ok', queue: { pending: 0, dead: 0 }, ...extra })
  const renderSettings = () => render(<Settings session={reader} theme={['system', vi.fn()]} onSession={vi.fn()} onLogout={vi.fn()} />)

  it('shows queued items and saved clipping failures in Settings', async () => {
    api.connectors.mockResolvedValue({ connectors: [connector({ queue: { pending: 2, dead: 1 },
      queue_errors: [{ kind: 'clipping', count: 1, message: 'clipping has no position (update the reader firmware)' }] })] })
    renderSettings()
    expect(await screen.findByText('2 items waiting to sync · 1 item failed')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('1 clipping: clipping has no position')
  })

  it('labels the queued count as items rather than books', async () => {
    const { notify } = await import('./ui.jsx')
    api.connectors.mockResolvedValue({ connectors: [connector()] })
    api.syncConnector.mockResolvedValue({ queued: 36 })
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Sync BookOrbit now' }))
    await waitFor(() => expect(notify).toHaveBeenCalledWith({ title: 'Syncing to BookOrbit', detail: '36 items queued' }))
  })

  it('refreshes pending delivery status and stops polling after the queue finishes', async () => {
    vi.useFakeTimers()
    api.connectors.mockResolvedValueOnce({ connectors: [connector({ queue: { pending: 1, dead: 0 } })] })
      .mockResolvedValue({ connectors: [connector({ queue: { pending: 0, dead: 1 },
        queue_errors: [{ kind: 'clipping', count: 1, message: 'clipping text not found' }] })] })
    await act(async () => renderSettings())
    expect(screen.getByText('1 item waiting to sync')).toBeTruthy()
    await act(async () => vi.advanceTimersByTimeAsync(5000))
    expect(screen.getByText('1 item failed')).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toContain('clipping text not found')
    await act(async () => vi.advanceTimersByTimeAsync(15000))
    expect(api.connectors).toHaveBeenCalledTimes(2)
  })
})

describe('in-app destructive confirmations', () => {
  const reader = { ...session, username: 'reader' }
  const connector = { id: 'bookorbit', name: 'BookOrbit', linked: true, status: 'ok' }
  const renderSettings = (onLogout = vi.fn()) => render(<Settings session={reader} theme={['system', vi.fn()]} onSession={vi.fn()} onLogout={onLogout} />)

  beforeEach(() => {
    env.isApp = true
    vi.spyOn(window, 'confirm').mockReturnValue(false)
    vi.spyOn(window, 'prompt').mockReturnValue(null)
    api.connectors.mockResolvedValue({ connectors: [connector] })
    api.unlinkConnector.mockReset().mockResolvedValue({})
    api.clearData.mockReset().mockResolvedValue({})
    api.deleteAccount.mockReset().mockResolvedValue({})
  })

  it.each(['Cancel', 'Close'])('dismisses every confirmation with %s without requests', async (dismiss) => {
    renderSettings()
    for (const name of ['Unlink', 'Clear reading data', 'Delete account']) {
      fireEvent.click(await screen.findByRole('button', { name, exact: true }))
      const dialog = screen.getByRole('dialog')
      if (name === 'Delete account') fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'reader' } })
      fireEvent.click(within(dialog).getByRole('button', { name: dismiss }))
      expect(screen.queryByRole('dialog')).toBeNull()
    }
    expect(api.unlinkConnector).not.toHaveBeenCalled()
    expect(api.clearData).not.toHaveBeenCalled()
    expect(api.deleteAccount).not.toHaveBeenCalled()
    expect(window.confirm).not.toHaveBeenCalled()
    expect(window.prompt).not.toHaveBeenCalled()
  })

  it('retries a failed unlink and refreshes the service list after success', async () => {
    api.unlinkConnector.mockRejectedValueOnce(new Error('Unlink failed'))
    renderSettings()
    fireEvent.click(await screen.findByRole('button', { name: 'Unlink', exact: true }))
    const dialog = screen.getByRole('dialog', { name: 'Unlink BookOrbit?' })
    expect(api.unlinkConnector).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlink', exact: true }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Unlink failed')
    expect(api.connectors).toHaveBeenCalledTimes(1)
    api.connectors.mockResolvedValue({ connectors: [{ ...connector, linked: false }] })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unlink', exact: true }))
    await screen.findByRole('button', { name: 'Link', exact: true })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.unlinkConnector).toHaveBeenNthCalledWith(2, reader, 'bookorbit')
    expect(api.connectors).toHaveBeenCalledTimes(2)
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('clears data only after confirmation and reloads only after a successful retry', async () => {
    const reload = vi.fn()
    vi.stubGlobal('location', { hash: '#/settings', reload })
    api.clearData.mockRejectedValueOnce(new Error('Clear failed'))
    renderSettings()
    fireEvent.click(screen.getByRole('button', { name: 'Clear reading data', exact: true }))
    const dialog = screen.getByRole('dialog')
    expect(api.clearData).not.toHaveBeenCalled()
    expect(dialog.textContent).toContain('Your account stays')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear reading data' }))
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Clear failed')
    expect(reload).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Clear reading data' }))
    await waitFor(() => expect(reload).toHaveBeenCalledOnce())
    expect(api.clearData).toHaveBeenNthCalledWith(2, reader)
    expect(location.hash).toBe('#/')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(window.confirm).not.toHaveBeenCalled()
  })

  it('requires the matching username and retains it when account deletion fails', async () => {
    api.deleteAccount.mockRejectedValueOnce(new Error('Delete failed'))
    const onLogout = vi.fn()
    renderSettings(onLogout)
    fireEvent.click(screen.getByRole('button', { name: 'Delete account', exact: true }))
    const dialog = screen.getByRole('dialog')
    const input = within(dialog).getByRole('textbox', { name: 'Username' })
    const submit = within(dialog).getByRole('button', { name: 'Delete account' })
    for (const value of ['', '   ', 'Reader', 'someone else']) {
      fireEvent.change(input, { target: { value } })
      expect(submit.disabled).toBe(true)
      fireEvent.submit(input.closest('form'))
    }
    expect(api.deleteAccount).not.toHaveBeenCalled()
    fireEvent.change(input, { target: { value: ' reader ' } })
    fireEvent.click(submit)
    expect((await within(dialog).findByRole('alert')).textContent).toBe('Delete failed')
    expect(input.value).toBe(' reader ')
    expect(onLogout).not.toHaveBeenCalled()
    fireEvent.click(submit)
    await waitFor(() => expect(onLogout).toHaveBeenCalledOnce())
    expect(api.deleteAccount).toHaveBeenNthCalledWith(2, reader)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(window.prompt).not.toHaveBeenCalled()
  })
})
