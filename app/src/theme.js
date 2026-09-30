import { useEffect, useState } from 'react'

// Appearance: 'system' | 'light' | 'dark', remembered on this device. index.html
// applies the same choice before first paint; keep the two in step.
const KEY = 'crosspoint-theme'
const PAGE = { light: '#fafaf9', dark: '#121110' }
const media = window.matchMedia('(prefers-color-scheme: dark)')

export function loadTheme() {
  try {
    return localStorage.getItem(KEY) || 'system'
  } catch {
    return 'system'
  }
}

const isDark = (pref) => pref === 'dark' || (pref === 'system' && media.matches)

export function applyTheme(pref) {
  const dark = isDark(pref)
  const root = document.documentElement
  root.dataset.theme = dark ? 'dark' : 'light'
  root.style.background = dark ? PAGE.dark : PAGE.light
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? PAGE.dark : PAGE.light)
  // Android: status/nav bars, WebView background and the next launch's splash.
  window.CrossPointTheme?.apply(pref, dark)
}

export function useTheme() {
  const [pref, setPref] = useState(loadTheme)
  useEffect(() => {
    applyTheme(pref)
    if (pref !== 'system') return
    const on = () => applyTheme('system')
    media.addEventListener('change', on)
    return () => media.removeEventListener('change', on)
  }, [pref])
  const set = (next) => {
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // this session only
    }
    setPref(next)
  }
  return [pref, set]
}
