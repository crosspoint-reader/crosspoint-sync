import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

test.beforeEach(async ({ page }) => {
  await page.goto('/tests/optimizer.html')
  await page.waitForFunction(() => window.optimizerTest)
})

for (const [device, width, height] of [['X3', 528, 792], ['X4', 480, 720]]) {
  test(`optimizes a complete EPUB for ${device}`, async ({ page }) => {
    const result = await page.evaluate(async (device) => {
      const { optimizeEpub, fixture, inspect } = window.optimizerTest
      const file = await fixture()
      const progress = []
      const output = await optimizeEpub(file, { device, onProgress: (p) => progress.push(p) })
      return { ...(await inspect(output)), name: output.name, lastModified: output.lastModified, progress }
    }, device)
    expect(result.name).toBe('Original name.epub')
    expect(result.lastModified).toBe(123456)
    expect([result.width, result.height]).toEqual([width, height])
    expect(result.color[0]).toBe(result.color[1])
    expect(result.color[1]).toBe(result.color[2])
    expect(result.white).toEqual([255, 255, 255, 255])
    expect(result.firstEntry).toBe('mimetype')
    expect(result.firstCompression).toBe(0)
    expect(result.contents['OPS/fonts/body.ttf']).toBeUndefined()
    expect(result.contents['META-INF/encryption.xml']).toBeUndefined()
    expect(result.contents['OPS/images/cover.png']).toBeUndefined()
    const xhtml = result.contents['OPS/text/page.xhtml']
    expect(xhtml).toContain('../images/cover.jpg')
    expect(xhtml).toContain('Readable text stays here.')
    expect(xhtml).not.toMatch(/<svg\b|<image\b|@font-face|<!--|width="1200"/)
    expect(xhtml).toContain('overflow-wrap:break-word')
    expect(result.contents['OPS/text/cover.xhtml']).toContain('../images/cover.jpg')
    expect(result.contents['OPS/text/cover.xhtml']).not.toMatch(/<svg\b|<image\b/)
    expect(result.contents['OPS/styles/book.css']).not.toContain('@font-face')
    expect(result.contents['OPS/styles/book.css']).toContain('../images/cover.jpg')
    expect(result.contents['OPS/content.opf']).toContain('image/jpeg')
    expect(result.contents['OPS/content.opf']).not.toMatch(/body\.ttf|properties="svg"/)
    expect(result.contents['OPS/toc.ncx']).toContain('urn:test:book')
    expect(result.progress[0]).toEqual({ stage: 'optimizing', done: 0, total: 100 })
    expect(result.progress.filter((p) => !p.log).at(-1).done).toBe(100)
    const logs = result.progress.filter((p) => p.log).map((p) => p.log)
    expect(logs.find((entry) => entry.tag === 'IMAGE').message).toContain(`1200×1800`)
    expect(logs.find((entry) => entry.tag === 'IMAGE').message).toContain(`${width}×${height}`)
    expect(logs.some((entry) => entry.tag === 'FIX' && entry.message.includes('SVG cover'))).toBe(true)
    expect(logs.some((entry) => entry.tag === 'REMOVE' && entry.message.includes('body.ttf'))).toBe(true)
    expect(logs.at(-1).tag).toBe('SUMMARY')
    expect(logs.at(-1).message).toContain('1 image')
    expect(logs.every((entry) => entry.elapsed >= 0)).toBe(true)
  })
}

test('rejects unsafe conversions and recovers for the next book', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { optimizeEpub, fixture } = window.optimizerTest
    const errors = []
    const logs = []
    for (const options of [{ corruptImage: true }, { multipleOpfs: true }, { collision: true }]) {
      try { await optimizeEpub(await fixture(options), { onProgress: (p) => { if (p.log) logs.push(p.log) } }) } catch (error) { errors.push(error.message) }
    }
    const next = await optimizeEpub(await fixture())
    return { errors, logs, size: next.size }
  })
  expect(result.errors).toHaveLength(3)
  expect(result.errors[0]).toContain('Could not optimize image')
  expect(result.errors[1]).toContain('one package document')
  expect(result.errors[2]).toContain('overwrite each other')
  expect(result.logs.filter((entry) => entry.tag === 'ERROR').map((entry) => entry.message)).toEqual(result.errors)
  expect(result.size).toBeGreaterThan(0)
})

