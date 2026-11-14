// @vitest-environment jsdom
import { File } from 'node:buffer'
import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../api.js',()=>({http:(...args)=>fetch(...args),isApp:false,ipcBytes:vi.fn()}))
import { groupFontEntries, sendImportedFont, sendImportedFonts } from './sendImported.js'
afterEach(()=>vi.unstubAllGlobals())
it.each(['ttf','otf'])('sends shared %s through the TrueType endpoint with normalized family/style', async ext=>{
 const requests=[]
 vi.stubGlobal('fetch',async(url,options)=>{requests.push([url,options]);return {ok:true}})
 await sendImportedFont(new File([ext === 'otf' ? 'OTTOdata' : new Uint8Array([0,1,2])],`Reader-Regular.${ext}`),{base:'http://reader',trueType:true})
 expect(requests.map(([url])=>url)).toEqual(['http://reader/mkdir','http://reader/mkdir','http://reader/upload?path=%2Ffonts%2FReader&overwrite=1'])
 expect(requests[2][1].body.get('file').name).toBe(`Reader-Regular.${ext}`)
})
it('uploads a prebuilt shared font unchanged even with conversion selected', async()=>{
 const requests=[]
 vi.stubGlobal('fetch',async(url,options)=>{requests.push([url,options]);return {ok:true}})
 await sendImportedFont(new File(['CPFONTpayload'],'Literata_12.cpfont'),{base:'http://reader',trueType:false})
 expect(requests).toHaveLength(1)
 expect(requests[0][0]).toBe('http://reader/api/fonts/upload')
 expect(requests[0][1].body.get('family')).toBe('Literata')
 expect(requests[0][1].body.get('file').name).toBe('Literata_12.cpfont')
})
it('rejects a malformed prebuilt font before any reader request',async()=>{
 const request=vi.fn()
 vi.stubGlobal('fetch',request)
 await expect(sendImportedFont(new File(['bad'],'Bad.cpfont'),{base:'http://reader',trueType:true})).rejects.toThrow("isn't a .cpfont")
 expect(request).not.toHaveBeenCalled()
})
it('does not synthesize a regular face when only a bold face is shared',async()=>{
 const requests=[]
 vi.stubGlobal('fetch',async(url,options)=>{requests.push([url,options]);return {ok:true}})
 await sendImportedFont(new File(['bold-data'],'Reader-Bold.ttf'),{base:'http://reader',trueType:true})
 const uploads=requests.filter(([url])=>url.includes('/upload?'))
 expect(uploads.map(([,request])=>request.body.get('file').name)).toEqual(['Reader-Bold.ttf'])
})

it('groups available faces and sizes without consuming duplicate styles or other families',()=>{
 const entries=[{id:'r',name:'Reader-Regular.ttf'},{id:'b',name:'Reader-Bold.ttf'},{id:'dup',name:'Reader-Regular.ttf'},{id:'other',name:'Other-Regular.ttf'},{id:'cpf',name:'Reader_12.cpfont'}]
 expect(groupFontEntries(entries[0],entries).map(e=>e.id)).toEqual(['r','b'])
 expect(groupFontEntries(entries[2],entries).map(e=>e.id)).toEqual(['dup','b'])
})
it('sends regular and bold faces together without replacing regular with bold bytes',async()=>{
 const uploads=[]
 vi.stubGlobal('fetch',async(url,options)=>{if(url.includes('/upload?'))uploads.push(options.body.get('file').name);return {ok:true}})
 await sendImportedFonts([new File(['regular'],'Reader-Regular.ttf'),new File(['bold'],'Reader-Bold.ttf')],{base:'http://reader',trueType:true})
 expect(uploads).toEqual(['Reader-Regular.ttf','Reader-Bold.ttf'])
})
it('retains an incomplete family rather than replacing it with converted bold as regular',async()=>{
 const request=vi.fn()
 vi.stubGlobal('fetch',request)
 await expect(sendImportedFont(new File(['bold'],'Reader-Bold.ttf'),{base:'http://reader',trueType:false})).rejects.toThrow('Include the regular font style')
 expect(request).not.toHaveBeenCalled()
})
it('converts a complete family together and uploads generated CPFONT files',async()=>{
 const requests=[]
 vi.stubGlobal('Worker',class {
  terminate() {}
  postMessage(message) {
   expect(message.family).toBe('Reader')
   expect([...message.styles.regular]).toEqual([1,2])
   expect([...message.styles.bold]).toEqual([3,4])
   queueMicrotask(()=>this.onmessage({data:{files:[{name:'Reader_12.cpfont',data:new Uint8Array([67,80,70,79,78,84])}]}}))
  }
 })
 vi.stubGlobal('fetch',async(url,options)=>{requests.push([url,options]);return {ok:true}})
 await sendImportedFonts([new File([new Uint8Array([1,2])],'Reader-Regular.ttf'),new File([new Uint8Array([3,4])],'Reader-Bold.ttf')],{base:'http://reader',trueType:false})
 expect(requests.map(([url])=>url)).toEqual(['http://reader/api/fonts/upload'])
 expect(requests[0][1].body.get('file').name).toBe('Reader_12.cpfont')
})
