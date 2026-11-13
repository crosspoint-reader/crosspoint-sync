import { uploadFont, uploadTrueType } from '../device.js'
import { convert, familyName, localFamily, localFontIdentity, trueTypeFiles } from './google.js'
import { cpfontFamilies } from './saved.js'

// Shared files use the same font APIs and conversion as the font library, never
// the generic book uploader. Prebuilt files always pass through unchanged.
export function groupFontEntries(selected, entries) {
  const identity = entry => /\.cpfont$/i.test(entry.name)
    ? { family: entry.name.replace(/(_\d+)?\.cpfont$/i, ''), style: entry.name.toLowerCase(), prebuilt: true }
    : { ...localFontIdentity(entry.name), prebuilt: false }
  const target = identity(selected), styles = new Set()
  return [selected, ...entries.filter(e => e.id !== selected.id)].filter(entry => {
    const value = identity(entry)
    if (familyName(value.family).toLowerCase() !== familyName(target.family).toLowerCase() || value.prebuilt !== target.prebuilt || styles.has(value.style)) return false
    styles.add(value.style)
    return true
  })
}
export const sendImportedFont = (file, options) => sendImportedFonts([file], options)
export async function sendImportedFonts(pickedFiles, { base, trueType, progress = () => {} }) {
  const file = pickedFiles[0]
  if (/\.cpfont$/i.test(file.name)) {
    for (const [name, fonts] of Object.entries(await cpfontFamilies(pickedFiles))) {
      for (const font of fonts) await uploadFont(base, familyName(name) || 'CustomFont', font)
    }
    return
  }
  const picked = await localFamily(pickedFiles)
  const family = familyName(picked.family) || 'CustomFont'
  if (!picked.styles.regular) throw new Error('Choose .ttf, .otf or .cpfont files')
  const actualStyles = new Set(pickedFiles.map(file => localFontIdentity(file.name).style))
  if (!actualStyles.has('regular')) {
    if (!trueType) throw new Error('Include the regular font style before converting this family to .cpfont')
    delete picked.styles.regular
  }
  progress(trueType ? 'Sending font…' : 'Converting font…')
  const files = trueType ? trueTypeFiles(family, picked.styles) : await convert(family, picked.styles)
  for (const font of files) await (trueType ? uploadTrueType : uploadFont)(base, family, font)
}
