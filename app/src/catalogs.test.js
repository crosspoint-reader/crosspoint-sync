// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import { image, moveCatalog, needsAuthedImage, storedCover } from './catalogs.js'

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }))

it('moves a catalog to where another one is', () => {
  const list = ['a', 'b', 'c', 'd'].map((id) => ({ id }))
  const ids = (l) => l.map((c) => c.id).join('')
  expect(ids(moveCatalog(list, 'a', 'c'))).toBe('bcad') // down
  expect(ids(moveCatalog(list, 'd', 'b'))).toBe('adbc') // up
  expect(ids(list)).toBe('abcd') // untouched
})

it('fetches covers through the app only for catalogs behind a login', () => {
  const open = { auth: { kind: 'none' } }
  const basic = { auth: { kind: 'basic', username: 'u', password: 'p' } }
  expect(needsAuthedImage(open, 'https://x.org/c.jpg')).toBe(false)
  expect(needsAuthedImage({}, 'https://x.org/c.jpg')).toBe(false)
  expect(needsAuthedImage(basic, 'https://x.org/c.jpg')).toBe(true)
  expect(needsAuthedImage(basic, 'data:image/png;base64,AAAA')).toBe(false)
  expect(needsAuthedImage(basic, undefined)).toBe(false)
})

it('fetches a cover once with the catalog credentials', async () => {
  invoke.mockResolvedValue('data:image/jpeg;base64,AAAA')
  const cat = { auth: { kind: 'basic', username: 'u', password: 'p' } }
  expect(await image(cat, 'https://x.org/opds/cover/1')).toBe('data:image/jpeg;base64,AAAA')
  await image(cat, 'https://x.org/opds/cover/1')
  expect(invoke).toHaveBeenCalledTimes(1)
  expect(invoke).toHaveBeenCalledWith('opds_image', { url: 'https://x.org/opds/cover/1', auth: cat.auth })
})

it('keeps a public cover URL as is with a download, and drops a login-only one it cannot fetch', async () => {
  expect(await storedCover({ auth: { kind: 'none' } }, 'https://x.org/c.jpg')).toBe('https://x.org/c.jpg')
  expect(await storedCover({ auth: { kind: 'none' } }, undefined)).toBe(null)
  invoke.mockRejectedValueOnce('401')
  expect(await storedCover({ auth: { kind: 'bearer', token: 't' } }, 'https://x.org/opds/cover/2')).toBe(null)
})
