// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

vi.mock('./api.js', () => ({ isApp: false, api: {} }))
vi.mock('./tabbar.js', () => ({ useSheet() {} }))
import { ActionSheet, Sheet } from './ui.jsx'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it.each([undefined, 'Name'])('blocks duplicate submissions and dismissal while pending (input: %s)', async (inputLabel) => {
  const nativeConfirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
  const nativePrompt = vi.spyOn(window, 'prompt').mockReturnValue(null)
  let fail
  const onConfirm = vi.fn().mockImplementationOnce(() => new Promise((_, reject) => { fail = reject })).mockResolvedValue(undefined)
  const onClose = vi.fn()
  render(<ActionSheet title="Confirm action" actionLabel="Apply" pendingLabel="Applying…" inputLabel={inputLabel} initialValue="Selected name" onConfirm={onConfirm} onClose={onClose} />)
  const dialog = screen.getByRole('dialog')
  const submit = within(dialog).getByRole('button', { name: 'Apply' })
  const form = submit.closest('form')
  act(() => {
    fireEvent.submit(form)
    fireEvent.submit(form)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  })
  fireEvent.click(submit)
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
  // The Sheet backdrop shares the same guarded close action.
  fireEvent.click(dialog.previousElementSibling)
  expect(onConfirm).toHaveBeenCalledExactlyOnceWith('Selected name')
  expect(onClose).not.toHaveBeenCalled()
  expect(submit.disabled).toBe(true)
  expect(within(dialog).getByRole('button', { name: 'Cancel' }).disabled).toBe(true)
  if (inputLabel) expect(within(dialog).getByRole('textbox').disabled).toBe(true)
  fail(new Error('Server unavailable'))
  expect((await within(dialog).findByRole('alert')).textContent).toBe('Server unavailable')
  expect(submit.disabled).toBe(false)
  if (inputLabel) expect(within(dialog).getByRole('textbox').value).toBe('Selected name')
  fireEvent.click(submit)
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  expect(onConfirm).toHaveBeenCalledTimes(2)
  expect(nativeConfirm).not.toHaveBeenCalled()
  expect(nativePrompt).not.toHaveBeenCalled()
})

it('moves focus inside, wraps Tab in both directions, and restores the opener on close', () => {
  const opener = <button>Open confirmation</button>
  const { rerender } = render(<>{opener}</>)
  const trigger = screen.getByRole('button', { name: 'Open confirmation' })
  trigger.focus()
  rerender(<>{opener}<ActionSheet title="Confirm" actionLabel="Apply" pendingLabel="Applying…" onConfirm={vi.fn()} onClose={vi.fn()} /></>)
  const dialog = screen.getByRole('dialog')
  const close = within(dialog).getByRole('button', { name: 'Close' })
  const cancel = within(dialog).getByRole('button', { name: 'Cancel' })
  expect(document.activeElement).toBe(close)
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(cancel)
  fireEvent.keyDown(cancel, { key: 'Tab' })
  expect(document.activeElement).toBe(close)
  trigger.focus()
  expect(dialog.contains(document.activeElement)).toBe(true)
  rerender(<>{opener}</>)
  expect(document.activeElement).toBe(trigger)
})

it('preserves text-input autofocus when opening a prompt', () => {
  render(<ActionSheet title="Name" inputLabel="New name" actionLabel="Save" pendingLabel="Saving…" onConfirm={vi.fn()} onClose={vi.fn()} />)
  expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'New name' }))
})

it('keeps focus in the top sheet and returns it to the underlying sheet when closed', () => {
  const parent = <Sheet title="Parent" onClose={vi.fn()}><button>Open another sheet</button></Sheet>
  const { rerender } = render(<>{parent}</>)
  const trigger = screen.getByRole('button', { name: 'Open another sheet' })
  trigger.focus()
  rerender(<>{parent}<Sheet title="Child" onClose={vi.fn()}><button disabled>Unavailable</button><button>Child action</button></Sheet></>)
  const child = screen.getByRole('dialog', { name: 'Child' })
  expect(child.contains(document.activeElement)).toBe(true)
  trigger.focus()
  expect(child.contains(document.activeElement)).toBe(true)
  const close = within(child).getByRole('button', { name: 'Close' })
  const last = within(child).getByRole('button', { name: 'Child action' })
  fireEvent.keyDown(close, { key: 'Tab', shiftKey: true })
  expect(document.activeElement).toBe(last)
  fireEvent.keyDown(last, { key: 'Tab' })
  expect(document.activeElement).toBe(close)
  rerender(<>{parent}</>)
  expect(document.activeElement).toBe(trigger)
})
