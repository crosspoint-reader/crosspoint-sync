// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
vi.hoisted(() => { window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })) })
vi.mock('./api.js', () => ({ isApp: false, cached: { clippings: () => null }, api: { allClippings: vi.fn(), connectors: vi.fn(), addMicroblogHighlight: vi.fn() } }))
vi.mock('./tabbar.js', () => ({ useSheet() {}, useNativeBack() {}, useNativeButton() {} }))
import Clippings from './Clippings.jsx'
import { api } from './api.js'

const session = { username: 'reader' }
const books = [{ document: 'book', title: 'Test book', author: 'An author', cover_url: '/cover.jpg' }]
beforeEach(() => {
  api.allClippings.mockResolvedValue([{ id: 'one', document: 'book', text: 'A passage', created_at: 1 }])
  api.connectors.mockResolvedValue({ connectors: [{ id: 'microblog', linked: true }] })
  api.addMicroblogHighlight.mockResolvedValue({ queued: true, waiting_for_match: false })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })

it('shows the action on both daily and book clippings with configured Micro.blog', async () => {
  render(<Clippings session={session} books={books} />)
  expect(await screen.findAllByRole('button', { name: 'Add highlight to Micro.blog' })).toHaveLength(2)
})
it('hides the action when Micro.blog is unlinked', async () => {
  api.connectors.mockResolvedValue({ connectors: [{ id: 'microblog', linked: false }] })
  render(<Clippings session={session} books={books} />)
  await screen.findAllByText('A passage')
  expect(screen.queryByRole('button', { name: 'Add highlight to Micro.blog' })).toBeNull()
})
it('selects a clipping, prevents repeat requests, and explains waiting for a match', async () => {
  let finish
  api.addMicroblogHighlight.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  render(<Clippings session={session} books={books} />)
  const buttons = await screen.findAllByRole('button', { name: 'Add highlight to Micro.blog' })
  fireEvent.click(buttons[0])
  expect(buttons[1].disabled).toBe(true)
  fireEvent.click(buttons[1])
  expect(api.addMicroblogHighlight).toHaveBeenCalledTimes(1)
  expect(api.addMicroblogHighlight).toHaveBeenCalledWith(session, 'book', 'one')
  finish({ queued: false, waiting_for_match: true })
  await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/match.*next sync/i))
})
it('shows failures and allows another attempt without claiming publication succeeded', async () => {
  api.addMicroblogHighlight.mockRejectedValue(new Error('Micro.blog is unavailable'))
  render(<Clippings session={session} books={books} />)
  fireEvent.click((await screen.findAllByRole('button', { name: 'Add highlight to Micro.blog' }))[0])
  expect((await screen.findByRole('alert')).textContent).toContain('Micro.blog is unavailable')
  expect(screen.queryByRole('status')).toBeNull()
  expect(screen.getAllByRole('button', { name: 'Add highlight to Micro.blog' })[0].disabled).toBe(false)
})
