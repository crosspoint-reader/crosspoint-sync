export const IMPORT_EXTENSIONS = {
  books: ['epub', 'md', 'txt', 'acsm'],
  fonts: ['ttf', 'otf', 'cpfont'],
  wallpaper: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
}
export function importKind({ name }) {
  const ext = name.split('.').pop().toLowerCase()
  return Object.keys(IMPORT_EXTENSIONS).find(kind => IMPORT_EXTENSIONS[kind].includes(ext)) ?? null
}
export function importRoute(entries) {
  const kinds = new Set(entries.map(importKind).filter(Boolean))
  const kind = kinds.size === 1 ? [...kinds][0] : 'books'
  return kind === 'books' ? '#/send' : `#/send/${kind}`
}
