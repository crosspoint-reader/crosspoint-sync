// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { installOrder } from './Plugins.jsx'

it('copies the files that make a folder a plugin last', () => {
  expect(installOrder(['manifest.json', 'device.json', 'README.md', 'icons/book.pbm', 'plugin.js'])).toEqual(['README.md', 'icons/book.pbm', 'manifest.json', 'device.json', 'plugin.js'])
})
