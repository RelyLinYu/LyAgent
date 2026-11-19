/** Human knowledge actions preserve unrelated grants and never retry ambiguous writes. */
import { expect, it, vi } from 'vitest'
import { KnowledgeController } from '../src/client/controller.ts'

it('loads metadata, preserves other grants and rejects a truncated replacement', async () => {
  const commands: string[] = []
  let truncated = false
  const controller = new KnowledgeController({ command: async (input) => {
    commands.push(input)
    if (input.startsWith('catalog')) return JSON.stringify({ collections: [{ collection: 'manual', title: 'Manual', archived: false, versions: [1, 2] }] })
    if (input === 'list') return JSON.stringify({ pins: [{ collection: 'other', version: 1 }], truncated })
    return 'Saved'
  } })
  const face = controller.face()
  await face.refresh()
  expect(face.hooks.knowledge.getSnapshot().loaded).toBe(true)
  await face.grant('manual', 2)
  expect(commands).toContain('grant [{"collection":"other","version":1},{"collection":"manual","version":2}]')
  truncated = true
  const count = commands.filter(command => command.startsWith('grant ')).length
  await face.grant('manual', 1)
  expect(commands.filter(command => command.startsWith('grant '))).toHaveLength(count)
  expect(face.hooks.knowledge.getSnapshot().error).toBe(true)
  expect(face.hooks.knowledge.getSnapshot().page.collections).toHaveLength(1)
  controller.dispose()
})

it('keeps failed imports visible without automatic retry and ignores retired read completions', async () => {
  let attempts = 0
  const failed = new KnowledgeController({ command: async () => { attempts++; throw new Error('unknown result') } })
  const face = failed.face()
  await face.importFiles('manual', 'Manual', [])
  expect(attempts).toBe(1)
  expect(face.hooks.knowledge.getSnapshot()).toMatchObject({ error: true, busy: false, loaded: false })
  failed.dispose()
  await face.refresh()
  expect(attempts).toBe(1)
  const pending = Promise.withResolvers<string>()
  const retiredCommands: string[] = []
  const controller = new KnowledgeController({ command: (input) => {
    retiredCommands.push(input)
    return input === 'list' ? Promise.resolve('{"pins":[],"truncated":false}') : pending.promise
  } })
  const second = controller.face()
  const load = second.refresh()
  controller.dispose()
  pending.resolve('{"collections":[]}')
  await load
  expect(retiredCommands).toEqual(['catalog'])
  expect(second.hooks.knowledge.getSnapshot().loaded).toBe(false)
})

it('does not replace grants when disposal occurs during the prerequisite read', async () => {
  const pending = Promise.withResolvers<string>()
  const commands: string[] = []
  const controller = new KnowledgeController({ command: (input) => { commands.push(input); return pending.promise } })
  const grant = controller.face().grant('manual', 1)
  controller.dispose()
  pending.resolve('{"pins":[],"truncated":false}')
  await grant
  expect(commands).toEqual(['list'])
})

it('loads the catalog and grants once on mount instead of waiting for a manual refresh', async () => {
  const command = vi.fn(async (input: string) => input === 'list'
    ? '{"pins":[],"truncated":false}'
    : '{"collections":[{"collection":"manual","title":"Manual","archived":false,"versions":[1]}]}')
  const controller = new KnowledgeController({ command })
  const face = controller.face()
  await face.ensureLoaded()
  expect(face.hooks.knowledge.getSnapshot()).toMatchObject({ loaded: true })
  const calls = command.mock.calls.length
  await face.ensureLoaded()
  expect(command.mock.calls.length).toBe(calls)
  controller.dispose()
})

it('stops after bounded mount retries when the knowledge mirror cannot load', async () => {
  const command = vi.fn(async () => { throw new Error('conversation not ready') })
  const controller = new KnowledgeController({ command })
  const face = controller.face()
  await face.ensureLoaded()
  expect(command).toHaveBeenCalledTimes(4)
  expect(face.hooks.knowledge.getSnapshot()).toMatchObject({ loaded: false, error: true })
  controller.dispose()
})
