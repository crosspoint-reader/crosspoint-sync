export function formatBytes(bytes) {
  if (!bytes) return '0 B'
  const unit = Math.min(3, Math.max(0, Math.floor(Math.log(Math.abs(bytes)) / Math.log(1024))))
  return `${(bytes / 1024 ** unit).toFixed(1)} ${['B', 'KB', 'MB', 'GB'][unit]}`
}

// The vendored optimizer supplies HTML-formatted messages. Emit only plain text;
// the app never inserts the reader page's markup into its UI.
export function createConversionLogger(onLog = () => {}) {
  const start = performance.now()
  let images = 0
  let fixes = 0
  const emit = (tag, message) => onLog({ tag, message, elapsed: (performance.now() - start) / 1000 })
  return {
    formatBytes,
    escapeHtml: (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    log(message, type, tag = 'INFO') {
      const text = new DOMParser().parseFromString(message, 'text/html').body.textContent
      emit(tag || 'INFO', text)
    },
    logImage(name, width, height, format, size, newWidth, newHeight, newSize) {
      images++
      emit('IMAGE', `${name}: ${format.toUpperCase()} ${width}×${height}, ${formatBytes(size)} → JPEG ${newWidth}×${newHeight}, ${formatBytes(newSize)}`)
    },
    logFix(type, detail) {
      fixes++
      // Some upstream details contain escaped filenames.
      const text = new DOMParser().parseFromString(String(detail).replace(/</g, '&lt;'), 'text/html').body.textContent
      emit('FIX', `${type}: ${text}`)
    },
    logSummary(originalSize, newSize, seconds) {
      const delta = originalSize - newSize
      const change = delta >= 0 ? `Saved ${formatBytes(delta)} (${originalSize ? (delta / originalSize * 100).toFixed(1) : '0.0'}%)` : `Increased by ${formatBytes(-delta)}`
      emit('SUMMARY', `${images} image${images === 1 ? '' : 's'}, ${fixes} repair${fixes === 1 ? '' : 's'}. ${formatBytes(originalSize)} → ${formatBytes(newSize)}. ${change}. ${seconds.toFixed(1)}s.`)
    },
    error: (message) => emit('ERROR', message),
  }
}

// Keep logs when ordinary progress, upload completion, or an error updates a job.
export function transferProgress(job, event) {
  if (event.log) return { ...job, logs: [...(job?.logs ?? []), event.log] }
  return { ...job, progress: event }
}
