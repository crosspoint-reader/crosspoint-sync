// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { useSwipeTabs } from './ui.jsx'

function Page({ current, go }) {
  useSwipeTabs(['a', 'b', 'c'], current, go)
  return <div><p id="text">text</p><input id="slider" type="range" /></div>
}
const swipe = (el, x0, x1, dy = 0) => {
  const touch = (type, key, x, y) => el.dispatchEvent(Object.assign(new Event(type, { bubbles: true }), { [key]: [{ clientX: x, clientY: y }], ...(key === 'touches' ? {} : { touches: [] }) }))
  touch('touchstart', 'touches', x0, 100)
  touch('touchend', 'changedTouches', x1, 100 + dy)
}
afterEach(cleanup)

it('moves to the neighbouring tab on a sideways swipe only', () => {
  const go = vi.fn()
  const { container } = render(<Page current="b" go={go} />)
  const text = container.querySelector('#text')
  swipe(text, 300, 100)
  expect(go).toHaveBeenLastCalledWith('c')
  swipe(text, 100, 300)
  expect(go).toHaveBeenLastCalledWith('a')
  go.mockClear()
  swipe(text, 300, 280) // too short
  swipe(text, 300, 100, 200) // mostly vertical
  swipe(text, 10, 300) // from the left edge
  swipe(container.querySelector('#slider'), 300, 100) // a control that is dragged itself
  expect(go).not.toHaveBeenCalled()
})

it('stops at the first and last tab', () => {
  const go = vi.fn()
  const { container } = render(<Page current="c" go={go} />)
  swipe(container.querySelector('#text'), 300, 100)
  expect(go).not.toHaveBeenCalled()
})
