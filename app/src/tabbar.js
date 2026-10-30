import { useEffect, useRef } from 'react'
import {
  configureTabBar,
  createComponent,
  hideTabBar,
  onComponentEvent,
  onTabSelected,
  onTabBarLayoutChanged,
  removeComponent,
  removeTabBar,
  selectTab,
  showTabBar,
} from '@sosweetham/tauri-plugin-system-components-api'
import { invoke } from '@tauri-apps/api/core'
import { isApp } from './api.js'

// Resolve before React mounts; older iPhones keep the same HTML controls as Android.
export let nativeTabBar = false
let ready = false
export async function initializeNavigation() {
  if (isApp && /iPhone/.test(navigator.userAgent)) {
    nativeTabBar = await invoke('supports_native_chrome').catch(() => false)
  }
  document.documentElement.classList.toggle('native-chrome', nativeTabBar)
}

let sheets = 0
const sync = () => {
  // The page behind an open sheet stays put: CSS for the web and Android's scroll,
  // the native scroll view on iOS (its bounce and pull-to-refresh ignore the CSS),
  // and Android's pull-to-refresh (see MainActivity).
  const open = sheets > 0
  document.documentElement.style.overflow = open ? 'hidden' : ''
  if (isApp) invoke('set_page_scroll', { enabled: !open }).catch(() => {})
  window.CrossPointRefresh?.setEnabled(!open)
  if (!nativeTabBar) return
  const hidden = sheets > 0
  ;(hidden ? hideTabBar() : showTabBar()).catch(() => {})
  syncButtons(!hidden)
}

// UIKit places actions in the top navigation bar or Duo’s vertical rail.
// Components have no hide, so they are removed and recreated around sheets.
const buttons = new Map() // id -> { sfSymbol, anchor, click, shown }
let listening = false
function syncButtons(show) {
  if (!ready) return
  for (const [id, b] of buttons) {
    if (show && !b.shown) {
      b.shown = true
      const props = { sfSymbol: b.sfSymbol, label: b.label }
      createComponent({ id, kind: 'button', navigation: b.anchor === 'topLeading' ? 'leading' : 'trailing', props }).catch(() => {})
    } else if (!show && b.shown) {
      b.shown = false
      removeComponent(id).catch(() => {})
    }
  }
}

export function useNativeButton(id, { sfSymbol, anchor, label = id }, onClick) {
  const click = useRef(onClick)
  click.current = onClick
  useEffect(() => {
    if (!nativeTabBar) return
    if (!listening) {
      listening = true
      onComponentEvent((e) => e.event === 'click' && buttons.get(e.id)?.click()).catch(() => {})
    }
    buttons.set(id, { sfSymbol, anchor, label, click: () => click.current(), shown: false })
    syncButtons(sheets === 0)
    return () => {
      if (buttons.get(id)?.shown) removeComponent(id).catch(() => {})
      buttons.delete(id)
    }
  }, [id, sfSymbol, anchor, label])
}

// to: a hash, or a function (e.g. history.back).
export const useNativeBack = (to) =>
  useNativeButton('back', { sfSymbol: 'chevron.backward', anchor: 'topLeading', label: 'Back' }, () =>
    typeof to === 'function' ? to() : (location.hash = to)
  )

// items: [{ id, title, sfSymbol }]; ids are hashes. Returns the unmount cleanup.
export function mountTabBar(items, selectedId) {
  let live = true
  let listener
  let layoutListener
  onTabBarLayoutChanged((insets) => {
    if (!live) return
    for (const edge of ['top', 'right', 'bottom', 'left']) {
      document.documentElement.style.setProperty(`--native-inset-${edge}`, `${insets[edge]}px`)
    }
  }).then(async (subscription) => {
    if (!live) { subscription.unregister(); return }
    layoutListener = subscription
    await configureTabBar({ items, selectedId, tint: '#4a7a62', layout: 'adaptive' })
    if (!live) return
    ready = true
    document.documentElement.classList.add('native-adaptive')
    sync()
  }).catch(() => {})
  // replace, not push: switching tabs isn't a step the back swipe should undo.
  onTabSelected(({ id }) => location.replace(id)).then((l) => (live ? (listener = l) : l.unregister()), () => {})
  return () => {
    live = false
    listener?.unregister()
    layoutListener?.unregister()
    ready = false
    for (const b of buttons.values()) b.shown = false
    document.documentElement.classList.remove('native-adaptive')
    for (const edge of ['top', 'right', 'bottom', 'left']) document.documentElement.style.removeProperty(`--native-inset-${edge}`)
    removeTabBar().catch(() => {})
  }
}

export const selectNativeTab = (id) => selectTab(id).catch(() => {})

// Call in any full-screen sheet: the native bar and buttons step aside, and
// pull-to-refresh pauses.
export function useSheet() {
  useEffect(() => {
    sheets++
    sync()
    return () => {
      sheets--
      sync()
    }
  }, [])
}
