// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
vi.hoisted(() => { window.scrollTo = vi.fn(); window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) })
vi.mock('./api.js', () => ({ isApp: false, cached: { clippings: () => null }, api: { allClippings: vi.fn(), connectors: vi.fn(), addMicroblogClipping: vi.fn(), microblogClippingPosts: vi.fn(), recreateMicroblogPost: vi.fn(), microblogDestinations: vi.fn() } }))
vi.mock('./tabbar.js', () => ({ useSheet() {}, useNativeBack() {}, useNativeButton() {} }))
vi.mock('./ui.jsx', async (original) => ({ ...await original(), Cover: () => null }))
import Clippings from './Clippings.jsx'
import { api } from './api.js'

const session = { server: 'https://sync.test', username: 'reader', key: 'secret' }
const books = [{ document: 'book', title: 'Test book', author: 'An author', cover_url: '/cover.jpg' }]
beforeEach(() => {
  vi.resetAllMocks()
  api.allClippings.mockResolvedValue([{ id: 'one', document: 'book', text: 'A passage', created_at: 1 }])
  api.connectors.mockResolvedValue({ connectors: [{ id: 'microblog', linked: true }] })
  api.addMicroblogClipping.mockResolvedValue({ queued: true, waiting_for_match: false })
  api.microblogClippingPosts.mockResolvedValue({ items: [] })
  api.recreateMicroblogPost.mockResolvedValue({ queued: true })
  api.microblogDestinations.mockResolvedValue({ items: [{ uid: 'https://first.micro.blog/', name: 'Previous' }, { uid: 'https://new.micro.blog/', name: 'New' }], selected: 'https://new.micro.blog/' })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('shows the action on both daily and book clippings with configured Micro.blog', async () => {
  render(<Clippings session={session} books={books} />)
  expect(await screen.findAllByRole('button', { name: 'Add clipping to Micro.blog' })).toHaveLength(2)
})
it('hides the action when Micro.blog is unlinked', async () => {
  api.connectors.mockResolvedValue({ connectors: [{ id: 'microblog', linked: false }] })
  render(<Clippings session={session} books={books} />)
  await screen.findAllByText('A passage')
  expect(screen.queryByRole('button', { name: 'Add clipping to Micro.blog' })).toBeNull()
})
it('selects a clipping, prevents repeat requests, and explains waiting for a match', async () => {
  let finish
  api.addMicroblogClipping.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  render(<Clippings session={session} books={books} />)
  const buttons = await screen.findAllByRole('button', { name: 'Add clipping to Micro.blog' })
  fireEvent.click(buttons[0])
  expect(buttons[1].disabled).toBe(true)
  fireEvent.click(buttons[1])
  expect(api.addMicroblogClipping).toHaveBeenCalledTimes(1)
  expect(api.addMicroblogClipping).toHaveBeenCalledWith(session, 'book', 'one')
  finish({ queued: false, waiting_for_match: true })
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/match.*next sync/i))
})
it('shows failures and allows another attempt without claiming publication succeeded', async () => {
  api.addMicroblogClipping.mockRejectedValue(new Error('Micro.blog is unavailable'))
  render(<Clippings session={session} books={books} />)
  fireEvent.click((await screen.findAllByRole('button', { name: 'Add clipping to Micro.blog' }))[0])
  expect((await screen.findByRole('alert')).textContent).toContain('Micro.blog is unavailable')
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getAllByRole('button', { name: 'Add clipping to Micro.blog' })[0].disabled).toBe(false)
})

