// Run after `npm run build --prefix app`, with the local sync server on port 8080:
// node app/scripts/test-timeline.mjs [evidence-directory]
// Uses a fresh, clearly labeled account, then deletes only that account in finally.
import { chromium, expect } from '@playwright/test'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const base = 'http://127.0.0.1:8080'
const evidence = resolve(process.argv[2] || '/tmp/crosspoint-timeline-test')
await mkdir(evidence, { recursive: true })
const username = `timeline-test-${randomBytes(6).toString('hex')}`
const key = randomBytes(16).toString('hex')
const headers = { 'content-type': 'application/json', 'x-auth-user': username, 'x-auth-key': key }
const at = (day, time = '10:00') => Date.parse(`2026-09-${day}T${time}:00Z`) / 1000
const fixtures = [
  { name: 'First day', points: [[27, '10:00', 0], [27, '11:00', .04], [27, '12:00', .09]] },
  { name: 'Finish day', points: [[26, '10:00', .1], [27, '10:00', .9], [27, '11:00', .99]] },
  { name: 'Nonzero baseline', points: [[27, '10:00', .09], [27, '11:00', .15]], dates: { start_date: '2026-09-27' } },
  { name: 'Idle start', points: [[27, '10:00', .09]], dates: { start_date: '2026-09-27' } },
  { name: 'Idle finish', points: [[27, '10:00', .99]] },
  { name: 'One day', points: [[27, '10:00', .01], [27, '11:00', .99]] },
  { name: 'Midnight boundary', points: [[27, '23:30', .01], [27, '23:31', .09]] },
].map(f => ({ ...f, document: createHash('md5').update(`${username}:${f.name}`).digest('hex'), title: `[TIMELINE TEST] ${f.name}` }))
const report = { server: base, username, fixtures, checks: [], cleaned: false }
async function request(path, method = 'GET', body, expected = 200) {
  const response = await fetch(base + path, { method, headers, ...(body && { body: JSON.stringify(body) }) })
  const text = await response.text()
  if (response.status !== expected) throw Error(`${method} ${path}: ${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}
let created = false
let browser
try {
  await request('/users/create', 'POST', { username, password: key }, 201)
  created = true
  for (const f of fixtures) {
    for (const [day, time, percentage] of f.points) {
      await request('/api/v1/progress', 'PUT', {
        document: f.document, progress: `test-${percentage}`, percentage,
        device: 'Timeline regression test', device_id: 'timeline-test', timestamp: at(day, time),
        metadata: { title: f.title, authors: 'Synthetic regression fixture' },
      })
    }
    if (f.dates) await request(`/api/v1/documents/${f.document}/dates`, 'PUT', f.dates)
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true })
  for (const timezoneId of ['UTC', 'Europe/Berlin', 'America/Los_Angeles']) {
    const context = await browser.newContext({ timezoneId, viewport: { width: 1100, height: 1000 } })
    await context.addInitScript(({ server, username, key }) => {
      localStorage.setItem('crosspoint-sync-session', JSON.stringify({ server, username, key }))
    }, { server: base, username, key })
    const page = await context.newPage()
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(`${base}/app/#/stats/timeline`)
    await expect(page.getByRole('heading', { name: 'How you read' })).toBeVisible()
    const card = (name) => page.locator(`ol a[href="#/book/${fixtures.find(f => f.name === name).document}"]`).filter({ hasText: `[TIMELINE TEST] ${name}` })
    const first = card('First day')
    await expect(first).toContainText('Started reading')
    await expect(first).toContainText('Read 0% to 9%')
    await expect(card('Finish day').filter({ hasText: 'Finished' })).toContainText('Read 10% to 99%')
    await expect(card('Nonzero baseline')).toContainText('Started reading')
    await expect(card('Nonzero baseline')).toContainText('Read 9% to 15%')
    await expect(card('Nonzero baseline')).not.toContainText('0% to')
    await expect(card('Idle start')).toContainText('Started reading')
    await expect(card('Idle start')).not.toContainText('Read ')
    await expect(card('Idle finish')).toContainText('Finished')
    await expect(card('Idle finish')).not.toContainText('Read ')
    await expect(card('One day')).toContainText('Started reading · Finished')
    await expect(card('One day')).toContainText('Read 1% to 99%')
    const midnight = card('Midnight boundary')
    await expect(midnight).toContainText('Started reading')
    await expect(midnight).toContainText('Read 1% to 9%')
    await expect(midnight.locator('xpath=ancestor::li')).toContainText(timezoneId === 'Europe/Berlin' ? 'Mon, Sep 28' : 'Sun, Sep 27')
    expect(errors).toEqual([])
    const offset = await page.evaluate(() => new Date('2026-09-27T23:30:00Z').getTimezoneOffset())
    const activity = await request(`/api/v1/stats/activity?tz=${offset}`)
    await writeFile(resolve(evidence, `${timezoneId.replaceAll('/', '-')}-activity.json`), JSON.stringify(activity, null, 2))
    if (timezoneId === 'UTC') {
      await page.screenshot({ path: resolve(evidence, 'timeline-desktop.png'), fullPage: true })
      await page.setViewportSize({ width: 390, height: 844 })
      await expect(first.getByText('Read 0% to 9%', { exact: true })).toBeVisible()
      await expect(card('One day').getByText('Started reading · Finished', { exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.screenshot({ path: resolve(evidence, 'timeline-mobile.png'), fullPage: true })
    }
    report.checks.push({ timezoneId, passed: true, browserErrors: errors })
    await context.close()
  }
} finally {
  if (browser) await browser.close()
  if (created) {
    await request('/api/v1/account', 'DELETE')
    const res = await fetch(`${base}/api/v1/me`, { headers })
    expect(res.ok).toBe(false)
    report.cleaned = true
  }
  await writeFile(resolve(evidence, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ username, checks: report.checks, cleaned: report.cleaned, evidence }, null, 2))
}
