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
