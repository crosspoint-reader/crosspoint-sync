// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import Stats, { decodeHistory } from './Stats.jsx'
import { renderCalendarCard } from './shareCard.js'

vi.mock('./shareCard.js', async (importOriginal) => ({
  ...await importOriginal(),
  renderCalendarCard: vi.fn(),
}))
vi.mock('./ShareSheet.jsx', () => ({
  default: ({ render }) => <button onClick={render}>Render calendar share</button>,
}))

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

describe('timeline start dates', () => {
  const unix = (s) => day(s) / 1000 + 12 * 3600
  const book = { document: 'a', title: 'Old book', percentage: 0.15 }
  const baseline = { document: 'a', from: 0.15, to: 0.15, pages: 0, syncs: 1 }
  const start = (date) => ({ day: date, pages: 0, syncs: 0, books: [{ ...baseline, from: 0, to: 0, syncs: 0, started: true }] })
  const data = (date, days = []) => ({
    books: [{ document: 'a', started_at: unix(date), finished_at: null }],
    days: [start(date), { day: '2026-09-29', pages: 0, syncs: 1, books: [baseline] }, ...days],
  })

  it('shows a chosen start instead of the initial idle upload and moves it after date edits', () => {
    const props = { session: {}, tab: 'timeline', books: [book] }
    const { getByText, queryByText, rerender } = render(<Stats {...props} activity={data('2026-08-11')} />)
    expect(getByText('Started reading')).toBeTruthy()
    expect(getByText('Tue, Aug 11')).toBeTruthy()
    expect(queryByText('Tue, Sep 29')).toBeNull()
    expect(queryByText('Opened at 15%')).toBeNull()
    rerender(<Stats {...props} activity={data('2026-08-12')} />)
    expect(queryByText('Tue, Aug 11')).toBeNull()
    expect(getByText('Wed, Aug 12')).toBeTruthy()
  })

  it('keeps later opens and forward progress on their recorded days', () => {
    const a = data('2026-08-11', [{ day: '2026-09-30', books: [baseline] }])
    a.days[1].books = [{ ...baseline, to: 0.2, pages: 5 }]
    const { getByText } = render(<Stats session={{}} tab="timeline" books={[book]} activity={a} />)
    expect(getByText('Started reading')).toBeTruthy()
    expect(getByText('Read 5 pages · 15% to 20%')).toBeTruthy()
    expect(getByText('Opened at 15%')).toBeTruthy()
  })

  it('keeps the first sync fallback when there is no chosen start date', () => {
    const a = data('2026-09-29')
    a.days.shift()
    const { getByText, queryByText } = render(<Stats session={{}} tab="timeline" books={[book]} activity={a} />)
    expect(getByText('Opened at 15%')).toBeTruthy()
    expect(queryByText('Started reading')).toBeNull()
  })

  it('shows one start event when the chosen start is on the upload day at 15%', () => {
    const a = data('2026-09-29')
    a.days = [{ day: '2026-09-29', books: [{ ...baseline, started: true }] }]
    const { getAllByText, queryByText } = render(<Stats session={{}} tab="timeline" books={[book]} activity={a} />)
    expect(getAllByText('Started reading')).toHaveLength(1)
    expect(queryByText('Opened at 15%')).toBeNull()
  })

  it('preserves a finish event on the first upload day', () => {
    const a = data('2026-08-11')
    a.books[0].finished_at = unix('2026-09-29')
    const { getByText } = render(<Stats session={{}} tab="timeline" books={[book]} activity={a} />)
    expect(getByText('Started reading')).toBeTruthy()
    expect(getByText('Finished')).toBeTruthy()
  })
})

