// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
const env = vi.hoisted(() => ({ isApp: true }))
vi.mock('./api.js', () => ({ get isApp() { return env.isApp } }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@sosweetham/tauri-plugin-system-components-api', () => ({
  configureTabBar: vi.fn(), onTabSelected: vi.fn(), onTabBarLayoutChanged: vi.fn(),
  showTabBar: vi.fn(), hideTabBar: vi.fn(), removeTabBar: vi.fn(),
  createComponent: vi.fn(), removeComponent: vi.fn(), onComponentEvent: vi.fn(),
}))
import * as native from '@sosweetham/tauri-plugin-system-components-api'
import { invoke } from '@tauri-apps/api/core'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  document.documentElement.classList.remove('native-chrome')
})

it.each([
  ['older iPhone', true, 'iPhone OS 18_6', false, false],
  ['iOS 26 with compatibility user agent', true, 'iPhone OS 18_6', true, true],
  ['iPhone browser', false, 'iPhone OS 26_0', true, false],
  ['Android app', true, 'Android', true, false],
  ['iPad app', true, 'iPad OS 26_0', true, false],
])('%s chooses the appropriate navigation', async (_, isApp, ua, supported, expected) => {
  vi.resetModules()
  env.isApp = isApp
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua)
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })))
  invoke.mockResolvedValue(supported)
  const nav = await import('./tabbar.js')
  await nav.initializeNavigation()
  expect(nav.nativeTabBar).toBe(expected)
  expect(document.documentElement.classList.contains('native-chrome')).toBe(expected)
  if (isApp && ua.includes('iPhone')) expect(invoke).toHaveBeenCalledWith('supports_native_chrome')
  else expect(invoke).not.toHaveBeenCalled()
})

it('keeps HTML controls visible when native capability detection fails', async () => {
  vi.resetModules()
  env.isApp = true
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone OS 26_0')
  invoke.mockRejectedValue(new Error('Native command unavailable'))
  const nav = await import('./tabbar.js')
  await nav.initializeNavigation()
  expect(nav.nativeTabBar).toBe(false)
  expect(document.documentElement.classList.contains('native-chrome')).toBe(false)
})

it('uses adaptive tabs, tracks side insets, and routes the native back button', async () => {
  vi.resetModules()
  env.isApp = true
  invoke.mockResolvedValue(true)
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('iPhone')
  for (const name of ['configureTabBar', 'showTabBar', 'hideTabBar', 'removeTabBar', 'createComponent', 'removeComponent']) native[name].mockResolvedValue()
  const unregister = vi.fn()
  native.onTabSelected.mockResolvedValue({ unregister })
  native.onTabBarLayoutChanged.mockResolvedValue({ unregister })
  native.onComponentEvent.mockResolvedValue({ unregister })
  const nav = await import('./tabbar.js')
  await nav.initializeNavigation()
  const onBack = vi.fn()
  const back = renderHook(() => nav.useNativeBack(onBack))
  expect(native.createComponent).not.toHaveBeenCalled()
  const items = [{ id: '#/', title: 'Library', sfSymbol: 'books.vertical' }]
  const unmount = nav.mountTabBar(items, '#/')
  await vi.waitFor(() => expect(native.createComponent).toHaveBeenCalledWith({
    id: 'back', kind: 'button', navigation: 'leading', props: { label: 'Back', sfSymbol: 'chevron.backward' },
  }))
  expect(native.configureTabBar).toHaveBeenCalledWith({ items, selectedId: '#/', tint: '#4a7a62', layout: 'adaptive' })
  expect(document.documentElement.classList.contains('native-adaptive')).toBe(true)
  act(() => native.onTabBarLayoutChanged.mock.calls[0][0]({ top: 0, right: 84, bottom: 0, left: 0 }))
  expect(document.documentElement.style.getPropertyValue('--native-inset-right')).toBe('84px')
  act(() => native.onComponentEvent.mock.calls[0][0]({ id: 'back', event: 'click' }))
  expect(onBack).toHaveBeenCalledOnce()
  const sheet = renderHook(() => nav.useSheet())
  expect(native.hideTabBar).toHaveBeenCalled()
  expect(native.removeComponent).toHaveBeenCalledWith('back')
  sheet.unmount()
  expect(native.createComponent).toHaveBeenCalledTimes(2)
  back.unmount()
  unmount()
  expect(unregister).toHaveBeenCalledTimes(2)
  expect(document.documentElement.style.getPropertyValue('--native-inset-right')).toBe('')
  expect(document.documentElement.classList.contains('native-adaptive')).toBe(false)
})
