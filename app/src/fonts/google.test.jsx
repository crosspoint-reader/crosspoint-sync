// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { localFamily, pickFaces, trueTypeFiles } from './google.js'
import { loadsTrueType } from '../ReaderFonts.jsx'

const file = (name, bytes = [0, 1, 0, 0]) => ({ name, arrayBuffer: async () => new Uint8Array(bytes).buffer })

describe('fonts', () => {
  it('picks the four reader styles from available weights', () => {
    expect(pickFaces({ weights: [400, 500, 700], styles: ['italic', 'normal'] })).toEqual({ regular: [0, 400], bold: [0, 700], italic: [1, 400], bolditalic: [1, 700] })
    expect(pickFaces({ weights: [300], styles: ['normal'] })).toEqual({ regular: [0, 300] })
  })
  it('groups picked files into one family', async () => {
    const { family, styles } = await localFamily([file('Lora-BoldItalic.ttf'), file('Lora-Regular.ttf'), file('Lora-Bold.ttf')])
    expect(family).toBe('Lora')
    expect(Object.keys(styles).sort()).toEqual(['bold', 'bolditalic', 'regular'])
  })
  it('names TrueType uploads and keeps OpenType extensions', () => {
    const otto = new Uint8Array([79, 84, 84, 79])
    expect(trueTypeFiles('Lora', { regular: new Uint8Array(4), italic: otto }).map((f) => f.name)).toEqual(['Lora-Regular.ttf', 'Lora-Italic.otf'])
  })
  it('defaults to TrueType only on ESP32-S3 readers', () => {
    expect([loadsTrueType('X4'), loadsTrueType('X3'), loadsTrueType(undefined), loadsTrueType('M5PaperS3')]).toEqual([false, false, false, true])
  })
})

it('lets you get fonts before a reader connects', async () => {
  const { render, screen } = await import('@testing-library/react')
  const { default: ReaderFonts } = await import('../ReaderFonts.jsx')
  render(<ReaderFonts />)
  expect(screen.getByText('Fonts')).toBeTruthy()
  expect(screen.getByLabelText('Search Google Fonts')).toBeTruthy()
  expect(screen.getByText(/get fonts now and send them later/)).toBeTruthy()
})

it('turns saved TrueType files back into styles for conversion', async () => {
  const { localFamily, trueTypeFiles } = await import('./google.js')
  const files = trueTypeFiles('Lora', { regular: new Uint8Array(4), bold: new Uint8Array(4), bolditalic: new Uint8Array(4) })
  const { styles } = await localFamily(files.map((f) => ({ name: f.name, arrayBuffer: async () => f.data })))
  expect(Object.keys(styles).sort()).toEqual(['bold', 'bolditalic', 'regular'])
})
