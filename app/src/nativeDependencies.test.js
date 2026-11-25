import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const packageLock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
const cargoToml = readFileSync(new URL('../src-tauri/Cargo.toml', import.meta.url), 'utf8')
const cargoLock = readFileSync(new URL('../src-tauri/Cargo.lock', import.meta.url), 'utf8')

const packageName = '@sosweetham/tauri-plugin-system-components-api'
const topInsetRegressionRevision = '348476a5bd4ff19c95a944d9a5d93bf403d4e07b'

it('keeps the native navigation pins together and off the top inset regression revision', () => {
  const spec = packageJson.dependencies[packageName]
  const revision = spec.match(/#([0-9a-f]{40})$/)?.[1]
  expect(revision).toMatch(/^[0-9a-f]{40}$/)
  expect(revision).not.toBe(topInsetRegressionRevision)

  expect(packageLock.packages[''].dependencies[packageName]).toBe(spec)
  expect(packageLock.packages[`node_modules/${packageName}`].resolved).toContain(`#${revision}`)
  expect(cargoToml).toContain(`rev = "${revision}"`)
  const cargoLockPackage = cargoLock.match(/\[\[package\]\]\nname = "tauri-plugin-system-components"\n[\s\S]*?(?=\n\[\[package\]\])/)?.[0]
  expect(cargoLockPackage).toContain(`?rev=${revision}#${revision}`)
})
