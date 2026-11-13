// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import ReaderFonts from './ReaderFonts.jsx'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (command) => {
    if (command === 'list_saved_fonts') return [{ family: 'Literata', files: ['Literata_12.cpfont'] }]
    if (command === 'read_font_file') return [67, 80, 70, 79, 78, 84]
    throw new Error(`Unexpected command: ${command}`)
  },
}))
vi.mock('./api.js', () => ({ http: (...args) => fetch(...args), isApp: false }))
vi.mock('./ui.jsx', async () => {
  const actual = await vi.importActual('./ui.jsx')
  return { ...actual, notify: vi.fn() }
})
import { notify } from './ui.jsx'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks() })

it.each([false, true])('sends a saved font and reports the result (upload failure: %s)', async (fails) => {
  const uploads = []
  vi.stubGlobal('fetch', async (url, options) => {
    if (url === 'http://reader/api/fonts') return { ok: true, json: async () => ({ families: [] }) }
    if (url === 'http://reader/api/fonts/upload') {
      uploads.push(options)
      return { ok: !fails, text: async () => 'Reader storage full' }
    }
    throw new Error(`Unexpected request: ${url}`)
  })
  render(<ReaderFonts base="http://reader" device="X4" />)
  fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
  await waitFor(() => expect(notify).toHaveBeenCalledWith(fails
    ? { error: true, title: "Couldn't send Literata", detail: 'Reader storage full' }
    : { title: 'Sent Literata', detail: 'Pick it in Settings › Reader › Font Family' }))
  expect(uploads).toHaveLength(1)
  expect(uploads[0].method).toBe('POST')
  expect(uploads[0].body.get('family')).toBe('Literata')
  const file = uploads[0].body.get('file')
  expect(file.name).toBe('Literata_12.cpfont')
  expect(await new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve([...new Uint8Array(reader.result)])
    reader.readAsArrayBuffer(file)
  })).toEqual([67, 80, 70, 79, 78, 84])
})
