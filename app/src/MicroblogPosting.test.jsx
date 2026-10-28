// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
vi.mock('./api.js', () => ({ api: { microblogDestinations: vi.fn(), setMicroblogDestination: vi.fn() } }))
import MicroblogPosting from './MicroblogPosting.jsx'
import { api } from './api.js'
const a = 'https://first.micro.blog/'
const b = 'https://second.micro.blog/'
beforeEach(() => {
  api.microblogDestinations.mockResolvedValue({ items: [{ uid: a, name: 'First blog' }, { uid: b, name: 'Second blog' }], selected: null })
  api.setMicroblogDestination.mockResolvedValue({ destination: b })
})
afterEach(() => { cleanup(); vi.clearAllMocks() })
it('requires a choice among multiple blogs and saves it', async () => {
  const onChange = vi.fn()
  render(<MicroblogPosting session={{}} onChange={onChange} />)
  const select = await screen.findByLabelText('Post clippings to')
  await waitFor(() => expect(select.options.length).toBe(3))
  expect(select.value).toBe('')
  fireEvent.change(select, { target: { value: b } })
  await waitFor(() => expect(onChange).toHaveBeenCalledOnce())
  expect(api.setMicroblogDestination).toHaveBeenCalledWith({}, b)
  expect(select.value).toBe(b)
})
it('shows the sole automatically selected blog without issuing a save', async () => {
  api.microblogDestinations.mockResolvedValue({ items: [{ uid: a, name: 'First blog' }], selected: a })
  render(<MicroblogPosting session={{}} />)
  await waitFor(() => expect(screen.getByLabelText('Post clippings to').value).toBe(a))
  expect(api.setMicroblogDestination).not.toHaveBeenCalled()
})
it('keeps an unavailable saved choice visible rather than silently choosing another blog', async () => {
  api.microblogDestinations.mockResolvedValue({ items: [{ uid: a, name: 'First blog' }], selected: b })
  render(<MicroblogPosting session={{}} />)
  expect(await screen.findByText(/Unavailable.*second.micro.blog/)).toBeTruthy()
  expect(screen.getByLabelText('Post clippings to').value).toBe(b)
})
it('restores the saved value and allows retry after a failed save', async () => {
  api.setMicroblogDestination.mockRejectedValue(new Error('Could not save blog'))
  render(<MicroblogPosting session={{}} />)
  const select = await screen.findByLabelText('Post clippings to')
  await waitFor(() => expect(select.options.length).toBe(3))
  fireEvent.change(select, { target: { value: b } })
  expect((await screen.findByRole('alert')).textContent).toContain('Could not save blog')
  expect(select.value).toBe('')
  expect(select.disabled).toBe(false)
})
it('shows discovery errors and retries loading', async () => {
  api.microblogDestinations.mockRejectedValueOnce(new Error('Discovery unavailable'))
  render(<MicroblogPosting session={{}} />)
  expect((await screen.findByRole('alert')).textContent).toContain('Discovery unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading blogs' }))
  expect(await screen.findByRole('option', { name: 'First blog' })).toBeTruthy()
})
it('disables the selector until a save completes', async () => {
  let finish
  api.setMicroblogDestination.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
  render(<MicroblogPosting session={{}} />)
  const select = await screen.findByLabelText('Post clippings to')
  await waitFor(() => expect(select.options.length).toBe(3))
  fireEvent.change(select, { target: { value: b } })
  expect(select.disabled).toBe(true)
  fireEvent.change(select, { target: { value: a } })
  expect(api.setMicroblogDestination).toHaveBeenCalledTimes(1)
  finish({ destination: b })
  await waitFor(() => expect(select.disabled).toBe(false))
  expect(select.value).toBe(b)
})
