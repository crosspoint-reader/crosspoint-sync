import { decodeHistory, hasReadingTime, localDay, longestReadingStreak, readingStreak } from './readingHistory.js'
import { invoke } from '@tauri-apps/api/core'
import { cached, isApp } from './api.js'
import { coverBlob } from './coverCache.js'

// Feeds the home screen widget: Android through MainActivity's CrossPointWidget
// bridge, iOS through the Rust update_widget command (App Group container).
let last = ''
let version = 0

async function publish(data, cover) {
  if (window.CrossPointWidget) window.CrossPointWidget.update(JSON.stringify(data), cover)
  else if (isApp) await invoke('update_widget', { json: JSON.stringify(data), cover }).catch(() => {})
}

export function clearWidget() {
  version++
  last = ''
  return publish({ label: 'CROSSPOINT SYNC', title: 'Sign in to see your reading', author: '', percent: -1, stats: '' }, '')
}

async function coverBase64(url) {
  try {
    const img = await createImageBitmap(await coverBlob(url))
    // Widget-sized PNG: bitmaps cross IPC to the launcher and must stay small.
    const canvas = document.createElement('canvas')
    canvas.width = 168
    canvas.height = 252
    const ctx = canvas.getContext('2d')
    const s = Math.max(168 / img.width, 252 / img.height)
    ctx.drawImage(img, (168 - img.width * s) / 2, (252 - img.height * s) / 2, img.width * s, img.height * s)
    const cover = canvas.toDataURL('image/png').split(',')[1]
    img.close()
    return cover
  } catch {
    return ''
  }
}

// The session goes along so the widget can refresh from the server on its own
// (CrossPointWidget.swift, ReadingWidget.kt); signing out clears it.
export async function updateWidget({ session, books, summary, activity, goals }) {
  if (!books || !(window.CrossPointWidget || isApp)) return
  const current = books.find((b) => b.status === 'reading')
  const year = new Date().getFullYear()
  const shown = new Set(books.map((b) => b.document))
  const finished = (activity?.books ?? []).filter((b) => shown.has(b.document) && b.finished_at && new Date(b.finished_at * 1000).getFullYear() === year).length
  const pages = (activity?.books ?? []).filter((b) => shown.has(b.document)).reduce((n, b) => n + (b.pages_read ?? 0), 0)
  const stats = hasReadingTime(summary)
    ? `${readingStreak(summary, activity)}-day streak · ${Math.round(summary.seconds / 3600)}h read`
    : `${pages.toLocaleString()} pages · ${finished} finished this year`
  const data = current
    ? { label: 'CONTINUE READING', title: current.title || current.filename || 'Untitled book', author: current.author ?? '', percent: Math.round(current.percentage * 100), stats }
    : { label: 'CROSSPOINT SYNC', title: 'Nothing in progress', author: '', percent: -1, stats }
  const today = localDay(new Date())
  const dates = new Set(activity?.reading_days ?? [])
  if (summary?.anchor_day > 0 && summary.history_b64) {
    const { read, anchor, length } = decodeHistory(summary.history_b64, summary.anchor_day)
    for (let n = 0; n < length; n++) if (read(n)) dates.add(new Date(anchor.getTime() - n * 86400000).toISOString().slice(0, 10))
  }
  data.history_days = [...dates].filter(d => d <= today).sort()
  data.history_known = Array.isArray(activity?.reading_days) || (summary?.anchor_day > 0 && !!summary.history_b64) || Number.isFinite(summary?.current_streak)
  data.current_streak = readingStreak(summary, activity)
  data.longest_streak = Math.max(summary?.streak ?? 0, longestReadingStreak(summary, activity))
  data.goal = goals?.goals?.find(g => g.year === year) ?? null
  data.goals = goals?.goals ?? []
  data.recent_finished = data.goal ? goals?.recent_finished ?? [] : []
  data.recent_finished_year = goals?.year ?? null
  data.goal_supported = goals ? true : null
  data.book_document = current?.document ?? null
  data.pages_read = pages
  data.finished_this_year = finished
  // Stable through duplicate app renders; native providers use it for freshness.
  data.snapshot_day = today
  if (session) data.session = { server: session.server, username: session.username, key: session.key }
  data.cover_url = current?.cover_url ?? (session && current ? cached.cover(session, current.document) : null) ?? null
  const key = JSON.stringify(data)
  if (key === last) return
  last = key
  const currentVersion = ++version
  const cover = data.cover_url ? await coverBase64(data.cover_url) : ''
  if (currentVersion === version) {
    await publish(data, cover)
    // A failed download must be retried even when reading data hasn't changed.
    if (data.cover_url && !cover) last = ''
  }
}
