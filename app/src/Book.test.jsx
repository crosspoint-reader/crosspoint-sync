// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.hoisted(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
vi.mock('./api.js', () => ({ isApp: false, api: { setStatus: vi.fn(), merge: vi.fn(), unmerge: vi.fn(), removeBook: vi.fn(), syncBook: vi.fn() } }))
const loads = vi.hoisted(() => ({}))
vi.mock('./ui.jsx', async (original) => ({ ...await original(), useLoad: (fn, deps, memo) => [loads[memo] ?? null] }))
vi.mock('./tabbar.js', () => ({ useSheet() {}, useNativeBack() {}, useNativeButton() {} }))
vi.mock('./SpotifyCard.jsx', () => ({ default: () => null }))
import Book from './Book.jsx'
import { api } from './api.js'

const book = { document: 'book', title: 'Middlemarch', status: 'reading', percentage: 0.62, cover_url: '/cover.jpg' }
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks() })

it('syncs just this book, disables repeat clicks and refreshes its details', async () => {
  loads['matches book'] = [{ id: 'bookorbit', name: 'BookOrbit', matched: true, sync: { read: true, write: true, enabled: true } }]
  let finish
  api.syncBook.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  const onChange = vi.fn()
  render(<Book session={{}} book={book} books={[book]} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
  expect(screen.getByRole('button', { name: 'Syncing…' }).disabled).toBe(true)
  expect(api.syncBook).toHaveBeenCalledWith({}, 'bookorbit', 'book')
  finish({ queued: 1 })
  await waitFor(() => expect(onChange).toHaveBeenCalledOnce())
  expect(screen.getByRole('status').textContent).toContain('Outgoing updates queued')
  delete loads['matches book']
})

it('shows a failed sync and allows retry without reporting success', async () => {
  loads['matches book'] = [{ id: 'bookorbit', name: 'BookOrbit', matched: true, sync: { read: true, write: true, enabled: true } }]
  api.syncBook.mockRejectedValue(new Error('BookOrbit unavailable'))
  const onChange = vi.fn()
  render(<Book session={{}} book={book} books={[book]} onChange={onChange} />)
  fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
  expect((await screen.findByRole('alert')).textContent).toBe('BookOrbit unavailable')
  expect(screen.getByRole('button', { name: 'Sync now' }).disabled).toBe(false)
  expect(onChange).not.toHaveBeenCalled()
  delete loads['matches book']
})

it('saves the chosen status and refreshes the book', async () => {
  const onChange = vi.fn()
  api.setStatus.mockResolvedValue({})
  render(<Book session={{}} book={book} books={[book]} onChange={onChange} />)
  fireEvent.change(screen.getByLabelText('Reading status'), { target: { value: 'finished' } })
  await waitFor(() => expect(onChange).toHaveBeenCalledOnce())
  expect(api.setStatus).toHaveBeenCalledWith({}, 'book', 'finished')
})

it('keeps the saved status and allows retry after a failed update', async () => {
  const onChange = vi.fn()
  api.setStatus.mockRejectedValue(new Error('Connection lost'))
  render(<Book session={{}} book={book} books={[book]} onChange={onChange} />)
  const select = screen.getByLabelText('Reading status')
  fireEvent.change(select, { target: { value: 'paused' } })
  expect((await screen.findByRole('alert')).textContent).toBe('Connection lost')
  expect(select.value).toBe('reading')
  expect(select.disabled).toBe(false)
  expect(onChange).not.toHaveBeenCalled()
  api.setStatus.mockResolvedValue({})
  fireEvent.change(select, { target: { value: 'paused' } })
  await waitFor(() => expect(onChange).toHaveBeenCalledOnce())
  expect(screen.queryByRole('alert')).toBeNull()
})

it('offers hidden untitled syncs as merge candidates with device, progress and last sync', async () => {
  loads['untitled books'] = [{ document: 'koreader-hash', device: 'Kobo', percentage: 0.41, timestamp: Date.now() / 1000 - 7200 }]
  const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  api.merge.mockResolvedValue({})
  render(<Book session={{}} book={book} books={[book]} onChange={vi.fn()} />)
  fireEvent.click(screen.getByLabelText('More'))
  fireEvent.click(screen.getByRole('menuitem', { name: /Merge a duplicate/ }))
  expect(screen.getByText('41% · Kobo · synced 2h ago')).toBeTruthy()
  fireEvent.click(screen.getByText('Untitled book'))
  expect(api.merge).not.toHaveBeenCalled()
  fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Merge', exact: true }))
  await waitFor(() => expect(api.merge).toHaveBeenCalledWith({}, 'koreader-hash', 'book', true))
  expect(nativeConfirm).not.toHaveBeenCalled()
  delete loads['untitled books']
})

it.each([
  ['kindle', 'Kindle', true, false, 'Updated from Kindle.'],
  ['hardcover', 'Hardcover', false, true, 'Outgoing updates queued.'],
  ['kosync', 'KOSync', false, true, 'Outgoing updates queued.'],
])('syncs %s with direction-specific feedback', async (id, name, read, write, message) => {
  loads['matches book'] = [{ id, name, matched: true, match_by: id === 'kosync' ? 'document' : 'metadata',
    sync: { read, write, enabled: true } }]
  api.syncBook.mockResolvedValue({ applied: read ? 1 : 0, queued: write ? 1 : 0 })
  render(<Book session={{}} book={book} books={[book]} onChange={vi.fn()} />)
  fireEvent.click(screen.getByRole('button', { name: 'Sync now' }))
  expect((await screen.findByRole('status')).textContent).toBe(message)
  expect(api.syncBook).toHaveBeenCalledWith({}, id, 'book')
  if (id === 'kosync') expect(screen.queryByRole('button', { name: 'Change' })).toBeNull()
  delete loads['matches book']
})

const other = { ...book, document: 'other', title: 'Other copy' }
const openBookAction = (action) => {
  fireEvent.click(screen.getByRole('button', { name: 'More' }))
  fireEvent.click(screen.getByRole('menuitem', { name: action }))
}

it.each(['Cancel', 'Close'])('cancels book actions with %s without requests', (dismiss) => {
  render(<Book session={{}} book={{ ...book, aliases: ['alias'] }} books={[book, other]} onChange={vi.fn()} />)
  for (const action of ['Remove from library', 'Separate merged copy', 'Merge a duplicate']) {
    openBookAction(action)
    if (action === 'Merge a duplicate') fireEvent.click(screen.getByText('Other copy'))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: dismiss }))
    if (action === 'Merge a duplicate') {
      expect(screen.getByRole('dialog', { name: 'Merge a duplicate into this book' })).toBeTruthy()
      fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    }
    expect(screen.queryByRole('dialog')).toBeNull()
  }
  expect(api.merge).not.toHaveBeenCalled()
  expect(api.unmerge).not.toHaveBeenCalled()
  expect(api.removeBook).not.toHaveBeenCalled()
})

