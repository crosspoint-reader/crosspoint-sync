// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('./api.js', () => ({ isApp: true, ipcBytes: vi.fn() }))
vi.mock('./ui.jsx', async original => ({ ...await original(), notify: vi.fn() }))
import { invoke } from '@tauri-apps/api/core'
import ImportedAssets from './ImportedAssets.jsx'
let entries
beforeEach(() => {
 entries = [{id:'font',name:'Reader.ttf',size:2},{id:'image',name:'Sleep.png',size:2},{id:'book',name:'Book.epub',size:2}]
 invoke.mockImplementation(async (cmd,args) => {
  if(cmd === 'list_imports') return entries.map(e=>({...e}))
  if(cmd === 'read_import') return [1,2]
  if(cmd === 'remove_import') { entries=entries.filter(e=>e.id!==args.id);return }
  throw Error(cmd)
 })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
it('filters categories and preserves a failed send, then removes only a successful font', async () => {
 let fails=true
 const action=async file=>{ expect(file.name).toBe('Reader.ttf');if(fails)throw Error('Disconnected') }
 render(<ImportedAssets kind="fonts" actionLabel="Send font" onAction={action}/> )
 await screen.findByText('Reader.ttf')
 expect(screen.queryByText('Book.epub')).toBeNull()
 expect(screen.queryByText('Sleep.png')).toBeNull()
 fireEvent.click(screen.getByRole('button',{name:'Send font'}))
 await waitFor(()=>expect(screen.getByRole('button',{name:'Send font'}).disabled).toBe(false))
 expect(entries.map(e=>e.id)).toEqual(['font','image','book'])
 fails=false
 fireEvent.click(screen.getByRole('button',{name:'Send font'}))
 await waitFor(()=>expect(screen.queryByText('Reader.ttf')).toBeNull())
 expect(entries.map(e=>e.id)).toEqual(['image','book'])
})
it('editing a sleep screen retains the original across remount, and Remove deletes it', async () => {
 const view=render(<ImportedAssets kind="wallpaper" actionLabel="Edit" onAction={async()=>{}} removeAfter={false}/>)
 fireEvent.click(await screen.findByRole('button',{name:'Edit'}))
 await waitFor(()=>expect(screen.getByRole('button',{name:'Edit'}).disabled).toBe(false))
 view.unmount()
 render(<ImportedAssets kind="wallpaper" actionLabel="Edit" onAction={async()=>{}} removeAfter={false}/>)
 fireEvent.click(await screen.findByRole('button',{name:'Remove Sleep.png'}))
 await waitFor(()=>expect(screen.queryByText('Sleep.png')).toBeNull())
 expect(entries.map(e=>e.id)).toEqual(['font','book'])
})
it('locks and consumes all related font faces only after the grouped upload succeeds',async()=>{
 entries.push({id:'bold',name:'Reader-Bold.ttf',size:2})
 let finish
 const action=vi.fn(async(_file,_entry,files)=>{expect(files.map(f=>f.name)).toEqual(['Reader.ttf','Reader-Bold.ttf']);await new Promise(done=>{finish=done})})
 render(<ImportedAssets kind="fonts" actionLabel="Send family" onAction={action} groupEntries={(_entry,all)=>all}/>)
 fireEvent.click((await screen.findAllByRole('button',{name:'Send family'}))[0])
 await waitFor(()=>expect(finish).toBeTypeOf('function'))
 expect(entries).toHaveLength(4)
 expect(screen.getAllByRole('button',{name:'Processing…'})).toHaveLength(2)
 finish()
 await waitFor(()=>expect(screen.queryByText('Reader.ttf')).toBeNull())
 expect(entries.map(e=>e.id)).toEqual(['image','book'])
})
