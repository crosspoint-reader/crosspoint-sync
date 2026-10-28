import { invoke } from '@tauri-apps/api/core'

// Keep native writes in order, especially a clear queued after an in-flight write.
let writes = Promise.resolve()
export function publishShortcuts(snapshot) {
  if (!('__TAURI_INTERNALS__' in window)) return
  const json = snapshot ? JSON.stringify(snapshot) : null
  writes = writes.catch(() => {}).then(() => invoke('update_shortcuts', { json }))
  // A native bridge failure must not break normal app use. The next publication retries.
  writes.catch((error) => console.warn('Could not update Shortcuts offline data', error))
}
