/** Client task command lifecycle without implicit dispatch or uncertain retries. */
import { describe, expect, it, vi } from 'vitest'
import { TaskController } from '../src/client/controller.ts'

const page = JSON.stringify({ tasks: [{ id: 'one', objective: 'Deliver a report', state: 'queued' }] })
const criteria = JSON.stringify({ artifacts: [{ path: 'report.md', minBytes: 1, maxBytes: 1000 }], minTests: 1, maxRepairs: 1 })
const read = (input: string): string => input === 'criteria' ? criteria : page

describe('task command controller', () => {
  it('retains bounded host diagnostics and rejects oversized replacement pages', async () => {
    let reason = 'Budget usage remains unknown. Review prior effects before restarting.'
    const face = new TaskController({ command: async input => input === 'criteria' ? criteria
      : JSON.stringify({ tasks: [{ id: 'one', objective: 'Report', state: 'needs_attention', reason }] }) }).face()
    await face.refresh()
    expect(face.hooks.tasks.getSnapshot().page.tasks[0]?.reason).toBe(reason)
    reason = 'x'.repeat(2001)
    await face.refresh()
    expect(face.hooks.tasks.getSnapshot().error).toBe(true)
    expect(face.hooks.tasks.getSnapshot().page.tasks[0]?.reason).toContain('Budget usage remains unknown')
  })

  it('registers additional literal checks without replacing deployment criteria', async () => {
    const command = vi.fn(async (input: string) => input.startsWith('define ') ? 'Registered one' : read(input))
    const face = new TaskController({ command }).face()
    expect(await face.register('Report', { path: 'extra.md', includes: 'Required' })).toBe(false)
    expect(command).not.toHaveBeenCalled()
    await face.refresh()
    expect(await face.register(' Report ', { path: ' extra.md ', includes: 'Required\n\nSecond' })).toBe(true)
    const before = command.mock.calls.length
    expect(await face.register('Report', { path: ' ', includes: 'Required' })).toBe(false)
    expect(command.mock.calls).toHaveLength(before)
    const definition = command.mock.calls.find(([input]) => input.startsWith('define '))?.[0]
    expect(JSON.parse(definition!.slice(7))).toEqual({ objective: 'Report', requirements: [{
      path: 'extra.md', minBytes: 1, maxBytes: 1000, includes: ['Required', 'Second'],
    }] })
    expect(command.mock.calls.some(([input]) => input.startsWith('run '))).toBe(false)
  })

  it('registers explicitly without starting a model turn', async () => {
    const command = vi.fn(async (input: string) => input.startsWith('new ') ? 'Registered one' : read(input))
    const face = new TaskController({ command }).face()
    expect(await face.register('  Deliver a report  ')).toBe(true)
    expect(command.mock.calls.map(([input]) => input)).toEqual(['new Deliver a report', 'list', 'criteria'])
    expect(face.hooks.tasks.getSnapshot()).toMatchObject({ loaded: true, busy: false, error: false, page: { tasks: [{ id: 'one' }] } })
  })

  it('retains visible records and does not retry an uncertain mutation', async () => {
    const command = vi.fn(async (input: string) => {
      if (input.startsWith('new ')) throw new Error('Transport closed after dispatch')
      return read(input)
    })
    const face = new TaskController({ command }).face()
    await face.refresh()
    expect(await face.register('Deliver a report')).toBe(false)
    expect(command.mock.calls.map(([input]) => input)).toEqual(['list', 'criteria', 'new Deliver a report'])
    expect(face.hooks.tasks.getSnapshot()).toMatchObject({ loaded: true, busy: false, error: true, page: { tasks: [{ id: 'one' }] } })
  })

  it('allows cancellation while the run command awaits settlement', async () => {
    let finish: (value: string) => void = () => { throw new Error('Run not started') }
    const command = vi.fn((input: string) => input === 'run one'
      ? new Promise<string>((resolve) => { finish = resolve })
      : Promise.resolve(input === 'cancel one' ? 'Cancellation requested' : read(input)))
    const face = new TaskController({ command }).face()
    const running = face.run('one')
    expect(face.hooks.tasks.getSnapshot()).toMatchObject({ busy: true, running: 'one' })
    await face.cancel('one')
    expect(command.mock.calls.map(([input]) => input)).toEqual(['run one', 'cancel one'])
    finish('Cancelled')
    await running
    expect(command.mock.calls.map(([input]) => input)).toEqual(['run one', 'cancel one', 'list', 'criteria'])
    expect(face.hooks.tasks.getSnapshot()).toMatchObject({ busy: false, cancelling: false, running: undefined })
  })

  it('ignores late reads and never issues the next read after disposal', async () => {
    let finish: (value: string) => void = () => { throw new Error('Read not started') }
    const command = vi.fn(() => new Promise<string>((resolve) => { finish = resolve }))
    const controller = new TaskController({ command })
    const face = controller.face()
    const loading = face.refresh()
    controller.dispose()
    finish(page)
    await loading
    await face.refresh()
    await face.cancel('one')
    expect(await face.register('Late task')).toBe(false)
    expect(command).toHaveBeenCalledTimes(1)
    expect(face.hooks.tasks.getSnapshot().loaded).toBe(false)
  })

  it('rejects malformed host data without publishing a partial refresh', async () => {
    const command = vi.fn(async (input: string) => input === 'criteria' ? '{}' : page)
    const face = new TaskController({ command }).face()
    await face.refresh()
    expect(face.hooks.tasks.getSnapshot()).toMatchObject({ loaded: false, error: true, page: { tasks: [] } })
  })

  it('rejects blank registration before transport and excludes overlapping refreshes', async () => {
    let finish: (value: string) => void = () => { throw new Error('Read not started') }
    const command = vi.fn((input: string) => input === 'criteria' ? Promise.resolve(criteria)
      : new Promise<string>((resolve) => { finish = resolve }))
    const face = new TaskController({ command }).face()
    expect(await face.register('  ')).toBe(false)
    expect(command).not.toHaveBeenCalled()
    const loading = face.refresh('cursor')
    await face.refresh()
    expect(await face.register('Another task')).toBe(false)
    expect(command.mock.calls.map(([input]) => input)).toEqual(['list cursor'])
    finish(page)
    await loading
    expect(face.hooks.tasks.getSnapshot().error).toBe(false)
  })
})

it('loads the first page once on mount instead of waiting for a manual refresh', async () => {
  const command = vi.fn(async (input: string) => input === 'list'
    ? '{"tasks":[{"id":"one","objective":"Deliver","state":"queued"}],"next":"cursor"}'
    : '{"artifacts":[],"minTests":0,"maxRepairs":0}')
  const controller = new TaskController({ command })
  const face = controller.face()
  await face.ensureLoaded()
  expect(face.hooks.tasks.getSnapshot()).toMatchObject({ loaded: true })
  const calls = command.mock.calls.length
  await face.ensureLoaded()
  expect(command.mock.calls.length).toBe(calls)
  controller.dispose()
})

it('stops after bounded mount retries when the task mirror cannot load', async () => {
  const command = vi.fn(async () => { throw new Error('conversation not ready') })
  const controller = new TaskController({ command })
  const face = controller.face()
  await face.ensureLoaded()
  expect(command).toHaveBeenCalledTimes(4)
  expect(face.hooks.tasks.getSnapshot()).toMatchObject({ loaded: false, error: true, busy: false })
  controller.dispose()
})
