export function widgetRoute(raw) {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'crosspointsync:' || url.hostname !== 'widget') return null
    const path = url.pathname
    if (path === '/library') return '#/'
    if (path === '/stats') return '#/stats'
    if (path === '/settings/goals') return '#/settings/goals'
    if (/^\/book\/[a-zA-Z0-9._-]{1,64}$/.test(path)) return `#${path}`
  } catch { /* Ignore unrelated/malformed app links. */ }
  return null
}
