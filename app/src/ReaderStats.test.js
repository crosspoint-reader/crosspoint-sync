// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { mergeSessionLog } from './ReaderStats.jsx'

const line = (s) => JSON.stringify(s)
const own = { doc: 'a'.repeat(32), start: 1700000000, secs: 600, tz: -300, title: 'Dune' }
const other = { doc: 'b'.repeat(32), start: 1700100000, secs: 300, tz: 60, title: 'Emma' }
const seed = { doc: 'b'.repeat(32), start: 1700049540, secs: 900, tz: 1, title: 'Emma' }

describe('mergeSessionLog', () => {
  it('keeps the reader’s bytes in front and adds only what it lacks', () => {
    const existing = `${line(own)}\n{"doc":"cut`
    const { text, added } = mergeSessionLog(existing, [own, other, seed].map(line).join('\n') + '\n')
    expect(added).toBe(2)
    expect(text.startsWith(`${existing}\n`)).toBe(true)
    expect(text.slice(existing.length + 1)).toBe(`${line(other)}\n${line(seed)}\n`)
  })

  it('adds only the new time to a book-day seeded before', () => {
    const first = mergeSessionLog('', line(seed)).text
    expect(mergeSessionLog(first, line(seed))).toEqual({ text: first, added: 0 })
    const more = mergeSessionLog(first, line({ ...seed, secs: 1500 }))
    expect(more.text).toBe(`${first}${line({ ...seed, secs: 600 })}\n`)
  })
})
