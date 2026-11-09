// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { localDay } from './readingHistory.js'

vi.mock('./api.js', () => ({ isApp: true, http: vi.fn(), cached: { cover: vi.fn() } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue() }))
const { invoke } = await import('@tauri-apps/api/core')
const { http, cached } = await import('./api.js')
const { clearWidget, updateWidget } = await import('./widget.js')
const book = { document: 'shared', title: 'uxj4 book', status: 'reading', percentage: 0.4 }
const update = (books) => updateWidget({ books, summary: null, activity: null })
const data = () => JSON.parse(invoke.mock.calls.at(-1)[1].json)

beforeEach(async () => {
  await clearWidget()
  vi.clearAllMocks()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  vi.stubGlobal('caches', undefined)
  vi.stubGlobal('createImageBitmap', vi.fn())
  cached.cover.mockReset()
})
afterEach(() => { delete window.CrossPointWidget; vi.unstubAllGlobals() })

describe('widget account data', () => {
  it('publishes streaks without measured time and only an explicitly selected current-year goal', async () => {
    const year = new Date().getFullYear()
    await updateWidget({ books: [book], activity: { books: [], reading_days: [localDay(new Date())] }, goals: { goals: [{ year, target: 12, completed: 4 }] } })
    expect(data()).toMatchObject({ history_known: true, current_streak: 1, longest_streak: 1, goal: { year, target: 12, completed: 4 } })
    expect(data().history_days).toContain(localDay(new Date()))
    expect(data()).not.toHaveProperty('updated_at')
    expect(data().goals).toEqual([{ year, target: 12, completed: 4 }])
    await updateWidget({ books: [book], goals: { goals: [{ year: year - 1, target: 12, completed: 4 }] } })
    expect(data().goal).toBeNull()
    expect(data().history_known).toBe(false)
    await clearWidget()
    expect(data()).not.toHaveProperty('goal')
    expect(data()).not.toHaveProperty('history_days')
  })
  it.each([0, 180])('publishes the larger of the dated longest streak and the all-time record %s', async (record) => {
    const days = [0, 1, 2].map(offset => {
      const date = new Date()
      date.setDate(date.getDate() - offset)
      return localDay(date)
    })
    await updateWidget({ books: [book], summary: { streak: record }, activity: { books: [], reading_days: days } })
    expect(data().longest_streak).toBe(Math.max(3, record))
  })

  it('uses the grid-derived streak and republishes when dated history arrives', async () => {
    const summary = { devices: [{ device: 'CrossInk' }], current_streak: 8, seconds: 3600 }
    await updateWidget({ books: [book], summary })
    expect(data().stats).toBe('8-day streak · 1h read')
    await updateWidget({ books: [book], summary, activity: { books: [], reading_days: [localDay(new Date())] } })
    expect(data().stats).toBe('1-day streak · 1h read')
  })

  it('clears the previous book and stats on sign-out, including the Android bridge', async () => {
    window.CrossPointWidget = { update: vi.fn() }
    await update([book])
    await clearWidget()
    const [json, cover] = window.CrossPointWidget.update.mock.calls.at(-1)
    expect(JSON.parse(json)).toMatchObject({ title: 'Sign in to see your reading', author: '', percent: -1, stats: '' })
    expect(cover).toBe('')
  })

  it('hands the widget the session to refresh with, and drops it on sign-out', async () => {
    const session = { server: 'https://sync.test', username: 'reader', key: 'k', extra: 'not sent' }
    await updateWidget({ session, books: [{ ...book, cover_url: 'https://covers.test/a.jpg' }] })
    expect(data()).toMatchObject({ session: { server: 'https://sync.test', username: 'reader', key: 'k' }, cover_url: 'https://covers.test/a.jpg' })
    expect(data().session).not.toHaveProperty('extra')
    await clearWidget()
    expect(data()).not.toHaveProperty('session')
  })

  it('ignores a cover download that completes after sign-out', async () => {
    let resolve
    let started
    const requested = new Promise(r => { started = r })
    http.mockImplementationOnce(() => { started(); return new Promise(r => { resolve = r }) })
    const pending = update([{ ...book, cover_url: 'https://covers.test/book.jpg' }])
    await requested
    await clearWidget()
    resolve({ ok: false })
    await pending
    expect(data().title).toBe('Sign in to see your reading')
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('publishes again when another account has the same current book', async () => {
    await update([book])
    await clearWidget()
    await update([book])
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(data().title).toBe('uxj4 book')
  })
})

describe('widget covers', () => {
  it('uses the app lookup cache for the exact account and document when the library has no cover URL', async () => {
    const session = { server: 'https://sync.test', username: 'reader', key: 'k' }
    cached.cover.mockReturnValue('https://covers.test/looked-up.jpg')
    http.mockRejectedValue(new Error('offline'))
    await updateWidget({ session, books: [book] })
    expect(cached.cover).toHaveBeenCalledWith(session, book.document)
    expect(data().cover_url).toBe('https://covers.test/looked-up.jpg')
    expect(http).toHaveBeenCalledWith('https://covers.test/looked-up.jpg')
  })

  it('retries an unchanged snapshot after a failed cover download', async () => {
    http.mockRejectedValue(new Error('offline'))
    const books = [{ ...book, cover_url: 'https://covers.test/retry.jpg' }]
    await update(books)
    await update(books)
    expect(http).toHaveBeenCalledTimes(2)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('publishes the exact cached cover and keeps corrected URLs separate', async () => {
    const blobs = new Map([
      ['https://covers.test/a.jpg', new Blob(['A'])],
      ['https://covers.test/fixed.jpg', new Blob(['fixed'])],
    ])
    vi.stubGlobal('caches', { open: async () => ({ match: async url => blobs.has(url) ? { blob: async () => blobs.get(url) } : undefined }) })
    vi.stubGlobal('createImageBitmap', vi.fn(async blob => ({ width: 168, height: 252, close() {}, bytes: await blob.text() })))
    let drawn
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: image => { drawn = image.bytes } })
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => `data:image/png;base64,${drawn}`)
    await update([{ ...book, cover_url: 'https://covers.test/a.jpg' }])
    expect(invoke.mock.calls.at(-1)[1].cover).toBe('A')
    await update([{ ...book, document: 'other', cover_url: 'https://covers.test/fixed.jpg' }])
    expect(invoke.mock.calls.at(-1)[1].cover).toBe('fixed')
    http.mockRejectedValue(new Error('offline'))
    await update([{ ...book, document: 'third', cover_url: 'https://covers.test/missing.jpg' }])
    expect(invoke.mock.calls.at(-1)[1].cover).toBe('')
    expect(data().book_document).toBe('third')
    vi.restoreAllMocks()
  })
})
