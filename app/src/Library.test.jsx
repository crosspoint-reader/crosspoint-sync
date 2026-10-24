// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import Library from './Library.jsx'
import { localDay } from './readingHistory.js'

vi.mock('./api.js', () => ({ isApp: false, api: { cover: vi.fn() } }))
vi.hoisted(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})

const session = {}
const finished = { document: 'finished', title: 'Finished on CrossInk', status: 'finished', percentage: 0.6, cover_url: '/finished.jpg' }
const reading = { document: 'reading', title: 'Still reading', status: 'reading', percentage: 0.3, cover_url: '/reading.jpg' }

afterEach(cleanup)

describe('Library completion updates', () => {
  it('shows the grid-derived streak and uses the device total until dated history loads', () => {
    const summary = { devices: [{ device: 'CrossInk' }], current_streak: 8, seconds: 0, completed: 0 }
    const { getByText, rerender } = render(<Library session={session} books={[]} summary={summary} />)
    expect(getByText('day streak').previousElementSibling.textContent).toBe('8')
    const activity = { books: [], reading_days: [localDay(new Date())] }
    rerender(<Library session={session} books={[]} summary={summary} activity={activity} />)
    expect(getByText('day streak').previousElementSibling.textContent).toBe('1')
  })

  it('shows every in-progress book as a reading card and removes completed books', () => {
    const { container, getByRole, getByText, getAllByText, rerender } = render(
      <Library session={session} books={[{ ...finished, status: 'reading' }, reading]} />,
    )
    expect(getAllByText('Continue reading').map((label) => label.closest('a').getAttribute('href'))).toEqual(['#/book/finished', '#/book/reading'])

    rerender(<Library session={session} books={[finished, reading]} />)
    expect(getByText('Continue reading').closest('a').getAttribute('href')).toBe('#/book/reading')
    expect(container.querySelector('a[href="#/book/finished"]')).toBeNull()

    fireEvent.click(getByRole('button', { name: /Finished 1/ }))
    expect(container.querySelector('a[href="#/book/finished"]')).not.toBeNull()
    expect(container.textContent).not.toContain('Continue reading')
  })

  it('shows the empty Reading shelf when every book is finished', () => {
    const { getByText, queryByText } = render(<Library session={session} books={[finished]} />)
    expect(getByText('Nothing in progress')).toBeTruthy()
    expect(queryByText('Continue reading')).toBeNull()
  })
})

describe('duplicate notice', () => {
  const book = (document, title) => ({ document, title, author: 'Unknown Author', status: 'finished', percentage: 1 })

  it('tells different Japanese titles apart', () => {
    const books = [
      book('grammar', '小学1年生 言葉と文法にぐーんと強くなる (くもんの国語集中学習)'),
      book('kanji', '小学1年生 漢字にぐーんと強くなる (くもんの国語集中学習)'),
    ]
    const { container } = render(<Library session={session} books={books} />)
    expect(container.textContent).not.toContain('appears more than once')
  })

  it('tells Thai titles apart that differ only in a tone mark', () => {
    const books = [book('forest', 'ป่า'), book('aunt', 'ป้า')]
    const { container } = render(<Library session={session} books={books} />)
    expect(container.textContent).not.toContain('appears more than once')
  })

  it('tells the same title apart when the languages differ', () => {
    const books = [{ ...book('en', '1984'), language: 'en' }, { ...book('de', '1984'), language: 'de' }]
    const { container } = render(<Library session={session} books={books} />)
    expect(container.textContent).not.toContain('appears more than once')
  })

  it('treats a regional variant as the same language', () => {
    const books = [{ ...book('a', '1984'), language: 'en' }, { ...book('b', '1984'), language: 'en-GB' }]
    const { container } = render(<Library session={session} books={books} />)
    expect(container.textContent).toContain('appears more than once')
  })

  it('still finds a Japanese title synced twice, full-width forms included', () => {
    const books = [book('a', '変な家２　～11の間取り図～'), book('b', '変な家2 ~11の間取り図~')]
    const { container } = render(<Library session={session} books={books} />)
    expect(container.textContent).toContain('appears more than once')
  })
})
