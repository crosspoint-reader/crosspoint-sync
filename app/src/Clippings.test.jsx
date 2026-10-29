// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'

vi.mock('./api.js', () => ({ api: { allClippings: vi.fn() }, cached: { clippings: () => null }, isApp: false }))
vi.mock('./shareCard.js', () => ({ saveFile: vi.fn() }))
vi.mock('./Book.jsx', () => ({ ClipMenu: () => null, ClipShare: () => null, DeleteClip: () => null, hold: () => ({}) }))
vi.mock('./tabbar.js', () => ({ useSheet: vi.fn() }))
vi.mock('./ui.jsx', async (original) => ({ ...await original(), Cover: () => null }))
const { api } = await import('./api.js')
const { default: Clippings } = await import('./Clippings.jsx')
const session = { server: 'https://sync.test', username: 'reader', key: 'secret' }
const first = { document: 'one', title: 'First' }
const discovered = { document: 'two', title: 'Newly discovered' }
const clip = { document: 'two', id: 'new', text: 'New book passage', created_at: 100 }
beforeEach(() => { api.allClippings.mockReset() })
afterEach(cleanup)

it('reloads all-book clippings when the refreshed library discovers another book', async () => {
  api.allClippings.mockResolvedValueOnce([]).mockResolvedValueOnce([clip])
  const view = render(<Clippings session={session} books={[first]} />)
  await screen.findByText('No clippings yet')
  view.rerender(<Clippings session={session} books={[first, discovered]} />)
  await screen.findAllByText('New book passage')
  expect(api.allClippings).toHaveBeenCalledTimes(2)
  expect(api.allClippings).toHaveBeenLastCalledWith(session, [first, discovered])
})

it('keeps the refreshed book-list results if the earlier clipping request finishes last', async () => {
  let finish
  api.allClippings.mockReturnValueOnce(new Promise((r) => { finish = r })).mockResolvedValueOnce([clip])
  const view = render(<Clippings session={session} books={[first]} />)
  await waitFor(() => expect(api.allClippings).toHaveBeenCalledOnce())
  view.rerender(<Clippings session={session} books={[first, discovered]} />)
  await screen.findAllByText('New book passage')
  await act(async () => { finish([{ document: 'one', id: 'old', text: 'Old snapshot', created_at: 50 }]) })
  expect(screen.queryByText('Old snapshot')).toBeNull()
  expect(screen.getAllByText('New book passage').length).toBeGreaterThan(0)
})
