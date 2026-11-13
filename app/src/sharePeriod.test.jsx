// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { sharePeriod } from './Stats.jsx'

it('builds week, month and year share periods up to today', () => {
  const now = new Date(2026, 9, 10, 9) // Saturday, Oct 10 2026
  const week = sharePeriod('week', now)
  expect([week.from, week.to, week.slots.length, week.chartLabel]).toEqual(['2026-10-05', '2026-10-10', 7, 'PAGES PER DAY'])
  expect(week.slots.findIndex((s) => s.current)).toBe(5)

  const month = sharePeriod('month', now)
  expect([month.from, month.name, month.slots.length]).toEqual(['2026-10-01', 'October', 31])

  const year = sharePeriod('year', now)
  expect([year.from, year.name, year.slots.length, year.slotOf('2026-03-14')]).toEqual(['2026-01-01', '2026', 12, '2026-03'])
  expect(year.slots.findIndex((s) => s.current)).toBe(9)
})

it('pages back to whole past weeks, months and years', () => {
  const now = new Date(2026, 10, 1, 9) // Sunday, Nov 1 2026: the month just rolled over
  const month = sharePeriod('month', now, 1)
  expect([month.from, month.to, month.name, month.slots.length, month.slots.some((s) => s.current)]).toEqual(['2026-10-01', '2026-10-31', 'October', 31, false])
  expect(sharePeriod('month', now, 11).name).toMatch(/December 2025/)

  const week = sharePeriod('week', now, 1)
  expect([week.from, week.to, week.name]).toEqual(['2026-10-19', '2026-10-25', 'Last week'])

  const year = sharePeriod('year', now, 1)
  expect([year.from, year.to, year.name, year.slots[0].key, year.slots.some((s) => s.current)]).toEqual(['2025-01-01', '2025-12-31', '2025', '2025-01', false])
})

it('finds the longest run of reading days', async () => {
  const { longestRun } = await import('./Stats.jsx')
  expect(longestRun(['2026-10-01', '2026-10-02', '2026-10-04', '2026-10-05', '2026-10-06'])).toBe(3)
  expect(longestRun([])).toBe(0)
})
