// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

vi.mock('./api.js', () => ({
  isApp: true,
  api: { bookMatches: vi.fn(), spotifyPosition: vi.fn(), spotifyResume: vi.fn(), spotifyTracks: vi.fn(), setSpotifyAnchor: vi.fn(), clearSpotifyAnchor: vi.fn() },
}))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl: vi.fn() }))

const { api } = await import('./api.js')
const { openUrl } = await import('@tauri-apps/plugin-opener')
const { default: SpotifyCard, clock, parseClock } = await import('./SpotifyCard.jsx')

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

  it('opens the track in the Spotify app when Spotify cannot play (no device or no Premium)', async () => {
    api.bookMatches.mockResolvedValue([{ id: 'spotify' }])
    api.spotifyPosition.mockResolvedValue({ matched: true, position: POSITION })
    api.spotifyResume.mockResolvedValue({
      ok: false, reason: 'NO_ACTIVE_DEVICE', fallback_url: 'https://open.spotify.com/episode/c2', app_url: 'spotify:episode:c2',
    })
    render(<SpotifyCard session={session} book={book()} />)
    fireEvent.click(await screen.findByRole('button'))
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('spotify:episode:c2'))
  })

  it('falls back to the web page when the Spotify app link fails', async () => {
    api.bookMatches.mockResolvedValue([{ id: 'spotify' }])
    api.spotifyPosition.mockResolvedValue({ matched: true, position: POSITION })
    api.spotifyResume.mockResolvedValue({
      ok: false, reason: 'NO_ACTIVE_DEVICE', fallback_url: 'https://open.spotify.com/episode/c2', app_url: 'spotify:episode:c2',
    })
    openUrl.mockRejectedValueOnce(new Error('no handler'))
    render(<SpotifyCard session={session} book={book()} />)
    fireEvent.click(await screen.findByRole('button'))
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://open.spotify.com/episode/c2'))
  })

  it('marks a live session', async () => {
    api.bookMatches.mockResolvedValue([{ id: 'spotify' }])
    api.spotifyPosition.mockResolvedValue({ matched: true, position: { ...POSITION, live: true } })
    render(<SpotifyCard session={session} book={book()} />)
    expect(await screen.findByText('Playing now')).toBeTruthy()
  })
})

describe('calibration', () => {
  it('parses a time in the track', () => {
    expect(parseClock('')).toBe(0)
    expect(parseClock('3:01')).toBe(181_000)
    expect(parseClock('1:02:03')).toBe(3_723_000)
    expect(parseClock('soon')).toBeNull()
  })

  it('lines Spotify up with the reader: pick the track and time, save', async () => {
    api.bookMatches.mockResolvedValue([{ id: 'spotify' }])
    api.spotifyPosition.mockResolvedValue({ matched: true, position: POSITION, target: POSITION, reader_pct: 0.4, anchor: null })
    api.spotifyTracks.mockResolvedValue({
      total_ms: 3000,
      tracks: [
        { index: 0, name: 'Chapter 1', start_ms: 0, duration_ms: 1000 },
        { index: 1, name: 'Chapter 2', start_ms: 1000, duration_ms: 1000 },
        { index: 2, name: 'Chapter 3', start_ms: 2000, duration_ms: 1000 },
      ],
    })
    api.setSpotifyAnchor.mockResolvedValue({ anchor: { text: 0.4, audio: 0.7 } })
    const b = book()
    render(<SpotifyCard session={session} book={b} />)
    fireEvent.click(await screen.findByText('Not the right spot?'))
    const select = await screen.findByLabelText('Spotify track')
    expect(select.value).toBe('1') // starts on the current guess
    fireEvent.change(select, { target: { value: '2' } })
    fireEvent.change(screen.getByLabelText('Time in track'), { target: { value: '0:00' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(api.setSpotifyAnchor).toHaveBeenCalledWith(session, b.document, 2, 0))
  })
})
