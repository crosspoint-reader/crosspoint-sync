import { invoke } from '@tauri-apps/api/core'
import { http, isApp } from './api.js'

// Feeds the home screen widget: Android through MainActivity's CrossPointWidget
// bridge, iOS through the Rust update_widget command (App Group container).
let last = ''

async function coverBase64(url) {
  try {
    const res = await http(url)
    if (!res.ok) return ''
    const img = await createImageBitmap(await res.blob())
    // Widget-sized PNG: bitmaps cross IPC to the launcher and must stay small.
    const canvas = document.createElement('canvas')
    canvas.width = 168
    canvas.height = 252
    const ctx = canvas.getContext('2d')
    const s = Math.max(168 / img.width, 252 / img.height)
    ctx.drawImage(img, (168 - img.width * s) / 2, (252 - img.height * s) / 2, img.width * s, img.height * s)
    return canvas.toDataURL('image/png').split(',')[1]
  } catch {
    return ''
  }
}

export async function updateWidget({ books, summary, activity }) {
  if (!books || !(window.CrossPointWidget || isApp)) return
  const current = books.find((b) => b.status === 'reading')
  const year = new Date().getFullYear()
  const shown = new Set(books.map((b) => b.document))
  const finished = (activity?.books ?? []).filter((b) => shown.has(b.document) && b.finished_at && new Date(b.finished_at * 1000).getFullYear() === year).length
  const pages = (activity?.books ?? []).filter((b) => shown.has(b.document)).reduce((n, b) => n + (b.pages_read ?? 0), 0)
  const stats = summary?.devices?.length
    ? `${summary.current_streak}-day streak · ${Math.round(summary.seconds / 3600)}h read`
    : `${pages.toLocaleString()} pages · ${finished} finished this year`
  const data = current
    ? { label: 'CONTINUE READING', title: current.title || current.filename, author: current.author ?? '', percent: Math.round(current.percentage * 100), stats }
    : { label: 'CROSSPOINT SYNC', title: 'Nothing in progress', author: '', percent: -1, stats }
  const key = JSON.stringify([data, current?.cover_url])
  if (key === last) return
  last = key
  const cover = current?.cover_url ? await coverBase64(current.cover_url) : ''
  if (window.CrossPointWidget) window.CrossPointWidget.update(JSON.stringify(data), cover)
  else await invoke('update_widget', { json: JSON.stringify(data), cover }).catch(() => {})
}
