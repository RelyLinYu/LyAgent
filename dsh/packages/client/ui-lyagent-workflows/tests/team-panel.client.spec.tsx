// @vitest-environment jsdom
/** Exact role pins stay explicit when newer profiles exist. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { WorkflowPanel } from '../src/client/Panel.tsx'
import { WorkflowController } from '../src/client/controller.ts'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

it('publishes an older profile pin and prevents duplicate roles', async () => {
  const controller = new WorkflowController(async input => input === 'catalog'
    ? '{"workflows":[],"teams":[{"id":"review","version":3,"description":"Reviewer","kind":"profile"}]}' : '[]')
  const face = controller.face()
  await face.refresh()
  const snapshot = face.hooks.catalog.getSnapshot()
  const save = vi.fn(async () => true)
  const props = { ...face, save, t: (key: keyof typeof en, params?: Record<string, string>) => (en[key] ?? String(key))
      .replace(/\{(\w+)\}/g, (_match: string, name: string) => params?.[name] ?? `{${name}}`),
    useCatalog: (selector: (state: typeof snapshot) => unknown) => selector(snapshot),
  } as Parameters<typeof WorkflowPanel>[0]
  render(<WorkflowPanel {...props} />)
  fireEvent.click(screen.getByRole('tab', { name: 'Teams' }))
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Review team' } })
  fireEvent.click(screen.getByRole('button', { name: 'Add member' }))
  fireEvent.change(screen.getByLabelText('Role name'), { target: { value: 'review' } })
  fireEvent.click(screen.getByRole('button', { name: 'Role version' }))
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Reviewer v3' }))
  fireEvent.change(screen.getByLabelText('review Version'), { target: { value: '1' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save version' }))
  await waitFor(() => {
    expect(save).toHaveBeenCalledWith('team', expect.any(String), 0,
      { description: 'Review team', members: [{ role: 'review', profile: { id: 'review', version: 1 } }] })
  })
  fireEvent.click(screen.getByRole('button', { name: 'Add member' }))
  fireEvent.change(screen.getAllByLabelText('Role name')[1]!, { target: { value: 'review' } })
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save version' }).disabled).toBe(true)
  controller.dispose()
})
