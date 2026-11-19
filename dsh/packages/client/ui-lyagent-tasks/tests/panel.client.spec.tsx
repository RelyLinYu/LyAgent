// @vitest-environment jsdom
/** Explicit task actions retain uncertain drafts and keep cancellation reachable. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { TaskPanel } from '../src/client/Panel.tsx'
import { TaskController } from '../src/client/controller.ts'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

it('shows the host attention reason beside its task without starting execution', async () => {
  const f = await fixture()
  try {
    const reason = 'Budget usage remains unknown. Review prior effects before restarting.'
    const snapshot = { ...f.snapshot, page: { tasks: [{
      id: 'one', objective: 'Deliver a report', state: 'needs_attention' as const, reason,
    }] } }
    const props = {
      ...f.props, useTasks: (selector: (state: typeof snapshot) => unknown) => selector(snapshot),
    } as Parameters<typeof TaskPanel>[0]
    render(<TaskPanel {...props} />)
    expect(screen.getByText(reason)).toBeTruthy()
    expect(f.run).not.toHaveBeenCalled()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run' }).disabled).toBe(false)
  } finally { f.controller.dispose() }
})

async function fixture() {
  const controller = new TaskController({ command: async input => input === 'criteria'
    ? JSON.stringify({ artifacts: [{ path: 'report.md', minBytes: 1, maxBytes: 1000 }], minTests: 1, maxRepairs: 1 })
    : JSON.stringify({ tasks: [{ id: 'one', objective: 'Deliver a report', state: 'queued' }], next: 'cursor' }) })
  const face = controller.face()
  await face.refresh()
  const snapshot = face.hooks.tasks.getSnapshot()
  const register = vi.fn(async (_objective: string) => false)
  const run = vi.fn(async (_id: string) => {})
  const cancel = vi.fn(async (_id: string) => {})
  const refresh = vi.fn(async (_after?: string) => {})
  const ensureLoaded = vi.fn(async () => {})
  const props = { register, run, cancel, refresh, ensureLoaded,
    t: (key: keyof typeof en) => en[key],
    useTasks: (selector: (state: typeof snapshot) => unknown) => selector(snapshot),
  } as Parameters<typeof TaskPanel>[0]
  return { controller, snapshot, props, register, run, cancel, refresh }
}

it('retains a failed registration draft and clears only a confirmed registration', async () => {
  const f = await fixture()
  try {
    render(<TaskPanel {...f.props} />)
    expect(f.props.ensureLoaded).toHaveBeenCalled()
    const input = screen.getByLabelText<HTMLInputElement>('Task objective')
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Register task' }).disabled).toBe(true)
    fireEvent.change(input, { target: { value: 'Produce an audited report' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register task' }))
    await waitFor(() =>{  expect(f.register).toHaveBeenCalledWith('Produce an audited report') })
    expect(input.value).toBe('Produce an audited report')
    expect(f.run).not.toHaveBeenCalled()
    f.register.mockResolvedValue(true)
    fireEvent.click(screen.getByRole('button', { name: 'Register task' }))
    await waitFor(() =>{  expect(input.value).toBe('') })
  } finally { f.controller.dispose() }
})

it('preserves literal requirements when their path is cleared before submission', async () => {
  const f = await fixture()
  try {
    render(<TaskPanel {...f.props} />)
    fireEvent.change(screen.getByLabelText('Task objective'), { target: { value: 'Required report' } })
    fireEvent.change(screen.getByLabelText(en.artifactPath), { target: { value: 'extra.md' } })
    fireEvent.change(screen.getByLabelText(en.requiredText), { target: { value: 'Keep this requirement' } })
    fireEvent.change(screen.getByLabelText(en.artifactPath), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Register task' }))
    await waitFor(() =>{  expect(f.register).toHaveBeenCalledWith('Required report', { path: '', includes: 'Keep this requirement' }) })
    expect(screen.getByLabelText<HTMLInputElement>(en.requiredText).value).toBe('Keep this requirement')
  } finally { f.controller.dispose() }
})

it('routes run, cancellation and pagination through explicit callbacks', async () => {
  const f = await fixture()
  try {
    render(<TaskPanel {...f.props} />)
    expect(screen.getByText('report.md')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    expect(f.run).toHaveBeenCalledWith('one')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(f.cancel).toHaveBeenCalledWith('one')
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }))
    expect(f.refresh).toHaveBeenCalledWith('cursor')
  } finally { f.controller.dispose() }
})

it('keeps the active task cancellable while blocking unrelated mutations', async () => {
  const f = await fixture()
  try {
    const snapshot = { ...f.snapshot, busy: true, running: 'one', error: true }
    const props = {
      ...f.props, useTasks: (selector: (state: typeof snapshot) => unknown) => selector(snapshot),
    } as Parameters<typeof TaskPanel>[0]
    render(<TaskPanel {...props} />)
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull()
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh' }).disabled).toBe(true)
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Cancel' }).disabled).toBe(false)
    expect(screen.getByLabelText<HTMLInputElement>('Task objective').disabled).toBe(true)
    expect(screen.getByText(en.failed)).toBeTruthy()
  } finally { f.controller.dispose() }
})
