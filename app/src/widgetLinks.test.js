import { expect, it } from 'vitest'
import { widgetRoute } from './widgetLinks.js'
it('accepts only widget destinations and does not intercept connector callbacks', () => {
  expect(widgetRoute('crosspointsync://widget/stats')).toBe('#/stats')
  expect(widgetRoute('crosspointsync://widget/settings/goals')).toBe('#/settings/goals')
  expect(widgetRoute('crosspointsync://widget/book/abc123')).toBe('#/book/abc123')
  expect(widgetRoute('crosspointsync://widget/book/goodreads.101')).toBe('#/book/goodreads.101')
  expect(widgetRoute('crosspointsync://widget/library')).toBe('#/')
  expect(widgetRoute('https://sync.test/connectors/spotify/callback')).toBeNull()
  expect(widgetRoute('crosspointsync://widget/book/../../settings')).toBeNull()
})
