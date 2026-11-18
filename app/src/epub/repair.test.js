// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest'
import { http } from '../api.js'
import { repairEpub } from './repair.js'

vi.mock('../api.js', () => ({ http: vi.fn() }))
beforeEach(() => vi.clearAllMocks())
const logs = (progress) => progress.mock.calls.filter(([p]) => p.log).map(([p]) => `${p.log.tag}: ${p.log.message}`)

it('returns the repaired file under the same name and logs what changed', async () => {
  const report = { issues: [{ field: 'title', problem: 'differs', was: 'hobbit_final_v2', now: 'The Hobbit' }, { field: 'isbn', problem: 'missing', was: null, now: null }], notes: ['Identified by ISBN'] }
  http.mockResolvedValue(new Response('fixed', { headers: { 'x-report': encodeURIComponent(JSON.stringify(report)) } }))
  const progress = vi.fn()
  const file = new File(['original'], 'hobbit.epub')
  const fixed = await repairEpub(file, progress)
  expect(fixed.name).toBe('hobbit.epub')
  expect(fixed.size).toBe(5)
  expect(http.mock.calls[0][0]).toBe('https://api.metadata.dev/epub')
  expect(http.mock.calls[0][1].body).toBe(file)
  expect(logs(progress)).toEqual(['FIX: title: hobbit_final_v2 → The Hobbit', 'INFO: Identified by ISBN'])
})

it.each([
  [() => Promise.resolve(new Response('{}', { status: 404 })), /couldn't identify/],
  [() => Promise.resolve(new Response('', { status: 429 })), /\(429\)/],
  [() => Promise.reject(new Error('offline')), /offline/],
])('gives up without failing the send', async (answer, reason) => {
  http.mockImplementation(answer)
  const progress = vi.fn()
  expect(await repairEpub(new File(['original'], 'book.epub'), progress)).toBeNull()
  expect(logs(progress)[0]).toMatch(reason)
})

it('never uploads a file over the 30 MB limit', async () => {
  const file = new File(['x'], 'big.epub')
  Object.defineProperty(file, 'size', { value: 31 * 1024 * 1024 })
  expect(await repairEpub(file)).toBeNull()
  expect(http).not.toHaveBeenCalled()
})
