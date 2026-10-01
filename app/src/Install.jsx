import { useEffect, useState } from 'react'
import { Plus, Share, X } from 'lucide-react'
import { isApp } from './api.js'

// "Add to Home Screen" for the web version on phones. Chrome/Edge/Samsung on
// Android hand us an install prompt to fire on tap; iOS has no API, so we show
// the two taps it takes in Safari. Hidden once installed or dismissed.
const KEY = 'crosspoint-install-dismissed'
const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
const installed = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true
const phone = matchMedia('(pointer: coarse)').matches

// The event can fire before React mounts; keep it.
let deferred = null
const ready = new EventTarget()
if (!isApp) {
  addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault()
    deferred = e
    ready.dispatchEvent(new Event('ready'))
  })
  addEventListener('appinstalled', () => {
    deferred = null
    ready.dispatchEvent(new Event('ready'))
  })
}

function dismissed() {
  try {
    return !!localStorage.getItem(KEY)
  } catch {
    return false
  }
}

export default function InstallPrompt() {
  const [, rerender] = useState(0)
  const [hidden, setHidden] = useState(dismissed)
  useEffect(() => {
    const on = () => rerender((n) => n + 1)
    ready.addEventListener('ready', on)
    return () => ready.removeEventListener('ready', on)
  }, [])

  if (isApp || !phone || hidden || installed() || (!deferred && !ios)) return null

  const close = () => {
    try {
      localStorage.setItem(KEY, '1')
    } catch {
      // this session only
    }
    setHidden(true)
  }
  const install = async () => {
    deferred.prompt()
    const { outcome } = await deferred.userChoice
    deferred = null
    if (outcome === 'accepted') setHidden(true)
    else rerender((n) => n + 1)
  }

  return (
    <div className="fixed inset-x-0 bottom-[calc(4.75rem+env(safe-area-inset-bottom))] z-40 px-3 md:bottom-6 md:pl-60 lg:pl-64">
      <div className="mx-auto flex max-w-xl items-center gap-3 rounded-xl bg-surface p-3 shadow-lg ring-1 ring-stone-950/10">
        <img src={`${import.meta.env.BASE_URL}icon-192.png`} alt="" className="size-11 shrink-0 rounded-xl" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-stone-900">Get the app</p>
          {deferred ? (
            <p className="text-xs text-stone-500">Add CrossPoint Sync to your home screen.</p>
          ) : (
            <p className="text-xs/5 text-stone-500">
              Tap <Share className="inline size-3.5 -translate-y-px text-brand-600" aria-label="Share" /> then{' '}
              <span className="font-medium whitespace-nowrap text-stone-700">
                Add to Home Screen <Plus className="inline size-3.5 -translate-y-px rounded-sm ring-1 ring-stone-400" />
              </span>
            </p>
          )}
        </div>
        {deferred && (
          <button type="button" onClick={install} className="h-9 shrink-0 rounded-full bg-brand-500 px-4 text-sm font-semibold text-white active:scale-[0.98]">
            Install
          </button>
        )}
        <button type="button" onClick={close} aria-label="Not now" className="-mr-1 grid size-9 shrink-0 place-items-center rounded-full text-stone-400 active:bg-stone-100">
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
}
