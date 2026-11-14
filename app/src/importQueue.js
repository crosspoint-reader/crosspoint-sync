import { invoke } from '@tauri-apps/api/core'
import { ipcBytes } from './api.js'

export const listImports = () => invoke('list_imports')
export const removeImport = id => invoke('remove_import', { id })
export const addImport = async file => invoke('add_import', await ipcBytes(file), { headers: { 'x-name': encodeURIComponent(file.name) } })
export async function readImport(entry) {
  const bytes = await invoke('read_import', { id: entry.id })
  return new File([bytes instanceof ArrayBuffer ? bytes : new Uint8Array(bytes)], entry.name)
}

// One observer lives above the tabs. Native producers need no WebView to be
// running; startup and foreground checks discover their durable files as well.
export function watchImports(onIncoming, onError) {
  let live = true, busy = false, seen = new Set()
  const check = async () => {
    if (!live || busy || document.visibilityState === 'hidden') return
    busy = true
    try {
      const entries = await listImports()
      if (!live) return
      const incoming = entries.filter(e => !seen.has(e.id))
      const changed = incoming.length > 0 || entries.length !== seen.size
      seen = new Set(entries.map(e => e.id))
      if (changed) window.dispatchEvent(new Event('crosspoint-imports-changed'))
      if (incoming.length) onIncoming(incoming)
    } catch (error) { if (live) onError(error) }
    finally { busy = false }
  }
  const timer = setInterval(check, 1500)
  window.addEventListener('focus', check)
  document.addEventListener('visibilitychange', check)
  check()
  return () => {
    live = false
    clearInterval(timer)
    window.removeEventListener('focus', check)
    document.removeEventListener('visibilitychange', check)
  }
}
