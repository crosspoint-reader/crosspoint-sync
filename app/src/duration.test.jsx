// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { duration } from './ui.jsx'

describe('duration', () => {
  it.each([
    [0, '0m'],
    [29, '0m'],
    [30, '1m'],
    [59 * 60 + 29, '59m'],
    [59 * 60 + 30, '1h'],
    [60 * 60, '1h'],
    [61 * 60, '1h 1m'],
    [7 * 3600 + 59 * 60 + 29, '7h 59m'],
    [7 * 3600 + 59 * 60 + 30, '8h'],
    [8 * 3600, '8h'],
    [8 * 3600 + 60, '8h 1m'],
  ])('formats %i seconds as %s', (seconds, expected) => {
    expect(duration(seconds)).toBe(expected)
  })
})
