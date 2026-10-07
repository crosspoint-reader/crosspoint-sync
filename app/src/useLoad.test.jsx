// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { LoadCacheProvider, useLoad } from './ui.jsx'

afterEach(cleanup)
const pending = () => new Promise(() => {})
function Screen({ load }) {
  const [data] = useLoad(load, [], 'shared-book')
  return <div>{data ?? 'Loading'}</div>
}

describe('screen caches', () => {
  it('reuses data when revisiting a screen within the same sign-in', async () => {
    const { rerender } = render(<LoadCacheProvider><Screen load={async () => 'uxj4 data'} /></LoadCacheProvider>)
    await screen.findByText('uxj4 data')
    rerender(<LoadCacheProvider><div>Other screen</div></LoadCacheProvider>)
    rerender(<LoadCacheProvider><Screen load={pending} /></LoadCacheProvider>)
    expect(screen.getByText('uxj4 data')).toBeTruthy()
  })

  it('does not reuse a shared book key after switching accounts or servers', async () => {
    const { rerender } = render(<LoadCacheProvider key="uxj4@one"><Screen load={async () => 'uxj4 data'} /></LoadCacheProvider>)
    await screen.findByText('uxj4 data')
    rerender(<LoadCacheProvider key="uxj3@one"><Screen load={pending} /></LoadCacheProvider>)
    expect(screen.queryByText('uxj4 data')).toBeNull()
    expect(screen.getByText('Loading')).toBeTruthy()
    rerender(<LoadCacheProvider key="uxj4@two"><Screen load={pending} /></LoadCacheProvider>)
    expect(screen.getByText('Loading')).toBeTruthy()
  })

  it('ignores responses from a screen that has already unmounted', async () => {
    let resolve
    const { rerender } = render(<LoadCacheProvider><Screen load={() => new Promise((r) => { resolve = r })} /></LoadCacheProvider>)
    rerender(<LoadCacheProvider><div>Other screen</div></LoadCacheProvider>)
    await act(async () => resolve('stale data'))
    rerender(<LoadCacheProvider><Screen load={pending} /></LoadCacheProvider>)
    expect(screen.getByText('Loading')).toBeTruthy()
  })
})
