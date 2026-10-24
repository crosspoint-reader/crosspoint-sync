// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.hoisted(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})
vi.mock('./api.js', () => ({ isApp: true, api: {} }))
vi.mock('./tabbar.js', () => ({ useSheet() {} }))
vi.mock('./catalogs.js', () => ({ downloads: vi.fn(async () => []), removeDownload: vi.fn(), sendDownload: vi.fn(), sendFile: vi.fn() }))
vi.mock('./device.js', async (original) => ({
  ...await original(),
  connect: vi.fn(), folders: vi.fn(), listFiles: vi.fn(), deleteFiles: vi.fn(), renameFile: vi.fn(), makeFolder: vi.fn(),
  loadDevicePrefs: () => ({ host: 'reader.local', folder: '/', optimize: false, quality: 85 }),
}))
import Send from './Send.jsx'
import { connect, folders, listFiles, deleteFiles, renameFile, makeFolder } from './device.js'

beforeEach(() => {
  vi.resetAllMocks()
  connect.mockResolvedValue({ base: 'http://192.0.2.1', status: { device: 'X3', version: 'test' } })
  folders.mockResolvedValue([])
  listFiles.mockResolvedValue([{ name: 'book.epub', isDirectory: false, size: 1024 }])
  deleteFiles.mockResolvedValue(undefined)
  renameFile.mockResolvedValue(undefined)
  makeFolder.mockResolvedValue(undefined)
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('confirms deletion in the app even when WebView confirm returns false, then refreshes the list', async () => {
  const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  render(<Send />)
  fireEvent.click(await screen.findByRole('button', { name: 'Delete book.epub' }))
  const dialog = screen.getByRole('dialog', { name: 'Delete book.epub?' })
  expect(deleteFiles).not.toHaveBeenCalled()
  listFiles.mockResolvedValue([])
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete', exact: true }))
  await screen.findByText('This folder is empty')
  expect(deleteFiles).toHaveBeenCalledExactlyOnceWith('http://192.0.2.1', ['/book.epub'])
  expect(nativeConfirm).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('renames a nested Unicode path in the app when native prompt returns null', async () => {
  const nativePrompt = vi.spyOn(window, 'prompt').mockReturnValue(null)
  listFiles.mockImplementation(async (_, path) => path === '/'
    ? [{ name: 'Books', isDirectory: true }]
    : [{ name: 'Été & notes.epub', isDirectory: false, size: 1024 }])
  render(<Send />)
  fireEvent.click(await screen.findByRole('button', { name: 'Books', exact: true }))
  fireEvent.click(await screen.findByRole('button', { name: 'Rename Été & notes.epub' }))
  const dialog = screen.getByRole('dialog', { name: 'Rename Été & notes.epub' })
  const input = within(dialog).getByRole('textbox', { name: 'New name' })
  expect(input.value).toBe('Été & notes.epub')
  expect(renameFile).not.toHaveBeenCalled()
  fireEvent.change(input, { target: { value: '  여름 & notes.epub  ' } })
  listFiles.mockResolvedValue([{ name: '여름 & notes.epub', isDirectory: false, size: 1024 }])
  fireEvent.submit(input.closest('form'))
  await screen.findByRole('button', { name: 'Rename 여름 & notes.epub' })
  expect(renameFile).toHaveBeenCalledExactlyOnceWith('http://192.0.2.1', '/Books/Été & notes.epub', '여름 & notes.epub')
  expect(nativePrompt).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('does not rename on cancellation, closing, or an empty or unchanged name', async () => {
  render(<Send />)
  for (const action of ['Cancel', 'Close']) {
    fireEvent.click(await screen.findByRole('button', { name: 'Rename book.epub' }))
    const dialog = screen.getByRole('dialog')
    const input = within(dialog).getByRole('textbox', { name: 'New name' })
    const submit = within(dialog).getByRole('button', { name: 'Rename', exact: true })
    for (const value of ['book.epub', ' book.epub ', '   ']) {
      fireEvent.change(input, { target: { value } })
      expect(submit.disabled).toBe(true)
      fireEvent.submit(input.closest('form'))
    }
    fireEvent.change(input, { target: { value: 'changed.epub' } })
    fireEvent.click(within(dialog).getByRole('button', { name: action }))
    expect(screen.queryByRole('dialog')).toBeNull()
  }
  expect(renameFile).not.toHaveBeenCalled()
})

it('blocks duplicate renames and dismissal while a rename is pending', async () => {
  let finish
  renameFile.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  render(<Send />)
  fireEvent.click(await screen.findByRole('button', { name: 'Rename book.epub' }))
  const dialog = screen.getByRole('dialog')
  const input = within(dialog).getByRole('textbox', { name: 'New name' })
  fireEvent.change(input, { target: { value: 'renamed.epub' } })
  const submit = within(dialog).getByRole('button', { name: 'Rename', exact: true })
  fireEvent.click(submit)
  fireEvent.click(submit)
  fireEvent.submit(input.closest('form'))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(renameFile).toHaveBeenCalledExactlyOnceWith('http://192.0.2.1', '/book.epub', 'renamed.epub')
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(input.disabled).toBe(true)
  expect(submit.disabled).toBe(true)
  expect(within(dialog).getByRole('button', { name: 'Cancel' }).disabled).toBe(true)
  expect(screen.getByRole('button', { name: 'Rename book.epub' }).disabled).toBe(true)
  expect(screen.getByRole('button', { name: 'Delete book.epub' }).disabled).toBe(true)
  finish()
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('retains the new name on failure and refreshes folders after a successful retry', async () => {
  folders.mockResolvedValueOnce(['Books'])
  listFiles.mockResolvedValue([{ name: 'Books', isDirectory: true }])
  renameFile.mockRejectedValueOnce(new Error('Destination already exists'))
  render(<Send />)
  fireEvent.click(await screen.findByRole('button', { name: 'Rename Books' }))
  const dialog = screen.getByRole('dialog')
  const input = within(dialog).getByRole('textbox', { name: 'New name' })
  fireEvent.change(input, { target: { value: 'Reading' } })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rename', exact: true }))
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Destination already exists')
  expect(input.value).toBe('Reading')
  expect(listFiles).toHaveBeenCalledTimes(1)
  expect(folders).toHaveBeenCalledTimes(1)
  listFiles.mockResolvedValue([{ name: 'Reading', isDirectory: true }])
  folders.mockResolvedValue(['Reading'])
  fireEvent.click(within(dialog).getByRole('button', { name: 'Rename', exact: true }))
  await screen.findByRole('button', { name: 'Rename Reading' })
  expect(renameFile).toHaveBeenCalledTimes(2)
  expect(renameFile).toHaveBeenNthCalledWith(2, 'http://192.0.2.1', '/Books', 'Reading')
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.queryByRole('option', { name: '/Books' })).toBeNull()
  expect(screen.getByRole('option', { name: '/Reading' })).toBeTruthy()
})

it('does not delete when confirmation is cancelled or closed', async () => {
  render(<Send />)
  for (const action of ['Cancel', 'Close']) {
    fireEvent.click(await screen.findByRole('button', { name: 'Delete book.epub' }))
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: action }))
    expect(screen.queryByRole('dialog')).toBeNull()
  }
  expect(deleteFiles).not.toHaveBeenCalled()
})

it('deletes the selected nested path and prevents repeated requests while pending', async () => {
  listFiles.mockImplementation(async (_, path) => path === '/'
    ? [{ name: 'Books', isDirectory: true }]
    : [{ name: 'Été & notes.epub', isDirectory: false, size: 1024 }])
  let finish
  deleteFiles.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  render(<Send />)
  fireEvent.click(await screen.findByRole('button', { name: 'Books', exact: true }))
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Été & notes.epub' }))
  const dialog = screen.getByRole('dialog')
  const confirmDelete = within(dialog).getByRole('button', { name: 'Delete', exact: true })
  expect(deleteFiles).not.toHaveBeenCalled()
  fireEvent.click(confirmDelete)
  fireEvent.click(confirmDelete)
  fireEvent.click(screen.getByRole('button', { name: 'Delete Été & notes.epub' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(deleteFiles).toHaveBeenCalledExactlyOnceWith('http://192.0.2.1', ['/Books/Été & notes.epub'])
  expect(screen.getByRole('button', { name: 'Deleting…' }).disabled).toBe(true)
  expect(screen.getByRole('button', { name: 'Cancel' }).disabled).toBe(true)
  listFiles.mockResolvedValue([])
  finish()
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
})

it('keeps a failed deletion visible with the server error and allows retry', async () => {
  folders.mockResolvedValueOnce(['Books'])
  listFiles.mockResolvedValue([{ name: 'Books', isDirectory: true }])
  deleteFiles.mockRejectedValueOnce(new Error('Books (folder not empty)'))
  render(<Send />)
  fireEvent.click(await screen.findByRole('button', { name: 'Delete Books' }))
  const dialog = screen.getByRole('dialog')
  expect(screen.getByRole('option', { name: '/Books' })).toBeTruthy()
  expect(within(dialog).getByText(/folder must be empty/)).toBeTruthy()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete', exact: true }))
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Books (folder not empty)')
  expect(listFiles).toHaveBeenCalledTimes(1)
  expect(folders).toHaveBeenCalledTimes(1)
  listFiles.mockResolvedValue([])
  fireEvent.click(within(dialog).getByRole('button', { name: 'Delete', exact: true }))
  await screen.findByText('This folder is empty')
  expect(deleteFiles).toHaveBeenCalledTimes(2)
  expect(deleteFiles).toHaveBeenNthCalledWith(1, 'http://192.0.2.1', ['/Books'])
  expect(deleteFiles).toHaveBeenNthCalledWith(2, 'http://192.0.2.1', ['/Books'])
  expect(folders).toHaveBeenCalledTimes(2)
  expect(screen.queryByRole('option', { name: '/Books' })).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('creates a Unicode folder in the selected directory and refreshes files and folders', async () => {
  const nativePrompt = vi.spyOn(window, 'prompt').mockReturnValue(null)
  listFiles.mockImplementation(async (_, path) => path === '/' ? [{ name: 'Books', isDirectory: true }] : [])
  makeFolder.mockRejectedValueOnce(new Error('Create failed'))
  render(<Send />)
  fireEvent.click(await screen.findByRole('button', { name: 'Books', exact: true }))
  await screen.findByText('This folder is empty')
  fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
  const dialog = screen.getByRole('dialog', { name: 'New folder' })
  const input = within(dialog).getByRole('textbox', { name: 'Folder name' })
  const submit = within(dialog).getByRole('button', { name: 'Create folder' })
  expect(submit.disabled).toBe(true)
  fireEvent.change(input, { target: { value: '  여름 & notes  ' } })
  expect(makeFolder).not.toHaveBeenCalled()
  fireEvent.click(submit)
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Create failed')
  expect(input.value).toBe('  여름 & notes  ')
  expect(folders).toHaveBeenCalledTimes(1)
  listFiles.mockResolvedValue([{ name: '여름 & notes', isDirectory: true }])
  folders.mockResolvedValue(['Books', 'New top-level folder'])
  fireEvent.click(submit)
  await screen.findByRole('button', { name: '여름 & notes', exact: true })
  expect(makeFolder).toHaveBeenNthCalledWith(1, 'http://192.0.2.1', '/Books', '여름 & notes')
  expect(makeFolder).toHaveBeenNthCalledWith(2, 'http://192.0.2.1', '/Books', '여름 & notes')
  expect(folders).toHaveBeenCalledTimes(2)
  expect(screen.getByRole('option', { name: '/New top-level folder' })).toBeTruthy()
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(nativePrompt).not.toHaveBeenCalled()
})

it('does not create a folder for blank input or when cancelled or closed', async () => {
  render(<Send />)
  await screen.findByRole('button', { name: 'New folder' })
  for (const dismiss of ['Cancel', 'Close']) {
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    const dialog = screen.getByRole('dialog')
    const input = within(dialog).getByRole('textbox')
    fireEvent.change(input, { target: { value: '  ' } })
    fireEvent.submit(input.closest('form'))
    fireEvent.change(input, { target: { value: 'Uncreated folder' } })
    fireEvent.click(within(dialog).getByRole('button', { name: dismiss }))
    expect(screen.queryByRole('dialog')).toBeNull()
  }
  expect(makeFolder).not.toHaveBeenCalled()
})

it.each(['Delete first.epub', 'Rename first.epub', 'New folder'])('locks reader controls while %s is open', async (action) => {
  listFiles.mockResolvedValue([
    { name: 'first.epub', isDirectory: false, size: 1024 },
    { name: 'second.epub', isDirectory: false, size: 1024 },
    { name: 'Books', isDirectory: true },
  ])
  render(<Send />)
  const firstDelete = await screen.findByRole('button', { name: 'Delete first.epub' })
  const trigger = screen.getByRole('button', { name: action })
  trigger.focus()
  fireEvent.click(trigger)
  const dialog = screen.getByRole('dialog')
  expect(dialog.contains(document.activeElement)).toBe(true)
  const originalTitle = dialog.getAttribute('aria-label')
  for (const name of ['Delete first.epub', 'Delete second.epub', 'Rename second.epub', 'New folder', 'SD card', 'Books']) {
    const button = screen.getByRole('button', { name, exact: true })
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
  }
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(dialog.getAttribute('aria-label')).toBe(originalTitle)
  expect(deleteFiles).not.toHaveBeenCalled()
  expect(renameFile).not.toHaveBeenCalled()
  expect(makeFolder).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(firstDelete.disabled).toBe(false)
  expect(document.activeElement).toBe(trigger)

  if (action === 'Delete first.epub') {
    fireEvent.click(firstDelete)
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete', exact: true }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deleteFiles).toHaveBeenCalledExactlyOnceWith('http://192.0.2.1', ['/first.epub'])
  }
})
