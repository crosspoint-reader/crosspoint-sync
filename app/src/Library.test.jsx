// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import Library from './Library.jsx'

vi.mock('./api.js', () => ({ isApp: false, api: { cover: vi.fn() } }))
vi.hoisted(() => {
  window.matchMedia = vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
})

const session = {}
const finished = { document: 'finished', title: 'Finished on CrossInk', status: 'finished', percentage: 0.6, cover_url: '/finished.jpg' }
const reading = { document: 'reading', title: 'Still reading', status: 'reading', percentage: 0.3, cover_url: '/reading.jpg' }

afterEach(cleanup)

describe('Library completion updates', () => {
  it('replaces the Continue reading book when its finished status arrives', () => {
    const { container, getByRole, getByText, rerender } = render(
      <Library session={session} books={[{ ...finished, status: 'reading' }, reading]} />,
    )
    expect(getByText('Continue reading').closest('a').getAttribute('href')).toBe('#/book/finished')

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
