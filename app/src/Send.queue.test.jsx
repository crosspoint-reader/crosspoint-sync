// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
vi.hoisted(() => { window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) })
vi.mock('./api.js', () => ({ isApp: true }))
vi.mock('./tabbar.js', () => ({ useSheet() {} }))
vi.mock('./catalogs.js', () => ({ downloads: async () => [], sendFile: vi.fn(), sendDownload: vi.fn(), removeDownload: vi.fn() }))
vi.mock('./device.js', async original => ({ ...await original(), connect: async () => ({ base: 'http://reader', status: {} }), folders: async () => [], listFiles: async () => [] }))
const store = vi.hoisted(() => ({ entries: [] }))
vi.mock('./importQueue.js', () => ({
  listImports: async () => store.entries.map(e => ({ ...e })),
  readImport: async entry => new File(['book'], entry.name),
  removeImport: async id => { store.entries = store.entries.filter(e => e.id !== id) },
  addImport: vi.fn(),
}))
import Send from './Send.jsx'
import { sendFile } from './catalogs.js'
import * as queue from './importQueue.js'
beforeEach(() => {
  store.entries = [{ id: 'first', name: 'Shared.epub', size: 4 }, { id: 'second', name: 'Shared.epub', size: 5 }]
  sendFile.mockReset()
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })
it('restores same-name imports after leaving the tab and removes only the chosen entry', async () => {
  const view = render(<Send />)
  await waitFor(() => expect(screen.getAllByText('Shared.epub')).toHaveLength(2))
  fireEvent.click(screen.getAllByRole('button', { name: 'Remove Shared.epub' })[0])
  await waitFor(() => expect(screen.getAllByText('Shared.epub')).toHaveLength(1))
  view.unmount()
  render(<Send />)
  await waitFor(() => expect(screen.getAllByText('Shared.epub')).toHaveLength(1))
  expect(store.entries.map(e => e.id)).toEqual(['second'])
})
it('retains a failed send across remount and removes a successful send from durable storage', async () => {
  store.entries = store.entries.slice(0, 1)
  sendFile.mockRejectedValueOnce(new Error('Reader disconnected')).mockResolvedValueOnce('Shared.epub')
  const view = render(<Send />)
  fireEvent.click(await screen.findByRole('button', { name: 'Send 1 book' }))
  await screen.findByText(/Reader disconnected/)
  view.unmount()
  render(<Send />)
  fireEvent.click(await screen.findByRole('button', { name: 'Send 1 book' }))
  await waitFor(() => expect(store.entries).toEqual([]))
  cleanup()
  render(<Send />)
  await waitFor(() => expect(screen.queryByText('Shared.epub')).toBeNull())
})
it('does not send a file twice when the tab remounts during transmission', async () => {
  store.entries = store.entries.slice(0, 1)
  let finish
  sendFile.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  const view = render(<Send />)
  fireEvent.click(await screen.findByRole('button', { name: 'Send 1 book' }))
  await waitFor(() => expect(finish).toBeTypeOf('function'))
  view.unmount()
  render(<Send />)
  const send = await screen.findByRole('button', { name: 'Send 1 book' })
  expect(send.disabled).toBe(true)
  finish('Shared.epub')
  await waitFor(() => expect(store.entries).toEqual([]))
})

it('does not resurrect a removed file when an older list response arrives late', async () => {
  store.entries = store.entries.slice(0, 1)
  render(<Send />)
  await screen.findByText('Shared.epub')
  const stale = store.entries.map(e => ({ ...e }))
  let resolve
  vi.spyOn(queue, 'listImports').mockImplementationOnce(() => new Promise(done => { resolve = done }))
  window.dispatchEvent(new Event('crosspoint-imports-changed'))
  fireEvent.click(screen.getByRole('button', { name: 'Remove Shared.epub' }))
  await waitFor(() => expect(screen.queryByText('Shared.epub')).toBeNull())
  resolve(stale)
  await new Promise(done => setTimeout(done, 20))
  expect(screen.queryByText('Shared.epub')).toBeNull()
})
it('recovers from a failed queue refresh without another native change event',async()=>{
 vi.spyOn(queue,'listImports').mockRejectedValueOnce(new Error('Temporary read failure'))
 render(<Send/>)
 await waitFor(()=>expect(screen.getAllByText('Shared.epub')).toHaveLength(2),{timeout:3000})
})
it('reloads a stale snapshot so another source incoming during removal is still shown',async()=>{
 store.entries=store.entries.slice(0,1)
 render(<Send/>)
 await screen.findByText('Shared.epub')
 let resolve
 vi.spyOn(queue,'listImports').mockImplementationOnce(()=>new Promise(done=>{resolve=done}))
 window.dispatchEvent(new Event('crosspoint-imports-changed'))
 store.entries.push({id:'new',name:'Incoming.epub',size:4})
 fireEvent.click(screen.getByRole('button',{name:'Remove Shared.epub'}))
 await waitFor(()=>expect(screen.queryByText('Shared.epub')).toBeNull())
 resolve([{id:'new',name:'Incoming.epub',size:4}])
 await screen.findByText('Incoming.epub')
 expect(screen.queryByText('Shared.epub')).toBeNull()
})
