// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'

vi.mock('./api.js', () => ({ isApp: false, api: { cover: vi.fn() } }))
const { api } = await import('./api.js')
const { Cover } = await import('./ui.jsx')

const session = { server: 'https://sync.test' }
const chamber = { document: 'd1', title: 'The Bloody Chamber', cover_url: 'https://covers.test/chamber.jpg' }
const quest = { document: 'd2', title: "Assassin's Quest", cover_url: 'https://covers.test/quest.jpg' }
const src = (c) => c.querySelector('img')?.getAttribute('src') ?? null

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('Cover', () => {
  it('follows a new book in the same slot (offline first paint, then the fresh list)', () => {
    const { container, rerender } = render(<Cover session={session} book={chamber} />)
    expect(src(container)).toBe(chamber.cover_url)
    rerender(<Cover session={session} book={quest} />)
    expect(src(container)).toBe(quest.cover_url)
  })

  it('shows a corrected cover without remounting', () => {
    const { container, rerender } = render(<Cover session={session} book={quest} />)
    rerender(<Cover session={session} book={{ ...quest, cover_url: 'https://covers.test/fixed.jpg' }} />)
    expect(src(container)).toBe('https://covers.test/fixed.jpg')
  })

  it("never shows a looked-up cover on a different book", async () => {
    api.cover.mockResolvedValue({ url: 'https://covers.test/looked.jpg' })
    const { container, rerender } = render(<Cover session={session} book={{ document: 'd3', title: 'No cover' }} />)
    await waitFor(() => expect(src(container)).toBe('https://covers.test/looked.jpg'))
    api.cover.mockReturnValue(new Promise(() => {}))
    rerender(<Cover session={session} book={{ document: 'd4', title: 'Other' }} />)
    expect(src(container)).toBeNull()
  })

  it('a broken image falls back to the title card, but a new url gets a fresh try', () => {
    const { container, rerender } = render(<Cover session={session} book={quest} />)
    fireEvent.error(container.querySelector('img'))
    expect(src(container)).toBeNull()
    expect(container.textContent).toContain("Assassin's Quest")
    rerender(<Cover session={session} book={{ ...quest, cover_url: 'https://covers.test/fixed.jpg' }} />)
    expect(src(container)).toBe('https://covers.test/fixed.jpg')
  })
})
