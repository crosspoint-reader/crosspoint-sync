// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('./api.js', () => ({
  isApp: true,
  api: { bookMatches: vi.fn(), spotifyPosition: vi.fn(), spotifyResume: vi.fn() },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const { api } = await import('./api.js')
const { openUrl } = await import('@tauri-apps/plugin-opener')
const { default: SpotifyCard, clock } = await import('./SpotifyCard.jsx')

const session = { server: 'https://sync.test' }
const POSITION = {
  chapterId: 'c2', chapterUri: 'spotify:episode:c2', chapterName: 'Chapter 2', chapterIndex: 1, chapterCount: 3,
  positionMs: 754_000, percentage: 0.38, finished: false, live: false,
}
let n = 0
// A fresh document per test: useLoad remembers results by document across renders.
const book = () => ({ document: `doc${++n}`, percentage: 0.42 })

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('clock', () => {
  it('formats chapter time', () => {
    expect(clock(754_000)).toBe('12:34')
    expect(clock(3_725_000)).toBe('1:02:05')
  })
})

describe('SpotifyCard', () => {
  it('shows Spotify next to the reader with a resume button when linked and matched', async () => {
    api.bookMatches.mockResolvedValue([{ id: 'spotify', matched: true }])
    api.spotifyPosition.mockResolvedValue({ matched: true, position: POSITION })
    render(<SpotifyCard session={session} book={book()} />)
    expect(await screen.findByRole('button', { name: 'Resume in Spotify at Chapter 2 / 12:34' })).toBeTruthy()
    expect(screen.getByText('42%')).toBeTruthy()
    expect(screen.getByText('38%')).toBeTruthy()
  })

  it('renders nothing when Spotify is not linked, without asking for a position', async () => {
    api.bookMatches.mockResolvedValue([{ id: 'hardcover', matched: true }])
    const { container } = render(<SpotifyCard session={session} book={book()} />)
    await waitFor(() => expect(api.bookMatches).toHaveBeenCalled())
    expect(api.spotifyPosition).not.toHaveBeenCalled()
    expect(container.innerHTML).toBe('')
  })

  it('renders nothing when the book is not matched on Spotify', async () => {
    api.bookMatches.mockResolvedValue([{ id: 'spotify', matched: false }])
    api.spotifyPosition.mockResolvedValue({ matched: false, position: null })
    const { container } = render(<SpotifyCard session={session} book={book()} />)
    await waitFor(() => expect(api.spotifyPosition).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
  })

  it('never plays on its own; the button starts playback', async () => {
    api.bookMatches.mockResolvedValue([{ id: 'spotify' }])
    api.spotifyPosition.mockResolvedValue({ matched: true, position: POSITION })
    api.spotifyResume.mockResolvedValue({ ok: true, position: POSITION })
    const b = book()
    render(<SpotifyCard session={session} book={b} />)
    const button = await screen.findByRole('button')
    expect(api.spotifyResume).not.toHaveBeenCalled()
    fireEvent.click(button)
    await waitFor(() => expect(api.spotifyResume).toHaveBeenCalledWith(session, b.document))
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('opens the chapter deep link when Spotify cannot play (no device or no Premium)', async () => {
    api.bookMatches.mockResolvedValue([{ id: 'spotify' }])
    api.spotifyPosition.mockResolvedValue({ matched: true, position: POSITION })
    api.spotifyResume.mockResolvedValue({ ok: false, reason: 'NO_ACTIVE_DEVICE', fallback_url: 'https://open.spotify.com/chapter/c2' })
    render(<SpotifyCard session={session} book={book()} />)
    fireEvent.click(await screen.findByRole('button'))
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://open.spotify.com/chapter/c2'))
  })

  it('marks a live session', async () => {
    api.bookMatches.mockResolvedValue([{ id: 'spotify' }])
    api.spotifyPosition.mockResolvedValue({ matched: true, position: { ...POSITION, live: true } })
    render(<SpotifyCard session={session} book={book()} />)
    expect(await screen.findByText('Playing now')).toBeTruthy()
  })
})
