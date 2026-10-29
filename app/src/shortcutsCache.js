import { invoke } from '@tauri-apps/api/core'

// iPadOS can use a desktop-style user agent; touch support distinguishes it
// from macOS. Browser sessions must also have Tauri's native bridge.
export function supportsShortcuts() {
  return '__TAURI_INTERNALS__' in window && (
    /iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (/Macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1)
  )
}

// Keep native writes in order, especially a clear queued after an in-flight write.
let writes = Promise.resolve()
export function publishShortcuts(snapshot) {
  if (!supportsShortcuts()) return
  const json = snapshot ? JSON.stringify(snapshot) : null
  writes = writes.catch(() => {}).then(() => invoke('update_shortcuts', { json }))
  // A native bridge failure must not break normal app use. The next publication retries.
  writes.catch((error) => console.warn('Could not update Shortcuts offline data', error))
  return writes
}
