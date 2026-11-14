import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
import { initializeNavigation } from './tabbar.js'
// Fonts ship with the app (Android's WebView couldn't load them from Google Fonts).
import '@fontsource-variable/inter'
import '@fontsource/lora/400.css'
import '@fontsource/lora/400-italic.css'
import '@fontsource/lora/600.css'
import '@fontsource/caveat/500.css'
import '@fontsource/geist-mono/400.css'
import '@fontsource/geist-mono/500.css'
import './index.css'

// Keep the field being typed into visible once the on-screen keyboard has opened
// (Android resizes the window via adjustResize; this centres the field in what's left).
// A search field goes to the top instead, leaving the room below for its results.
document.addEventListener('focusin', (e) => {
  if (e.target.matches('input:not([type=range]), textarea, select')) {
    setTimeout(() => e.target.scrollIntoView({ block: e.target.type === 'search' ? 'start' : 'center', behavior: 'smooth' }), 300)
  }
})

// The native apps keep the scroll bounce: their pull-to-refresh needs it.
if (!('__TAURI_INTERNALS__' in window)) document.documentElement.classList.add('in-browser')

initializeNavigation().then(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <App />
    </StrictMode>
  )

  // Android keeps the system splash up until the app has painted its first frame.
  requestAnimationFrame(() => requestAnimationFrame(() => window.CrossPointTheme?.ready?.()))
})