describe('timeline refresh failures', () => {
  it('labels saved activity as stale and offers a working retry', () => {
    const retry = vi.fn()
    const { getByRole, getByText } = render(<Stats session={{}} tab="timeline" books={[]} activity={activity}
      activityError={new Error('server failed')} activityLoading={false} onRetryActivity={retry} />)
    expect(getByRole('status').textContent).toContain('Showing saved activity.')
    expect(getByRole('status').textContent).not.toContain('Showing data from')
    expect(getByText('Your timeline starts soon')).toBeTruthy()
    fireEvent.click(getByRole('button', { name: 'Retry' }))
    expect(retry).toHaveBeenCalledOnce()
  })

  it('shows the last successful refresh time for saved activity', () => {
    const updatedAt = Date.parse('2026-09-29T15:30:00Z')
    const { getByRole, container } = render(<Stats session={{}} tab="timeline" books={[]} activity={activity}
      activityError={new Error('offline')} activityUpdatedAt={updatedAt} onRetryActivity={vi.fn()} />)
    expect(getByRole('status').textContent).toContain('Showing data from')
    expect(container.querySelector('time').dateTime).toBe('2026-09-29T15:30:00.000Z')
    expect(container.querySelector('time').textContent).toBe(new Date(updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }))
  })

  it('shows initial-load failure without a stuck loading message and clears it on recovery', () => {
    const props = { session: {}, tab: 'timeline', books: [], onRetryActivity: vi.fn() }
    const { getByRole, queryByRole, queryByText, rerender } = render(<Stats {...props}
      activityError={new Error('offline')} activityLoading />)
    expect(getByRole('alert').textContent).toContain('Reading activity is unavailable.')
    expect(getByRole('button', { name: 'Retrying…' }).disabled).toBe(true)
    expect(queryByText('Loading…')).toBeNull()
    rerender(<Stats {...props} activity={activity} activityError={null} activityLoading={false} />)
    expect(queryByRole('alert')).toBeNull()
    expect(queryByRole('status')).toBeNull()
  })
})

describe('daily reading time', () => {
  const summary = {
    devices: [{ device: 'CrossInk' }], history_b64: '', anchor_day: anchorDay('2026-09-30'),
    seconds: 3600, pages: 10, sessions: 1, completed: 0, current_streak: 0, streak: 0,
    tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0],
  }

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', []],
  ])('hides both tiles when daily history is %s', (_, daily) => {
    const { queryByText, getByText } = render(<Stats session={{}} books={[]} summary={{ ...summary, daily }} />)
    expect(queryByText('Today')).toBeNull()
    expect(queryByText('7-day average')).toBeNull()
    expect(getByText('Time read').nextElementSibling.textContent).toBe('1h')
  })

  it('shows zero for Today when only earlier days have reading time', () => {
    const daily = [{ date: '2026-09-24', seconds: 4200 }]
    const { getByText } = render(<Stats session={{}} books={[]} summary={{ ...summary, daily }} />)
    expect(getByText('Today').nextElementSibling.textContent).toBe('0m')
    expect(getByText('7-day average').nextElementSibling.textContent).toBe('10m')
  })

  it.each(['2026-09-23', '2026-10-01'])('shows both zero tiles when history exists outside the past week: %s', (date) => {
    const daily = [{ date, seconds: 4200 }]
    const { getByText } = render(<Stats session={{}} books={[]} summary={{ ...summary, daily }} />)
    expect(getByText('Today').nextElementSibling.textContent).toBe('0m')
    expect(getByText('7-day average').nextElementSibling.textContent).toBe('0m')
  })

  it('reveals both tiles when the first daily record arrives and keeps them after it ages out', () => {
    const props = { session: {}, books: [] }
    const { queryByText, getByText, rerender } = render(<Stats {...props} summary={{ ...summary, daily: [] }} />)
    expect(queryByText('Today')).toBeNull()
    expect(queryByText('7-day average')).toBeNull()

    const daily = [{ date: '2026-09-30', seconds: 4200 }]
    rerender(<Stats {...props} summary={{ ...summary, daily }} />)
    expect(getByText('Today').nextElementSibling.textContent).toBe('1h 10m')
    expect(getByText('7-day average').nextElementSibling.textContent).toBe('10m')

    vi.setSystemTime(new Date('2026-10-07T12:00:00Z'))
    rerender(<Stats {...props} summary={{ ...summary, daily }} />)
    expect(getByText('Today').nextElementSibling.textContent).toBe('0m')
    expect(getByText('7-day average').nextElementSibling.textContent).toBe('0m')
  })

  it.each([0, 4200])('shows both tiles for a recorded Today value of %s seconds', (seconds) => {
    const daily = [{ date: '2026-09-30', seconds }]
    const { getByText } = render(<Stats session={{}} books={[]} summary={{ ...summary, daily }} />)
    expect(getByText('Today').nextElementSibling.textContent).toBe(seconds ? '1h 10m' : '0m')
    expect(getByText('7-day average').nextElementSibling.textContent).toBe(seconds ? '10m' : '0m')
  })
})