const deletedPost = { document: 'book', missing: true, destination: 'https://first.micro.blog/', url: 'https://first.micro.blog/deleted.html' }
it('recreates a missing post after its last live local clipping has been deleted', async () => {
  api.allClippings.mockResolvedValue([])
  api.microblogClippingPosts.mockResolvedValueOnce({ items: [deletedPost] }).mockResolvedValue({ items: [] })
  render(<Clippings session={session} books={books} />)
  await screen.findByText('No clippings yet')
  fireEvent.click(await screen.findByRole('button', { name: 'Recreate clippings post' }))
  expect(screen.getByRole('dialog').textContent).toContain('https://first.micro.blog/')
  fireEvent.click(screen.getByRole('button', { name: 'Recreate post' }))
  await waitFor(() => expect(api.recreateMicroblogPost).toHaveBeenCalledWith(session, 'book', 'original'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('status').textContent).toContain('queued')
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Recreate clippings post' })).toBeNull())
})
it('keeps missing-post recovery available when search hides every live clipping group', async () => {
  api.microblogClippingPosts.mockResolvedValue({ items: [deletedPost] })
  render(<Clippings session={session} books={books} />)
  await screen.findByRole('button', { name: 'Recreate clippings post' })
  fireEvent.change(screen.getByRole('textbox', { name: 'Search clippings' }), { target: { value: 'unmatched search' } })
  await screen.findByText('No clippings match')
  expect(screen.getAllByRole('button', { name: 'Recreate clippings post' })).toHaveLength(1)
})
it('offers recreation once per missing book and cancels without sending a request', async () => {
  api.microblogClippingPosts.mockResolvedValue({ items: [deletedPost] })
  render(<Clippings session={session} books={books} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Recreate clippings post' }))
  expect(screen.getByRole('dialog').textContent).toContain('https://first.micro.blog/')
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(api.recreateMicroblogPost).not.toHaveBeenCalled()
})
it('queues explicit recreation and refreshes the book status', async () => {
  api.microblogClippingPosts.mockResolvedValueOnce({ items: [deletedPost] }).mockResolvedValue({ items: [] })
  render(<Clippings session={session} books={books} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Recreate clippings post' }))
  fireEvent.click(screen.getByRole('button', { name: 'Recreate post' }))
  await waitFor(() => expect(api.recreateMicroblogPost).toHaveBeenCalledWith(session, 'book', 'original'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(screen.getByRole('status').textContent).toContain('queued')
})
it('shows recreation errors and allows retry', async () => {
  api.microblogClippingPosts.mockResolvedValue({ items: [deletedPost] })
  api.recreateMicroblogPost.mockRejectedValue(new Error('Original blog is unavailable'))
  render(<Clippings session={session} books={books} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Recreate clippings post' }))
  fireEvent.click(screen.getByRole('button', { name: 'Recreate post' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Original blog is unavailable')
  expect(screen.getByRole('button', { name: 'Recreate post' }).disabled).toBe(false)
})
it('lets the reader choose the current clippings blog when recreating a post', async () => {
  api.microblogClippingPosts.mockResolvedValue({ items: [deletedPost] })
  render(<Clippings session={session} books={books} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Recreate clippings post' }))
  const choice = await screen.findByLabelText(/Current clippings blog/)
  await waitFor(() => expect(choice.disabled).toBe(false))
  expect(screen.getByLabelText(/Previous blog/).checked).toBe(true)
  fireEvent.click(choice)
  fireEvent.click(screen.getByRole('button', { name: 'Recreate post' }))
  await waitFor(() => expect(api.recreateMicroblogPost).toHaveBeenCalledWith(session, 'book', 'current'))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})
it('keeps the previous blog usable when the current clippings blog is unavailable', async () => {
  api.microblogClippingPosts.mockResolvedValue({ items: [deletedPost] })
  api.microblogDestinations.mockResolvedValue({ items: [], selected: 'https://unavailable.micro.blog/' })
  render(<Clippings session={session} books={books} />)
  fireEvent.click(await screen.findByRole('button', { name: 'Recreate clippings post' }))
  await screen.findByText(/Choose an available blog in Settings/)
  expect(screen.getByLabelText(/Current clippings blog/).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Recreate post' }))
  await waitFor(() => expect(api.recreateMicroblogPost).toHaveBeenCalledWith(session, 'book', 'original'))
})

const first = { document: 'one', title: 'First' }
const discovered = { document: 'two', title: 'Newly discovered' }
const clip = { document: 'two', id: 'new', text: 'New book passage', created_at: 100 }

it('reloads all-book clippings when the refreshed library discovers another book', async () => {
  api.connectors.mockResolvedValue({ connectors: [] })
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
  api.connectors.mockResolvedValue({ connectors: [] })
  api.allClippings.mockReturnValueOnce(new Promise((r) => { finish = r })).mockResolvedValueOnce([clip])
  const view = render(<Clippings session={session} books={[first]} />)
  await waitFor(() => expect(api.allClippings).toHaveBeenCalledOnce())
  view.rerender(<Clippings session={session} books={[first, discovered]} />)
  await screen.findAllByText('New book passage')
  await act(async () => { finish([{ document: 'one', id: 'old', text: 'Old snapshot', created_at: 50 }]) })
  expect(screen.queryByText('Old snapshot')).toBeNull()
  expect(screen.getAllByText('New book passage').length).toBeGreaterThan(0)
})
