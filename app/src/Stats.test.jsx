// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import Stats, { decodeHistory } from './Stats.jsx'

const day = (s) => Date.parse(`${s}T00:00:00Z`)
const anchorDay = (s) => (day(s) - Date.UTC(2000, 0, 1)) / 86400000
const activity = {
  books: [], pages_total: 0, days: [], reading_days: ['2026-08-11', '2026-08-16'],
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-09-30T12:00:00Z'))
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('daily reading time', () => {
  const summary = {
    devices: [{ device: 'CrossInk' }], history_b64: '', anchor_day: anchorDay('2026-09-30'),
    seconds: 3600, pages: 10, sessions: 1, completed: 0, current_streak: 0, streak: 0,
    tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0],
  }

  it.each([
    ['missing', undefined],
    ['empty', []],
    ['older than seven days', [{ date: '2026-09-23', seconds: 4200 }]],
    ['future only', [{ date: '2026-10-01', seconds: 4200 }]],
  ])('hides both tiles when daily history is %s', (_, daily) => {
    const { queryByText, getByText } = render(<Stats session={{}} books={[]} summary={{ ...summary, daily }} />)
    expect(queryByText('Today')).toBeNull()
    expect(queryByText('7-day average')).toBeNull()
    expect(getByText('Time read').nextElementSibling.textContent).toBe('1h')
  })

  it('shows the weekly average without a missing Today stat', () => {
    const daily = [{ date: '2026-09-24', seconds: 4200 }]
    const { queryByText, getByText } = render(<Stats session={{}} books={[]} summary={{ ...summary, daily }} />)
    expect(queryByText('Today')).toBeNull()
    expect(getByText('7-day average').nextElementSibling.textContent).toBe('10m')
  })

  it.each([0, 4200])('shows both tiles for a recorded Today value of %s seconds', (seconds) => {
    const daily = [{ date: '2026-09-30', seconds }]
    const { getByText } = render(<Stats session={{}} books={[]} summary={{ ...summary, daily }} />)
    expect(getByText('Today').nextElementSibling.textContent).toBe(seconds ? '1h 10m' : '0m')
    expect(getByText('7-day average').nextElementSibling.textContent).toBe(seconds ? '10m' : '0m')
  })
})

describe('reading grids', () => {
  it('adds chosen dates to device history and preserves existing bits when the anchor moves', () => {
    // Device history says Aug 11 was read. Manual finish is Aug 16.
    const history = decodeHistory(btoa(String.fromCharCode(1)), anchorDay('2026-08-11'), activity.reading_days)
    expect(history.anchor.toISOString().slice(0, 10)).toBe('2026-08-16')
    expect(history.read(0)).toBe(true)
    expect(history.read(5)).toBe(true)
    for (let n = 1; n < 5; n++) expect(history.read(n)).toBe(false)
    expect(history.read(-1)).toBe(false)
    // The device day survives even when no longer supplied by the date overlay.
    expect(decodeHistory(btoa(String.fromCharCode(1)), anchorDay('2026-08-11'), ['2026-08-16']).read(5)).toBe(true)
  })

  it.each([false, true])('shows only chosen days with CrossInk stats present: %s', (hasTime) => {
    const summary = hasTime ? {
      devices: [{ device: 'CrossInk' }], history_b64: '', anchor_day: anchorDay('2026-08-16'),
      seconds: 0, pages: 0, sessions: 0, completed: 0, current_streak: 0, streak: 0,
      tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0],
    } : null
    const props = { session: {}, books: [], activity, summary }
    const { container, rerender } = render(<Stats {...props} />)
    const tip = (date) => [...container.querySelectorAll('[data-tip]')]
      .find((el) => el.getAttribute('data-tip').startsWith(date))?.getAttribute('data-tip')
    expect(tip('Tue, Aug 11')).toMatch(/: read$/)
    expect(tip('Sun, Aug 16')).toMatch(/: read$/)
    expect(tip('Wed, Aug 12')).toMatch(/: no reading$/)
    // Date edits immediately remove the previous extra marker.
    rerender(<Stats {...props} activity={{ ...activity, reading_days: ['2026-08-11', '2026-08-18'] }} />)
    expect(tip('Sun, Aug 16')).toMatch(/: no reading$/)
    expect(tip('Tue, Aug 18')).toMatch(/: read$/)
  })
})