test('cancellation does not upload a partial result or poison the queue', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { optimizeEpub, fixture } = window.optimizerTest
    const file = await fixture()
    const controller = new AbortController()
    let cancelled = false
    try {
      await optimizeEpub(file, { signal: controller.signal, onProgress: (p) => { if (p.done > 0) controller.abort() } })
    } catch { cancelled = true }
    return { cancelled, nextSize: (await optimizeEpub(file)).size }
  })
  expect(result.cancelled).toBe(true)
  expect(result.nextSize).toBeGreaterThan(0)
})

test('canvas failures reject instead of leaving conversion pending', async ({ page }) => {
  const error = await page.evaluate(async () => {
    const { optimizeEpub, fixture } = window.optimizerTest
    const file = await fixture()
    const original = HTMLCanvasElement.prototype.toBlob
    HTMLCanvasElement.prototype.toBlob = (callback) => callback(null)
    try {
      await optimizeEpub(file)
      return null
    } catch (error) { return error.message } finally { HTMLCanvasElement.prototype.toBlob = original }
  })
  expect(error).toContain('Could not optimize image')
})

test('concurrent conversions keep their device and quality settings', async ({ page }) => {
  const results = await page.evaluate(async () => {
    const { convertEpub, fixture, inspect } = window.optimizerTest
    const file = await fixture()
    return Promise.all([
      convertEpub(file, { width: 528, height: 792, quality: 85 }).then(inspect),
      convertEpub(file, { width: 480, height: 800, quality: 30 }).then(inspect),
    ])
  })
  expect(results.map((r) => [r.width, r.height])).toEqual([[528, 792], [480, 720]])
  expect(results[0].contents['OPS/images/cover.jpg']).not.toBe(results[1].contents['OPS/images/cover.jpg'])
})

test('matches the pinned reader optimizer in the same browser', async ({ page, context }) => {
  test.skip(!process.env.CROSSPOINT_READER_REPO, 'Set CROSSPOINT_READER_REPO to compare with the pinned reader source.')
  const revision = 'facaa87e379a499855e5980edd47beba4d01c884'
  const html = execFileSync('git', ['-C', process.env.CROSSPOINT_READER_REPO, 'show', `${revision}:src/network/html/FilesPage.html`], { encoding: 'utf8' })
  const jszip = readFileSync(new URL('../node_modules/jszip/dist/jszip.min.js', import.meta.url), 'utf8')
  const upstream = await context.newPage()
  await upstream.route('http://reader.test/**', (route) => {
    const url = new URL(route.request().url())
    if (url.pathname === '/files') return route.fulfill({ contentType: 'text/html', body: html })
    if (url.pathname === '/js/jszip.min.js') return route.fulfill({ contentType: 'text/javascript', body: jszip })
    return route.fulfill({ contentType: 'application/json', body: url.pathname === '/api/status' ? '{"device":"X3"}' : '[]' })
  })
  await upstream.goto('http://reader.test/files')
  const input = await page.evaluate(async () => [...new Uint8Array(await (await window.optimizerTest.fixture()).arrayBuffer())])
  const reference = await upstream.evaluate(async (bytes) => {
    MAX_WIDTH = 528
    MAX_HEIGHT = 792
    JPEG_QUALITY = 85
    ENABLE_GRAYSCALE = true
    ENABLE_AUTO_CROP = false
    const file = new File([new Uint8Array(bytes)], 'Original name.epub')
    const blob = await convertEpubFile(file)
    const zip = await JSZip.loadAsync(blob)
    const contents = {}
    for (const [path, entry] of Object.entries(zip.files)) {
      if (!entry.dir) contents[path] = path.endsWith('.jpg') ? await entry.async('base64') : await entry.async('string')
    }
    return contents
  }, input)
  const actual = await page.evaluate(async (bytes) => {
    const { optimizeEpub, inspect } = window.optimizerTest
    return (await inspect(await optimizeEpub(new File([new Uint8Array(bytes)], 'Original name.epub'), { device: 'X3' }))).contents
  }, input)
  expect(actual).toEqual(reference)
  await upstream.close()
})
