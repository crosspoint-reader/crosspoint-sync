import { invoke } from '@tauri-apps/api/core'
import { http, ipcBytes } from '../api.js'

// Fonts saved in the app's data folder, waiting to be sent: <family>/<file>.
// Google and picked fonts keep their TTF/OTF files (sent as TrueType or converted at send time);
// CrossPoint's prebuilt fonts are already .cpfont files.
export const savedFonts = () => invoke('list_saved_fonts') // [{ family, files: [name] }]
export const forgetFont = (family) => invoke('delete_saved_font', { family })
export const isPrebuilt = (font) => font.files.some((n) => n.endsWith('.cpfont'))

export async function saveFont(family, files) {
  await forgetFont(family).catch(() => {}) // replace, don't merge with an older copy
  for (const { name, data } of files) {
    const headers = { 'x-family': encodeURIComponent(family), 'x-name': encodeURIComponent(name) }
    await invoke('save_font_file', await ipcBytes(new Blob([data])), { headers })
  }
}

export async function readFont({ family, files }) {
  return Promise.all(files.map(async (name) => ({ name, data: new Uint8Array(await invoke('read_font_file', { family, name })) })))
}

// The catalog the reader's own Settings › Manage Fonts uses (manifest v1, .cpfont v4).
const MANIFEST = 'https://github.com/crosspoint-reader/crosspoint-fonts/releases/download/sd-fonts-m1-b4/fonts.json'
let manifest
export function crossPointFonts() {
  manifest ??= http(MANIFEST)
    .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`CrossPoint font list failed (${res.status})`))))
    .catch((e) => {
      manifest = null
      throw e
    })
  return manifest // { baseUrl, families: [{ name, description, files: [{ name, size }] }] }
}

export async function downloadPrebuilt(baseUrl, font, progress = () => {}) {
  const files = []
  for (const [i, file] of font.files.entries()) {
    progress(`Downloading ${i + 1} of ${font.files.length}…`)
    const res = await http(baseUrl + file.name)
    const data = res.ok && new Uint8Array(await res.arrayBuffer())
    if (!data || data.byteLength !== file.size) throw new Error(`Couldn't download ${file.name}`)
    files.push({ name: file.name, data })
  }
  return files
}

// Picked .cpfont files, grouped by family: "Literata_12.cpfont" -> Literata.
export async function cpfontFamilies(files) {
  const families = {}
  for (const file of files) {
    const data = new Uint8Array(await file.arrayBuffer())
    if (String.fromCharCode(...data.slice(0, 6)) !== 'CPFONT') throw new Error(`${file.name} isn't a .cpfont file`)
    const family = file.name.replace(/(_\d+)?\.cpfont$/i, '')
    ;(families[family] ??= []).push({ name: file.name, data })
  }
  return families
}
