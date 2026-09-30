import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App.jsx'
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
document.addEventListener('focusin', (e) => {
  if (e.target.matches('input:not([type=range]), textarea, select')) {
    setTimeout(() => e.target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300)
  }
})

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>
)

// Android keeps the system splash up until the app has painted its first frame.
requestAnimationFrame(() => requestAnimationFrame(() => window.CrossPointTheme?.ready?.()))
