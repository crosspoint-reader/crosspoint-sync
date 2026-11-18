// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { image, moveCatalog, needsAuthedImage, sendDownload, sendFile, storedCover } from './catalogs.js'
import { invoke } from '@tauri-apps/api/core'
import { connect } from './device.js'
import { optimizeEpub } from './epub/optimize.js'
import { repairEpub } from './epub/repair.js'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }))
vi.mock('./device.js', () => ({ connect: vi.fn() }))
vi.mock('./epub/optimize.js', () => ({ optimizeEpub: vi.fn() }))
vi.mock('./epub/repair.js', () => ({ repairEpub: vi.fn() }))
vi.mock('./api.js', () => ({ ipcBytes: async (file) => new Uint8Array(await readBytes(file)) }))

function readBytes(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

let attempt = 0
let prefs
beforeEach(() => {
  vi.clearAllMocks()
  prefs = { host: `reader-${attempt++}.local`, folder: '/Books', optimize: true, quality: 85, renameFromMetadata: true }
  connect.mockResolvedValue({ base: 'http://192.0.2.1', status: { device: 'X3' } })
  invoke.mockResolvedValue('Title - Author.epub')
  optimizeEpub.mockImplementation(async (file, options) => {
    options.onProgress({ stage: 'optimizing', done: 50, total: 100 })
    return new File(['optimized'], file.name)
  })
})

it('moves a catalog to where another one is', () => {
  const list = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
  const ids = (l) => l.map((c) => c.id).join('')
  expect(ids(moveCatalog(list, 'a', 'c'))).toBe('bcad') // down
  expect(ids(moveCatalog(list, 'd', 'b'))).toBe('adbc') // up
  expect(ids(list)).toBe('abcd') // untouched
})

it('optimizes a picked EPUB using the detected screen, then uploads only the result', async () => {
  const file = new File(['original'], 'Book.EPUB')
  const progress = vi.fn()
  expect(await sendFile(file, prefs, progress)).toBe('Title - Author.epub')
  expect(optimizeEpub).toHaveBeenCalledWith(file, { device: 'X3', quality: 85, onProgress: progress })
  const [command, bytes, options] = invoke.mock.calls[0]
  expect(command).toBe('send_bytes')
  expect(new TextDecoder().decode(bytes)).toBe('optimized')
  expect(options).toEqual({
    headers: { 'x-name': 'Book.EPUB', 'x-base': 'http%3A%2F%2F192.0.2.1', 'x-folder': '%2FBooks', 'x-rename': '1' },
  })
  expect(progress.mock.calls.map(([p]) => p.stage)).toEqual(['optimizing', 'uploading'])
})

it.each([{ bytes: new Uint8Array([1, 2, 3]).buffer }, { bytes: [1, 2, 3] }])('reads downloads through IPC and uses the same optimizer without changing the saved original (%j)', async ({ bytes }) => {
  invoke.mockImplementation(async (command) => command === 'read_download' ? bytes : 'book.epub')
  await sendDownload('book.epub', prefs)
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(['read_download', 'send_bytes'])
  const [file, options] = optimizeEpub.mock.calls[0]
  expect(file.name).toBe('book.epub')
  expect([...new Uint8Array(await readBytes(file))]).toEqual([1, 2, 3])
  expect(options.device).toBe('X3')
})

it('keeps disabled optimization and non-EPUB downloads on the native send path', async () => {
  await sendDownload('book.epub', { ...prefs, optimize: false })
  await sendDownload('notes.md', prefs)
  expect(optimizeEpub).not.toHaveBeenCalled()
  expect(invoke.mock.calls.map(([command]) => command)).toEqual(['send_download', 'send_download'])
  expect(invoke.mock.calls[0][1]).not.toHaveProperty('quality')
})

it('sends picked non-EPUBs and disabled EPUBs unchanged', async () => {
  await sendFile(new File(['text'], 'notes.txt'), prefs)
  await sendFile(new File(['original'], 'book.epub'), { ...prefs, optimize: false })
  expect(optimizeEpub).not.toHaveBeenCalled()
  expect(invoke.mock.calls.map(([, bytes]) => new TextDecoder().decode(bytes))).toEqual(['text', 'original'])
})

it('does not silently upload the original when optimization fails', async () => {
  optimizeEpub.mockRejectedValue(new Error('Broken EPUB'))
  await expect(sendFile(new File(['bad'], 'book.epub'), prefs)).rejects.toThrow('Broken EPUB')
  expect(invoke).not.toHaveBeenCalled()
})

it('fetches covers through the app only for catalogs behind a login', () => {
  const open = { auth: { kind: 'none' } }
  const basic = { auth: { kind: 'basic', username: 'u', password: 'p' } }
  expect(needsAuthedImage(open, 'https://x.org/c.jpg')).toBe(false)
  expect(needsAuthedImage({}, 'https://x.org/c.jpg')).toBe(false)
  expect(needsAuthedImage(basic, 'https://x.org/c.jpg')).toBe(true)
  expect(needsAuthedImage(basic, 'data:image/png;base64,AAAA')).toBe(false)
  expect(needsAuthedImage(basic, undefined)).toBe(false)
})

it('fetches a cover once with the catalog credentials', async () => {
  invoke.mockResolvedValue('data:image/jpeg;base64,AAAA')
  const cat = { auth: { kind: 'basic', username: 'u', password: 'p' } }
  expect(await image(cat, 'https://x.org/opds/cover/1')).toBe('data:image/jpeg;base64,AAAA')
  await image(cat, 'https://x.org/opds/cover/1')
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledWith('opds_image', { url: 'https://x.org/opds/cover/1', auth: cat.auth })
})

it('keeps a public cover URL as is with a download, and drops a login-only one it cannot fetch', async () => {
  expect(await storedCover({ auth: { kind: 'none' } }, 'https://x.org/c.jpg')).toBe('https://x.org/c.jpg')
  expect(await storedCover({ auth: { kind: 'none' } }, undefined)).toBe(null)
  invoke.mockRejectedValueOnce('401')
  expect(await storedCover({ auth: { kind: 'bearer', token: 't' } }, 'https://x.org/opds/cover/2')).toBe(null)
})

it('repairs before optimizing when asked, and names a repaired book from its metadata', async () => {
  const fixed = new File(['fixed'], 'book.epub')
  repairEpub.mockResolvedValue(fixed)
  await sendFile(new File(['original'], 'book.epub'), { ...prefs, fixMetadata: true, renameFromMetadata: false })
  expect(optimizeEpub.mock.calls[0][0]).toBe(fixed)
  expect(invoke.mock.calls[0][2].headers['x-rename']).toBe('1')
})

it('sends the original, under its own name, when the repair gives up or optimizing is off', async () => {
  repairEpub.mockResolvedValue(null)
  const file = new File(['original'], 'book.epub')
  await sendFile(file, { ...prefs, fixMetadata: true, renameFromMetadata: false })
  expect(optimizeEpub.mock.calls[0][0]).toBe(file)
  expect(invoke.mock.calls[0][2].headers['x-rename']).toBeUndefined()
  await sendFile(file, { ...prefs, optimize: false, fixMetadata: true })
  expect(repairEpub).toHaveBeenCalledTimes(1)
})
