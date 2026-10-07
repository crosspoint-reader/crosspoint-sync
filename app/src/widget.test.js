// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('./api.js', () => ({ isApp: true, http: vi.fn() }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue() }))
const { invoke } = await import('@tauri-apps/api/core')
const { http } = await import('./api.js')
const { clearWidget, updateWidget } = await import('./widget.js')
const book = { document: 'shared', title: 'uxj4 book', status: 'reading', percentage: 0.4 }
const update = (books) => updateWidget({ books, summary: null, activity: null })
const data = () => JSON.parse(invoke.mock.calls.at(-1)[1].json)

beforeEach(async () => {
  await clearWidget()
  vi.clearAllMocks()
})
afterEach(() => { delete window.CrossPointWidget })

describe('widget account data', () => {
  it('clears the previous book and stats on sign-out, including the Android bridge', async () => {
    window.CrossPointWidget = { update: vi.fn() }
    await update([book])
    await clearWidget()
    const [json, cover] = window.CrossPointWidget.update.mock.calls.at(-1)
    expect(JSON.parse(json)).toMatchObject({ title: 'Sign in to see your reading', author: '', percent: -1, stats: '' })
    expect(cover).toBe('')
  })

  it('ignores a cover download that completes after sign-out', async () => {
    let resolve
    http.mockReturnValueOnce(new Promise((r) => { resolve = r }))
    const pending = update([{ ...book, cover_url: 'https://covers.test/book.jpg' }])
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
