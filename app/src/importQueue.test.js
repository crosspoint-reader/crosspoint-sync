// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./api.js', () => ({ ipcBytes: async () => new Uint8Array([1, 2]) }))
import { invoke } from '@tauri-apps/api/core'
import { watchImports, readImport } from './importQueue.js'
let stop
beforeEach(() => { vi.useFakeTimers(); invoke.mockReset() })
afterEach(() => { stop?.(); vi.useRealTimers() })
it('discovers cold-start imports and later incoming files without navigating for removals', async () => {
  let entries = [{ id: 'one', name: 'Loan.acsm', size: 2 }]
  invoke.mockImplementation(async command => { if (command === 'list_imports') return entries; throw Error(command) })
  const incoming = vi.fn(), error = vi.fn(), changed = vi.fn()
  window.addEventListener('crosspoint-imports-changed', changed)
  stop = watchImports(incoming, error)
  await vi.advanceTimersByTimeAsync(0)
  expect(incoming).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1500)
  expect(incoming).toHaveBeenCalledTimes(1)
  entries = [...entries, { id: 'two', name: 'Notes.md', size: 2 }]
  await vi.advanceTimersByTimeAsync(1500)
  expect(incoming).toHaveBeenCalledTimes(2)
  entries = []
  await vi.advanceTimersByTimeAsync(1500)
  expect(incoming).toHaveBeenCalledTimes(2)
  expect(changed).toHaveBeenCalledTimes(3)
  expect(error).not.toHaveBeenCalled()
  window.removeEventListener('crosspoint-imports-changed', changed)
})
it('ignores a pending poll after the observer unmounts', async () => {
  let resolve
  invoke.mockImplementation(() => new Promise(done => { resolve = done }))
  const incoming = vi.fn()
  stop = watchImports(incoming, vi.fn())
  stop()
  resolve([{ id: 'late', name: 'Late.txt', size: 2 }])
  await vi.advanceTimersByTimeAsync(0)
  expect(incoming).not.toHaveBeenCalled()
})
it.each([new Uint8Array([1, 2]).buffer, [1, 2]])('reads raw and JSON native byte responses into a named file', async bytes => {
  invoke.mockResolvedValue(bytes)
  const file = await readImport({ id: 'one', name: 'Shared.epub' })
  expect(file.name).toBe('Shared.epub')
  expect(file.size).toBe(2)
})