it('preserves the selected merge and stats choice across a failure and retry', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false)
  api.merge.mockRejectedValueOnce(new Error('Merge failed')).mockResolvedValue({})
  const onChange = vi.fn()
  render(<Book session={{}} book={book} books={[book, other]} onChange={onChange} />)
  openBookAction('Merge a duplicate')
  fireEvent.click(screen.getByRole('checkbox', { name: /Combine reading stats/ }))
  fireEvent.click(screen.getByText('Other copy'))
  const dialog = screen.getByRole('dialog')
  expect(dialog.textContent).toContain('Its progress and clippings move here')
  fireEvent.click(within(dialog).getByRole('button', { name: 'Merge', exact: true }))
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Merge failed')
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Merge', exact: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(api.merge).toHaveBeenNthCalledWith(1, {}, 'other', 'book', false)
  expect(api.merge).toHaveBeenNthCalledWith(2, {}, 'other', 'book', false)
  expect(onChange).toHaveBeenCalledOnce()
})

it('shows removal failures and refreshes only after confirmed removal succeeds', async () => {
  const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  api.removeBook.mockRejectedValueOnce(new Error('Remove failed')).mockResolvedValue({})
  const onChange = vi.fn()
  render(<Book session={{}} book={book} books={[book]} onChange={onChange} />)
  openBookAction('Remove from library')
  const dialog = screen.getByRole('dialog')
  expect(api.removeBook).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove', exact: true }))
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Remove failed')
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Remove', exact: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(api.removeBook).toHaveBeenNthCalledWith(2, {}, 'book')
  expect(onChange).toHaveBeenCalledOnce()
  expect(location.hash).toBe('#/')
  expect(nativeConfirm).not.toHaveBeenCalled()
})

it('retries only unfinished separations after a partial failure', async () => {
  const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  api.unmerge.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Second copy failed')).mockResolvedValue({})
  const onChange = vi.fn()
  render(<Book session={{}} book={{ ...book, aliases: ['first', 'second'] }} books={[book]} onChange={onChange} />)
  openBookAction('Separate 2 merged copies')
  const dialog = screen.getByRole('dialog')
  expect(api.unmerge).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Separate', exact: true }))
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Second copy failed')
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Separate', exact: true }))
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  expect(api.unmerge.mock.calls).toEqual([[{}, 'first'], [{}, 'second'], [{}, 'second']])
  expect(onChange).toHaveBeenCalledOnce()
  expect(nativeConfirm).not.toHaveBeenCalled()
})
