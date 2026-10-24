// Match the reader web UI's normal mode. Advanced crop/split/rotation stay off.
export const DEVICE_PROFILES = {
  X4: { width: 480, height: 800 },
  X3: { width: 528, height: 792 },
}
export const DEFAULT_QUALITY = 85

// Avoid inflating several books and allocating their canvases at once on phones.
let pending = Promise.resolve()

export function optimizeEpub(file, { device, quality = DEFAULT_QUALITY, onProgress = () => {}, signal } = {}) {
  const run = pending.then(async () => {
    signal?.throwIfAborted()
    const { convertEpub } = await import('./vendor/optimizer.js')
    const profile = DEVICE_PROFILES[device] ?? DEVICE_PROFILES.X4
    const value = Number(quality)
    const options = { ...profile, quality: Number.isFinite(value) ? Math.max(1, Math.min(95, Math.round(value))) : DEFAULT_QUALITY }
    onProgress({ stage: 'optimizing', done: 0, total: 100 })
    const blob = await convertEpub(file, options, (done) => onProgress({ stage: 'optimizing', done, total: 100 }), signal,
      (log) => onProgress({ stage: 'optimizing', log }))
    return new File([blob], file.name, { type: 'application/epub+zip', lastModified: file.lastModified })
  })
  pending = run.catch(() => {})
  return run
}
