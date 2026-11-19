// @vitest-environment jsdom
/** Import forms keep generated identities out of user input and reset native file selection. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { KnowledgePanel } from '../src/client/Panel.tsx'
import { KnowledgeController } from '../src/client/controller.ts'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

it('imports a generated collection, selects an existing edition and clears file selection for a new collection', async () => {
  const controller = new KnowledgeController({ command: async input => input === 'list'
    ? '{"pins":[],"truncated":false}'
    : '{"collections":[{"collection":"manual","title":"Manual","archived":false,"versions":[1]}]}' })
  const face = controller.face()
  await face.refresh()
  const importFiles = vi.fn(async () => {})
  const snapshot = face.hooks.knowledge.getSnapshot()
  const ensureLoaded = vi.fn(async () => {})
  const props = {
    ...face, importFiles, ensureLoaded,
    useTabInfo: vi.fn(),
    t: (key: keyof typeof en) => en[key],
    useKnowledge: (selector: (state: typeof snapshot) => unknown) => selector(snapshot),
  } as Parameters<typeof KnowledgePanel>[0]
  render(<KnowledgePanel {...props} />)
  expect(ensureLoaded).toHaveBeenCalled()
  expect(screen.queryByLabelText('Collection ID')).toBeNull()
  fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'Notes' } })
  const files = screen.getByLabelText<HTMLInputElement>('Text files')
  const file = new File(['Synthetic notes'], 'notes.txt', { type: 'text/plain' })
  fireEvent.change(files, { target: { files: [file] } })
  fireEvent.click(screen.getByRole('button', { name: 'Import files' }))
  expect(importFiles).toHaveBeenCalledWith(expect.stringMatching(/^refs_[a-f0-9-]+$/), 'Notes', [file])
  fireEvent.click(screen.getByRole('button', { name: 'Import new version' }))
  expect(screen.getByLabelText<HTMLInputElement>('New version of collection').value).toBe('Manual')
  expect(document.activeElement).toBe(files)
  fireEvent.click(screen.getByRole('button', { name: 'Import files' }))
  expect(importFiles).toHaveBeenLastCalledWith('manual', 'Manual', [file])
  fireEvent.click(screen.getByRole('button', { name: 'New collection' }))
  expect(screen.getByLabelText<HTMLInputElement>('Collection name').value).toBe('')
  expect(files.value).toBe('')
  expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Import files' }).disabled).toBe(true)
  controller.dispose()
})
