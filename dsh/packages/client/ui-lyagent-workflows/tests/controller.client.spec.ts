/** Keyless command mirror and uncertain write regressions. */
import { expect, it, vi } from 'vitest'
import { WorkflowController } from '../src/client/controller.ts'

it('loads metadata atomically and reads exact team editions', async () => {
  const command = vi.fn(async (input: string) => {
    if (input === 'catalog') return JSON.stringify({
      workflows: [{ id: 'flow', version: 2, description: 'Flow' }],
      teams: [{ id: 'review', version: 3, description: 'Reviewer', kind: 'profile' }],
    })
    return JSON.stringify({ definition: { kind: 'profile', description: 'Old reviewer', instructions: 'Review', provider: 'fixture', model: 'scripted', enabled: true } })
  })
  const controller = new WorkflowController(command)
  const face = controller.face()
  await face.refresh()
  expect(face.hooks.catalog.getSnapshot()).toMatchObject({ loaded: true, busy: false, error: false, workflows: [{ id: 'flow', version: 2 }] })
  expect(await face.read('profile', 'review', 1)).toMatchObject({ kind: 'profile', description: 'Old reviewer' })
  expect(command).toHaveBeenLastCalledWith('read-team review 1')
  controller.dispose()
})

it('does not retry uncertain publication and retains the previous mirror on malformed refresh', async () => {
  const command = vi.fn(async (input: string) => {
    if (input === 'catalog') return '{"workflows":[],"teams":[]}'
    throw new Error('transport closed after write')
  })
  const face = new WorkflowController(command).face()
  await face.refresh()
  expect(await face.save('workflow', 'flow', 0, { description: 'Flow', script: 'return 1' })).toBe(false)
  expect(command.mock.calls.filter(([input]) => input.startsWith('publish '))).toHaveLength(1)
  expect(face.hooks.catalog.getSnapshot()).toMatchObject({ loaded: true, error: true, saved: false, busy: false })
  command.mockResolvedValueOnce('not JSON')
  await face.refresh()
  expect(face.hooks.catalog.getSnapshot()).toMatchObject({ workflows: [], teams: [], error: true })
})

it('acknowledges a committed edition even if subsequent catalog refresh fails', async () => {
  const command = vi.fn(async (input: string) => {
    if (input.startsWith('publish-team ')) return '{}'
    throw new Error('refresh unavailable')
  })
  const face = new WorkflowController(command).face()
  expect(await face.save('profile', 'review', 1, { description: 'Reviewer' })).toBe(true)
  expect(face.hooks.catalog.getSnapshot()).toMatchObject({ error: true, saved: true, busy: false })
  expect(command.mock.calls[0]?.[0]).toBe('publish-team {"id":"review","expectedVersion":1,"definition":{"kind":"profile","description":"Reviewer"}}')
})

it('refuses concurrent actions and ignores catalog completions after disposal', async () => {
  let release: (value: string) => void = () => { throw new Error('not started') }
  const command = vi.fn(() => new Promise<string>((resolve) => { release = resolve }))
  const controller = new WorkflowController(command)
  const face = controller.face()
  const loading = face.refresh()
  expect(await face.run('flow', 1)).toBe(false)
  expect(await face.read('workflow', 'flow', 1)).toBeUndefined()
  controller.dispose()
  release('[]')
  await loading
  await face.refresh()
  expect(command).toHaveBeenCalledTimes(1)
  expect(face.hooks.catalog.getSnapshot().loaded).toBe(false)
})

it('runs and reads pinned scripts and reports failed reads without replacing data', async () => {
  const command = vi.fn(async (input: string): Promise<string> => input.startsWith('read ') ? '{"description":"Flow","script":"return 1"}' : '{}')
  const face = new WorkflowController(command).face()
  expect(await face.run('flow', 7)).toBe(true)
  expect(command).toHaveBeenLastCalledWith('run flow 7')
  expect(await face.read('workflow', 'flow', 2)).toMatchObject({ script: 'return 1' })
  command.mockResolvedValueOnce('null')
  expect(await face.read('workflow', 'flow', 2)).toBeUndefined()
  expect(face.hooks.catalog.getSnapshot().error).toBe(true)
})

it('loads the catalog once on mount instead of waiting for a manual refresh', async () => {
  const command = vi.fn(async (input: string) => input === 'catalog'
    ? '{"workflows":[{"id":"flow","version":1,"description":"Flow"}],"teams":[]}' : '{}')
  const controller = new WorkflowController(command)
  const face = controller.face()
  await face.ensureLoaded()
  expect(face.hooks.catalog.getSnapshot()).toMatchObject({ loaded: true })
  const calls = command.mock.calls.length
  await face.ensureLoaded()
  expect(command.mock.calls.length).toBe(calls)
  controller.dispose()
})

it('stops after bounded mount retries when the command surface is unavailable', async () => {
  const command = vi.fn(async () => { throw new Error('conversation not ready') })
  const controller = new WorkflowController(command)
  const face = controller.face()
  await face.ensureLoaded()
  expect(command).toHaveBeenCalledTimes(4)
  expect(face.hooks.catalog.getSnapshot()).toMatchObject({ loaded: false, error: true, busy: false })
  controller.dispose()
})
