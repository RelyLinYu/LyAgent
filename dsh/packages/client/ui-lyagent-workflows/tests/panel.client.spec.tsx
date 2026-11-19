// @vitest-environment jsdom
/** Draft retention and exact-version workflow actions. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkflowPanel } from '../src/client/Panel.tsx'
import { WorkflowController } from '../src/client/controller.ts'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

it('retains failed drafts, blocks switching and submits generated identities', async () => {
  const controller = new WorkflowController(async () => '[]')
  const face = controller.face()
  const snapshot = face.hooks.catalog.getSnapshot()
  const save = vi.fn(async () => false)
  const props = { ...face, save, t: (key: keyof typeof en) => en[key],
    useCatalog: (selector: (state: typeof snapshot) => unknown) => selector(snapshot),
  } as Parameters<typeof WorkflowPanel>[0]
  const view = render(<WorkflowPanel {...props} />)
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Reviewer' } })
  fireEvent.change(screen.getByLabelText('Instructions'), { target: { value: 'Review evidence' } })
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: 'fixture' } })
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'scripted' } })
  expect(screen.getByRole<HTMLButtonElement>('tab', { name: 'Teams' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Save version' }))
  await waitFor(() =>{  expect(save).toHaveBeenCalledTimes(1) })
  expect(save).toHaveBeenCalledWith('profile', expect.stringMatching(/^definition_/), 0,
    { description: 'Reviewer', instructions: 'Review evidence', provider: 'fixture', model: 'scripted', enabled: true })
  expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Reviewer')
  expect(screen.getByRole<HTMLButtonElement>('tab', { name: 'Workflows' }).disabled).toBe(true)
  view.unmount()
  render(<WorkflowPanel {...props} />)
  expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('Reviewer')
  expect(screen.getByRole<HTMLButtonElement>('tab', { name: 'Teams' }).disabled).toBe(true)
  controller.dispose()
})

it('reads a saved workflow and runs only the selected version', async () => {
  const controller = new WorkflowController(async input => input === 'catalog'
    ? '{"workflows":[{"id":"flow","version":4,"description":"Saved flow"}],"teams":[]}' : '[]')
  const face = controller.face()
  await face.refresh()
  const snapshot = face.hooks.catalog.getSnapshot()
  const run = vi.fn(async () => true)
  const save = vi.fn(async () => true)
  const read = vi.fn(async () => ({ description: 'Saved flow', script: 'return 4' }))
  const ensureLoaded = vi.fn(async () => {})
  const props = { ...face, run, read, save, ensureLoaded, t: (key: keyof typeof en) => en[key],
    useCatalog: (selector: (state: typeof snapshot) => unknown) => selector(snapshot),
  } as Parameters<typeof WorkflowPanel>[0]
  render(<WorkflowPanel {...props} />)
  expect(ensureLoaded).toHaveBeenCalled()
  fireEvent.click(screen.getByRole('tab', { name: 'Workflows' }))
  fireEvent.change(screen.getByLabelText('Saved flow Version'), { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Select' }))
  await screen.findByDisplayValue('return 4')
  expect(read).toHaveBeenCalledWith('workflow', 'flow', 2)
  fireEvent.click(screen.getByRole('button', { name: 'Run selected version' }))
  expect(run).toHaveBeenCalledWith('flow', 2)
  fireEvent.change(screen.getByLabelText('Workflow script'), { target: { value: 'return 5' } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run selected version' }).disabled).toBe(true)
  fireEvent.click(screen.getByRole('button', { name: 'Save version' }))
  await waitFor(() => { expect(save).toHaveBeenCalledWith('workflow', 'flow', 4, { description: 'Saved flow', script: 'return 5' }) })
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Run selected version' }).disabled).toBe(false) })
  fireEvent.click(screen.getByRole('button', { name: 'Run selected version' }))
  expect(run).toHaveBeenLastCalledWith('flow', 5)
  controller.dispose()
})