describe('reading grids', () => {
  const summary = {
    devices: [{ device: 'CrossInk' }], history_b64: btoa(String.fromCharCode(3)),
    anchor_day: anchorDay('2026-09-30'), seconds: 4200, pages: 10, sessions: 1,
    completed: 0, current_streak: 2, streak: 2,
    tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0],
    daily: [{ date: '2026-09-30', seconds: 4200 }],
  }
  const synced = {
    books: [], pages_total: 25, reading_days: ['2026-09-27'],
    days: [{ day: '2026-09-30', syncs: 1, pages: 5 }, { day: '2026-09-28', syncs: 1, pages: 20 }],
  }

  it.each([undefined, null, []])('uses reading days before daily time history exists: %s', (daily) => {
    const { queryByText, getByRole, getByLabelText } = render(
      <Stats session={{}} books={[]} summary={{ ...summary, daily }} activity={synced} />,
    )
    expect(queryByText('Reading time recorded by your reader')).toBeNull()
    expect(queryByText('Today')).toBeNull()
    expect(queryByText('7-day average')).toBeNull()
    expect(queryByText('Less')).toBeNull()
    expect(getByLabelText('Wed, Sep 30: 5 pages')).toBeTruthy()
    expect(getByLabelText('Tue, Sep 29: read')).toBeTruthy()
    fireEvent.click(getByRole('button', { name: 'Share your reading days' }))
    fireEvent.click(getByRole('button', { name: 'Render calendar share' }))
    expect(renderCalendarCard.mock.lastCall[0].tiles).toEqual([['reading days', 3], ['day streak', 2]])
  })

  it.each([0, 4200])('reveals daily time labels with the first record of %s seconds and keeps the selected range', (seconds) => {
    const props = { session: {}, books: [], activity: synced }
    const { getByRole, getByText, getByLabelText, rerender } = render(
      <Stats {...props} summary={{ ...summary, daily: [] }} />,
    )
    fireEvent.click(getByRole('button', { name: 'Month' }))
    fireEvent.click(getByRole('button', { name: 'Earlier' }))
    rerender(<Stats {...props} summary={{ ...summary, daily: [{ date: '2026-09-30', seconds }] }} />)
    expect(getByText('Reading time recorded by your reader')).toBeTruthy()
    expect(getByText('August 2026')).toBeTruthy()
    expect(getByText('Today')).toBeTruthy()
    expect(getByText('7-day average')).toBeTruthy()
    fireEvent.click(getByRole('button', { name: 'Later' }))
    expect(getByLabelText(`Wed, Sep 30: ${seconds ? '1h 10m' : '0m'} reading time`)).toBeTruthy()
  })

  it('keeps time available with daily history outside the visible period', () => {
    const daily = [{ date: '2025-08-01', seconds: 600 }]
    const { getByText, getByLabelText } = render(<Stats session={{}} books={[]} activity={synced} summary={{ ...summary, daily }} />)
    expect(getByText('Reading time recorded by your reader; synced pages where no time was recorded')).toBeTruthy()
    expect(getByLabelText('Wed, Sep 30: 5 pages')).toBeTruthy()
    expect(getByText('Today').nextElementSibling.textContent).toBe('0m')
  })

  it.each([false, true])('uses the device calendar with sync activity present and daily history: %s', (hasDaily) => {
    const props = { session: {}, books: [], summary: { ...summary, daily: hasDaily ? summary.daily : [] } }
    const { queryByRole, getByRole, getByLabelText, rerender } = render(<Stats {...props} />)
    const tip = `Wed, Sep 30: ${hasDaily ? '1h 10m reading time' : 'read'}`
    expect(getByLabelText(tip)).toBeTruthy()
    rerender(<Stats {...props} activity={synced} />)
    expect(queryByRole('group', { name: 'Reading calendar measure' })).toBeNull()
    expect(queryByRole('button', { name: 'Pages read' })).toBeNull()
    // Recorded time wins; without it the day keeps its synced pages (#63).
    expect(getByLabelText(hasDaily ? tip : 'Wed, Sep 30: 5 pages')).toBeTruthy()
    // The reader says Sep 29 was read; sync progress has pages only on Sep 28 and Sep 30.
    expect(getByLabelText(hasDaily ? 'Tue, Sep 29: read, no time recorded' : 'Tue, Sep 29: read')).toBeTruthy()
    expect(getByLabelText('Mon, Sep 28: no reading')).toBeTruthy()
    fireEvent.click(getByRole('button', { name: 'Share your reading days' }))
    fireEvent.click(getByRole('button', { name: 'Render calendar share' }))
    expect(renderCalendarCard.mock.lastCall[0].tiles).toEqual([
      ['reading days', 3],
      ...(hasDaily ? [['time read', '1h 10m']] : []),
      ['day streak', 2],
    ])
    // Days shaded by synced pages are outlined on the card, which shows no pages measure.
    expect(renderCalendarCard.mock.lastCall[0].blocks.flatMap((b) => b.grid.flat())).toContain('unknown')
    // Readers without device stats still get their original sync-page calendar.
    rerender(<Stats {...props} activity={synced} summary={null} />)
    expect(getByLabelText('Wed, Sep 30: 5 pages')).toBeTruthy()
  })

  // #63: once a reader sends time, days known only from sync history (before it did, or read on a
  // position-only device) kept their pages instead of turning into a flat "read".
  it('shows synced pages for days without recorded time', () => {
    const history = {
      books: [], pages_total: 32, reading_days: ['2026-09-20', '2026-09-24', '2026-09-30'],
      days: [{ day: '2026-09-20', syncs: 2, pages: 12 }, { day: '2026-09-24', syncs: 1, pages: 0 }, { day: '2026-09-30', syncs: 1, pages: 20 }],
    }
    const { getByLabelText, getByText, getByRole } = render(<Stats session={{}} books={[]} summary={summary} activity={history} />)
    expect(getByLabelText('Wed, Sep 30: 1h 10m reading time')).toBeTruthy()
    expect(getByLabelText('Sun, Sep 20: 12 pages')).toBeTruthy()
    expect(getByLabelText('Thu, Sep 24: read, no time recorded')).toBeTruthy()
    expect(getByText('read, no time recorded')).toBeTruthy()
    expect(getByText('Reading time recorded by your reader; synced pages where no time was recorded')).toBeTruthy()
    // The shared card shades by time only, so both days without recorded time are outlined there.
    fireEvent.click(getByRole('button', { name: 'Share your reading days' }))
    fireEvent.click(getByRole('button', { name: 'Render calendar share' }))
    const cells = renderCalendarCard.mock.lastCall[0].blocks.flatMap((b) => b.grid.flat())
    const untimed = [...document.querySelectorAll('[data-tip]')].filter((el) => / pages$|no time recorded$/.test(el.dataset.tip))
    expect(untimed.length).toBeGreaterThanOrEqual(2)
    expect(cells.filter((c) => c === 'unknown')).toHaveLength(untimed.length)
  })

  it('shows synced pages older than the device history window', () => {
    const history = { books: [], pages_total: 9, reading_days: ['2024-03-12'], days: [{ day: '2024-03-12', syncs: 1, pages: 9 }] }
    const { getByLabelText, getByRole } = render(<Stats session={{}} books={[]} summary={summary} activity={history} />)
    fireEvent.click(getByRole('button', { name: 'Earlier' }))
    fireEvent.click(getByRole('button', { name: 'Earlier' }))
    expect(getByLabelText('Tue, Mar 12: 9 pages')).toBeTruthy()
  })

  it('updates both streaks from the same dates that fill the grid', () => {
    const summary = {
      devices: [{ device: 'CrossInk' }], current_streak: 8, streak: 12,
      seconds: 3600, pages: 0, sessions: 0, completed: 0,
      tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0],
    }
    const { getByText, rerender, container } = render(<Stats session={{}} books={[]} summary={summary} />)
    expect(getByText('Current streak').nextElementSibling.textContent).toBe('8 days')
    expect(getByText('Longest streak').nextElementSibling.textContent).toBe('12 days')
    const combined = { ...summary, anchor_day: anchorDay('2026-09-28'), history_b64: btoa(String.fromCharCode(1)) }
    const synced = { books: [], days: [], reading_days: ['2026-09-29', '2026-09-30'] }
    rerender(<Stats session={{}} books={[]} summary={combined} activity={synced} />)
    expect(getByText('Current streak').nextElementSibling.textContent).toBe('3 days')
    expect(container.querySelectorAll('[data-tip$=": read"]').length).toBe(3)
    expect(getByText('Longest streak').nextElementSibling.textContent).toBe('3 days')
    rerender(<Stats session={{}} books={[]} summary={combined} activity={{ ...synced, reading_days: [] }} />)
    expect(getByText('Current streak').nextElementSibling.textContent).toBe('0 days')
    expect(getByText('Longest streak').nextElementSibling.textContent).toBe('1 days')
  })

  it('shows recorded daily time on hover and touch without inventing time for other dates', () => {
    const summary = {
      devices: [{ device: 'CrossInk' }], history_b64: btoa(String.fromCharCode(7)),
      anchor_day: anchorDay('2026-09-30'), seconds: 4200, pages: 10, sessions: 1,
      completed: 0, current_streak: 3, streak: 3,
      tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0],
      daily: [{ date: '2026-09-30', seconds: 4200 }, { date: '2026-09-29', seconds: 0 }],
    }
    const { container, getByRole, queryByRole, rerender } = render(<Stats session={{}} books={[]} summary={summary} />)
    const cell = (date) => [...container.querySelectorAll('[data-tip]')]
      .find((el) => el.dataset.tip.startsWith(date))
    // jsdom does not implement PointerEvent; preserve pointerType for React's handlers.
    const pointer = (el, type, pointerType) => {
      const event = new Event(type, { bubbles: true })
      Object.assign(event, { pointerType })
      fireEvent(el, event)
    }
    pointer(cell('Wed, Sep 30'), 'pointerover', 'mouse')
    expect(getByRole('tooltip').textContent).toBe('Wed, Sep 30: 1h 10m reading time')
    pointer(cell('Tue, Sep 29'), 'pointerover', 'mouse')
    expect(getByRole('tooltip').textContent).toBe('Tue, Sep 29: 0m reading time')
    pointer(cell('Mon, Sep 28'), 'pointerover', 'mouse')
    expect(getByRole('tooltip').textContent).toBe('Mon, Sep 28: read, no time recorded')
    pointer(cell('Sun, Sep 27'), 'pointerover', 'mouse')
    expect(getByRole('tooltip').textContent).toBe('Sun, Sep 27: no reading')
    pointer(cell('Wed, Sep 30'), 'pointerdown', 'touch')
    expect(getByRole('tooltip').textContent).toContain('1h 10m reading time')
    pointer(cell('Wed, Sep 30'), 'pointerup', 'touch')
    expect(queryByRole('tooltip')).toBeNull()
    rerender(<Stats session={{}} books={[]} summary={{ ...summary, daily: undefined }} />)
    pointer(cell('Wed, Sep 30'), 'pointerover', 'mouse')
    expect(getByRole('tooltip').textContent).toBe('Wed, Sep 30: read')
  })

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

  it('a few seconds of device stats show the pages calendar, not a 0m reading-time section', () => {
    const summary = {
      devices: [{ device: 'KOReader' }], history_b64: btoa(String.fromCharCode(1)), anchor_day: anchorDay('2026-09-30'),
      seconds: 7, pages: 2, sessions: 3, completed: 0, current_streak: 1, streak: 1,
      tod: [0, 0, 7, 0], dow: [0, 0, 7, 0, 0, 0, 0],
    }
    const { queryByText } = render(<Stats session={{}} books={[]} summary={summary} activity={{ books: [], days: [], reading_days: [] }} />)
    expect(queryByText('Reading time')).toBeNull()
    expect(queryByText('Time read')).toBeNull()
  })

  it('shades device calendar days against the median day and outlines days with unknown time', () => {
    const summary = {
      devices: [{ device: 'CrossInk' }], history_b64: btoa(String.fromCharCode(15)),
      anchor_day: anchorDay('2026-09-30'), seconds: 9600, pages: 0, sessions: 0, completed: 0,
      current_streak: 4, streak: 4, tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0],
      daily: [{ date: '2026-09-30', seconds: 600 }, { date: '2026-09-29', seconds: 1800 }, { date: '2026-09-28', seconds: 7200 }],
    }
    const { container } = render(<Stats session={{}} books={[]} summary={summary} />)
    const cls = (date) => [...container.querySelectorAll('[data-tip]')].find((el) => el.dataset.tip.startsWith(date)).className
    expect(cls('Wed, Sep 30')).toContain('bg-brand-200')
    expect(cls('Tue, Sep 29')).toContain('bg-brand-300')
    expect(cls('Mon, Sep 28')).toContain('bg-brand-500')
    // Read with no recorded time: outlined, not shaded as if measured.
    expect(cls('Sun, Sep 27')).toContain('ring-brand-400')
    expect(cls('Sat, Sep 26')).toContain('bg-stone-100')
    expect(container.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(5)
  })

  it('gives the device view the month, 3 month and year scales with time tooltips', () => {
    const summary = {
      devices: [{ device: 'CrossInk' }], history_b64: btoa(String.fromCharCode(3)),
      anchor_day: anchorDay('2026-09-30'), seconds: 4200, pages: 0, sessions: 0, completed: 0,
      current_streak: 2, streak: 2, tod: [0, 0, 0, 0], dow: [0, 0, 0, 0, 0, 0, 0],
      daily: [{ date: '2026-09-30', seconds: 4200 }],
    }
    const { container, getByText, getByLabelText } = render(<Stats session={{}} books={[]} summary={summary} />)
    expect(getByText('3 months')).toBeTruthy()
    expect(getByLabelText('Share your reading days')).toBeTruthy()
    fireEvent.click(getByText('Month'))
    const tips = [...container.querySelectorAll('[data-tip]')].map((el) => el.dataset.tip)
    expect(tips).toContain('Wed, Sep 30: 1h 10m reading time')
    expect(tips).toContain('Tue, Sep 29: read, no time recorded')
    expect(tips).toContain('Mon, Sep 28: no reading')
    expect(tips.length).toBe(30)
  })

  it('shades the sync calendar by pages against the median day', () => {
    const days = [
      { day: '2026-09-30', syncs: 1, pages: 5 },
      { day: '2026-09-29', syncs: 1, pages: 20 },
      { day: '2026-09-28', syncs: 1, pages: 80 },
    ]
    const { container } = render(<Stats session={{}} books={[]} summary={null} activity={{ ...activity, days, reading_days: [] }} />)
    const cls = (date) => container.querySelector(`[aria-label^="${date}"]`).className
    expect(cls('Wed, Sep 30')).toContain('bg-brand-200')
    expect(cls('Tue, Sep 29')).toContain('bg-brand-300')
    expect(cls('Mon, Sep 28')).toContain('bg-brand-500')
  })
})

describe('BookOrbit stats', () => {
  it('explains exact duplicate exclusions without implying that device history is dropped', () => {
    const props = { session: {}, books: [], activity, summary: { devices: [], bookorbit: { excluded_sessions: 2 } } }
    const { getByText, queryByText, rerender } = render(<Stats {...props} />)
    expect(getByText(/Duplicate BookOrbit session records are counted once/)).toBeTruthy()
    rerender(<Stats {...props} summary={{ devices: [], bookorbit: { excluded_sessions: 0 } }} />)
    expect(queryByText(/Duplicate BookOrbit session records are counted once/)).toBeNull()
  })
})
