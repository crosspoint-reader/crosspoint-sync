// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import ConversionLog from './ConversionLog.jsx'
import { createConversionLogger, transferProgress } from './epub/log.js'

afterEach(cleanup)

const logView = (entries) => <ConversionLog entries={entries}>{(details) => <p>Sent{details}</p>}</ConversionLog>

it('shows log text safely and keeps the expanded log open as entries arrive', () => {
  const entry = { elapsed: 0.5, tag: 'IMAGE', message: '<img src=x onerror=alert(1)>: 1200×1800 → 528×792' }
  const { container, rerender } = render(logView([entry]))
  const toggle = screen.getByRole('button', { name: 'Details' })
  const panel = container.querySelector('ol')
  expect(panel.hidden).toBe(true)
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.closest('p').textContent).toContain('Sent')
  expect(panel.parentElement).toBe(toggle.closest('p').parentElement)
  fireEvent.click(toggle)
  expect(container.querySelector('img')).toBeNull()
  expect(screen.getByText(/1200×1800/).textContent).toContain('<img src=x onerror=alert(1)>')
  rerender(logView([entry, { elapsed: 1, tag: 'SUMMARY', message: 'Saved 1 MB' }]))
  expect(panel.hidden).toBe(false)
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  expect(screen.getByText(/Saved 1 MB/)).toBeTruthy()
  fireEvent.click(toggle)
  expect(panel.hidden).toBe(true)
  rerender(logView([]))
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull()
  expect(container.querySelector('ol')).toBeNull()
})

it('keeps progress and per-book logs separate through upload and failure', () => {
  let job = { state: 'sending', logs: [] }
  job = transferProgress(job, { stage: 'optimizing', done: 30, total: 100 })
  job = transferProgress(job, { stage: 'optimizing', log: { tag: 'FIX', elapsed: 0, message: 'SVG cover' } })
  expect(job.progress.done).toBe(30)
  job = transferProgress(job, { stage: 'uploading' })
  job = { ...job, state: 'error', error: 'Reader disconnected' }
  expect(job.logs).toHaveLength(1)
  expect(transferProgress({ logs: [] }, { stage: 'uploading' }).logs).toEqual([])
  render(logView(job.logs))
  expect(screen.getByText(/SVG cover/)).toBeTruthy()
})

it('reports a size increase honestly and preserves special characters in filenames', () => {
  const entries = []
  const logger = createConversionLogger((entry) => entries.push(entry))
  logger.log(`<strong>${logger.escapeHtml('a <b> & c.epub')}</strong>`, '', 'INFO')
  logger.logFix('SVG cover', 'a <b> & c.xhtml')
  logger.logImage('cover.png', 1200, 1800, 'png', 100, 528, 792, 200)
  logger.logSummary(100, 200, 0.5)
  expect(entries[0].message).toBe('a <b> & c.epub')
  expect(entries[1].message).toBe('SVG cover: a <b> & c.xhtml')
  expect(entries.at(-1).message).toContain('Increased by 100.0 B')
  expect(entries.at(-1).message).toContain('1 image, 1 repair')
})
