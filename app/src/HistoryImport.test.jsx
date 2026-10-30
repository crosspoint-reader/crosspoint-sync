// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import HistoryImport from './HistoryImport.jsx'
vi.mock('./api.js', () => ({ api: { importHistory: vi.fn() } }))
vi.mock('./ui.jsx', () => ({ Card: ({ children }) => <section>{children}</section>, notify: vi.fn(), STATUS: [{ id: 'finished', label: 'Finished' }, { id: 'reading', label: 'Reading' }, { id: 'paused', label: 'Paused' }, { id: 'dnf', label: 'Did Not Finish' }] }))
import { api } from './api.js'
afterEach(() => { cleanup(); vi.resetAllMocks() })

it('reviews the file, allows correcting inferred finishes, and keeps existing history locked', async () => {
  const file = new File(['sqlite'], 'history.sqlite')
  const session = { username: 'reader' }
  api.importHistory.mockResolvedValueOnce({ books: [
    { document: 'new', title: 'New book', records: 2, start_date: '2025-01-01', finished_date: '2025-02-01', completed: true, existing_history: false, status: null },
    { document: 'old', title: 'Old book', records: 3, start_date: '2025-01-01', finished_date: '2025-03-01', completed: true, existing_history: true, status: null },
  ] }).mockRejectedValueOnce(new Error('Upload failed'))
  render(<HistoryImport session={session} />)
  fireEvent.change(screen.getByLabelText('Reading-history file'), { target: { files: [file] } })
  fireEvent.change(screen.getByLabelText('Reading time zone'), { target: { value: 'America/New_York' } })
  expect(api.importHistory).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Review history' }))
  await screen.findByRole('button', { name: 'Import 2 books' })
  expect(api.importHistory).toHaveBeenCalledWith(session, file, 'America/New_York')
  expect(screen.getByLabelText('Finished: Old book').disabled).toBe(true)
  fireEvent.click(screen.getByLabelText('Finished: New book'))
  fireEvent.click(screen.getByRole('button', { name: 'Import 2 books' }))
  await waitFor(() => expect(api.importHistory).toHaveBeenLastCalledWith(session, file, 'America/New_York', { new: null, old: '2025-03-01' }))
  expect((await screen.findByRole('alert')).textContent).toBe('Upload failed')
  expect(screen.getByRole('button', { name: 'Import 2 books' }).disabled).toBe(false)
})

it('invalidates the preview when the time zone changes', async () => {
  api.importHistory.mockResolvedValue({ books: [] })
  render(<HistoryImport session={{}} />)
  fireEvent.change(screen.getByLabelText('Reading-history file'), { target: { files: [new File(['sqlite'], 'history.db')] } })
  fireEvent.click(screen.getByRole('button', { name: 'Review history' }))
  await screen.findByRole('button', { name: 'Import 0 books' })
  fireEvent.change(screen.getByLabelText('Reading time zone'), { target: { value: 'UTC' } })
  expect(screen.queryByRole('button', { name: 'Import 0 books' })).toBeNull()
})

it('requires a matching choice and preserves a finished book with an unknown date', async () => {
  const file = new File(['Title,Author'], 'export.csv')
  const session = { username: 'reader' }
  api.importHistory.mockResolvedValueOnce({ kind: 'tracker', source: 'Goodreads', skipped: 0, warnings: [],
    library: [{ document: 'reader-book', title: 'Existing book', author: 'Author' }],
    books: [{ source_id: 'goodreads.1', title: 'Existing book', author: 'Author', status: 'finished', start_date: null, finished_date: null,
      target: '', locked: false, candidates: [{ document: 'reader-book', title: 'Existing book', author: 'Author' }] }] })
    .mockRejectedValueOnce(new Error('Test retry'))
  render(<HistoryImport session={session} />)
  fireEvent.change(screen.getByLabelText('Reading-history file'), { target: { files: [file] } })
  fireEvent.click(screen.getByRole('button', { name: 'Review history' }))
  const button = await screen.findByRole('button', { name: 'Import 1 books' })
  expect(button.disabled).toBe(true)
  expect(screen.getByLabelText('Finish date for Existing book (optional)').value).toBe('')
  fireEvent.change(screen.getByLabelText('Import destination for Existing book'), { target: { value: 'reader-book' } })
  expect(button.disabled).toBe(false)
  fireEvent.click(button)
  await screen.findByRole('alert')
  expect(api.importHistory.mock.calls.at(-1)[3]).toEqual({ 'goodreads.1': { target: 'reader-book', status: 'finished', start_date: null, finished_date: null } })
})
