import { expect, it } from 'vitest'
import { importKind, importRoute } from './importTypes.js'
it.each([
 ['Book.EPUB', 'books'], ['Loan.acsm', 'books'], ['Notes.md','books'], ['Notes.txt','books'],
 ['Font.ttf','fonts'], ['Font.OTF','fonts'], ['Literata_12.cpfont','fonts'],
 ['Sleep.png','wallpaper'], ['Sleep.JPG','wallpaper'], ['Sleep.jpeg','wallpaper'],
 ['Sleep.webp','wallpaper'], ['Sleep.gif','wallpaper'], ['Sleep.bmp','wallpaper'],
 ['Archive.zip',null], ['Fake.cpfonts',null], ['Font.woff2',null],
])('classifies %s as %s', (name, kind) => expect(importKind({ name })).toBe(kind))
it('routes a homogeneous batch to its tab and a mixed batch to Send', () => {
 expect(importRoute([{name:'A.ttf'},{name:'B.cpfont'}])).toBe('#/send/fonts')
 expect(importRoute([{name:'A.png'}])).toBe('#/send/wallpaper')
 expect(importRoute([{name:'A.epub'},{name:'A.ttf'}])).toBe('#/send')
})
