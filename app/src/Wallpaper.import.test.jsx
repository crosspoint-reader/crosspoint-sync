// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
vi.mock('./api.js',()=>({isApp:true}))
vi.mock('./catalogs.js',()=>({reader:async()=> 'http://reader',sendFile:vi.fn(async()=>{})}))
vi.mock('./device.js',async original=>({...await original(),connect:async()=>({status:{}}),folders:async()=>[],loadDevicePrefs:()=>({host:'reader',folder:'/'} )}))
vi.mock('./readers.js',async original=>{const real=await original();return {...real,refreshReaders:async()=>real.readers}})
vi.mock('./wallpaper/community.js',()=>({CATEGORIES:[],canFilter:()=>false,communityPage:async()=>({items:[],totalPages:0}),fullImage:vi.fn()}))
vi.mock('./wallpaper/render.js',async original=>({...await original(),autoLevels:()=>({}),renderWallpaper:(image,settings)=>({name:image.src,rotation:settings.rotation}),toBmp:result=>new Blob([result?.name??'STALE'])}))
const store=vi.hoisted(()=>({entries:[{id:'old',name:'Old.png',size:1},{id:'new',name:'New.png',size:1}]}))
vi.mock('./importQueue.js',()=>({listImports:async()=>store.entries.map(e=>({...e})),readImport:async entry=>new File(['image'],entry.name),removeImport:async id=>{store.entries=store.entries.filter(e=>e.id!==id)}}))
import Wallpaper from './Wallpaper.jsx'
import {sendFile} from './catalogs.js'
afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks()})
it('sends the selected queued image before its preview animation frame and removes only that image',async()=>{
 vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener(){},removeEventListener(){}}))
 vi.stubGlobal('requestAnimationFrame',()=>1)
 vi.stubGlobal('cancelAnimationFrame',()=>{})
 vi.stubGlobal('Image',class {
  naturalWidth=100;naturalHeight=100
  set src(value){this.value=value;queueMicrotask(()=>this.onload?.())}
  get src(){return this.value}
 })
 vi.stubGlobal('URL',class extends URL { static createObjectURL(file){return file.name} static revokeObjectURL(){} })
 vi.spyOn(window,'scrollTo').mockImplementation(()=>{})
 render(<Wallpaper/> )
 fireEvent.click((await screen.findAllByRole('button',{name:'Edit sleep screen'}))[1])
 fireEvent.click(await screen.findByRole('button',{name:/Send to reader/}))
 await waitFor(()=>expect(store.entries.map(e=>e.id)).toEqual(['old']))
 const file=sendFile.mock.calls[0][0]
 const text=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsText(file)})
 expect(text).toBe('New.png')
 expect(file.type).toBe('image/bmp')
})
