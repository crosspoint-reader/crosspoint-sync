// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
vi.mock('./api.js', () => ({ isApp: false, api: { readingGoals: vi.fn(), setReadingGoal: vi.fn(), removeReadingGoal: vi.fn() }, cached: { readingGoals: () => null } }))
const { api } = await import('./api.js')
const { default: ReadingGoals, ReadingGoalCard } = await import('./ReadingGoals.jsx')
const session = { server: 'https://sync.test', username: 'reader' }
const year = new Date().getFullYear()
beforeEach(() => { vi.resetAllMocks(); api.readingGoals.mockResolvedValue({ year, goals: [] }) })
afterEach(cleanup)

it('keeps goal cards absent until a target is selected for the current year', () => {
  const { container, rerender } = render(<ReadingGoalCard goals={{ goals: [] }} />)
  expect(container.textContent).toBe('')
  rerender(<ReadingGoalCard goals={{ goals: [{ year: year - 1, target: 12, completed: 8 }] }} />)
  expect(container.textContent).toBe('')
  rerender(<ReadingGoalCard goals={{ goals: [{ year, target: 12, completed: 15 }] }} />)
  expect(screen.getByText('15 of 12 books')).toBeTruthy()
  expect(screen.getByText('Goal reached')).toBeTruthy()
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('12')
})

it('saves an explicit target, retains it on failed writes, and removes it', async () => {
  const { rerender } = render(<ReadingGoals session={session} />)
  const target = await screen.findByLabelText('Books to finish')
  expect(target.value).toBe('')
  fireEvent.change(target, { target: { value: '24' } })
  api.setReadingGoal.mockResolvedValue({ year, goals: [{ year, target: 24, completed: 3 }] })
  fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))
  await screen.findByText('3 of 24 books finished')
  api.setReadingGoal.mockRejectedValue(new Error('Offline'))
  fireEvent.change(screen.getByLabelText('Books to finish'), { target: { value: '30' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))
  await screen.findByRole('alert')
  expect(screen.getByText('3 of 24 books finished')).toBeTruthy()
  api.removeReadingGoal.mockResolvedValue({ year, goals: [] })
  fireEvent.click(screen.getByRole('button', { name: 'Remove goal' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove goal' })).toBeNull())
  expect(screen.getByLabelText('Books to finish').value).toBe('')
  rerender(<ReadingGoals session={{ ...session, username: 'other' }} />)
  await waitFor(() => expect(screen.getByLabelText('Books to finish').value).toBe(''))
})

it('explains old-server availability only in goal settings', async () => {
  api.readingGoals.mockRejectedValue(Object.assign(new Error('Not found'), { status: 404 }))
  render(<ReadingGoals session={session} />)
  expect(await screen.findByText(/server does not support reading goals/)).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Save goal' })).toBeNull()
})


it('refreshes the mounted editor on return and replaces a locally saved goal only after success', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  try {
    const { unmount } = render(<ReadingGoals session={session} />)
    const input = await screen.findByLabelText('Books to finish')
    fireEvent.change(input, { target: { value: '24' } })
    api.setReadingGoal.mockResolvedValue({ year, goals: [{ year, target: 24, completed: 3 }] })
    fireEvent.click(screen.getByRole('button', { name: 'Save goal' }))
    await screen.findByText('3 of 24 books finished')
    const initialReads = api.readingGoals.mock.calls.length
    visibility.mockReturnValue('hidden')
    fireEvent(document, new Event('visibilitychange'))
    expect(api.readingGoals).toHaveBeenCalledTimes(initialReads)
    let rejectRefresh
    api.readingGoals.mockReturnValueOnce(new Promise((_, reject) => { rejectRefresh = reject }))
    visibility.mockReturnValue('visible')
    fireEvent(document, new Event('visibilitychange'))
    await waitFor(() => expect(api.readingGoals).toHaveBeenCalledTimes(initialReads + 1))
    expect(input.value).toBe('24')
    await act(async () => { rejectRefresh(new Error('Offline')) })
    expect(input.value).toBe('24')
    expect(screen.getByText('3 of 24 books finished')).toBeTruthy()
    api.readingGoals.mockResolvedValueOnce({ year, goals: [{ year, target: 36, completed: 5 }] })
    fireEvent(document, new Event('visibilitychange'))
    await screen.findByText('5 of 36 books finished')
    expect(input.value).toBe('36')
    const finalReads = api.readingGoals.mock.calls.length
    unmount()
    fireEvent(document, new Event('visibilitychange'))
    expect(api.readingGoals).toHaveBeenCalledTimes(finalReads)
  } finally { visibility.mockRestore() }
})
