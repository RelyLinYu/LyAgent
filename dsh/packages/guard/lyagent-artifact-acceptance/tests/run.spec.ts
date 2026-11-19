/** Task transitions over the real JSON domain backend, including independent reopen. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import { RunLedger, runDomain } from '../src/run.ts'

const evidence = { callId: 'delivery', artifacts: [{ path: 'result.md', sha256: 'a'.repeat(64) }],
  evaluators: [{ path: 'test_result.py', sha256: 'b'.repeat(64) }], tests: 1 }

it('serializes ownership, rejects foreign/late results and never completes on idle alone', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-run-'))
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(JsonStorage, { root })
    await ctx.plugin(DomainStorage, { backend: 'json' })
    const domain = await ctx.storageDomain.open(runDomain)
    const ledger = new RunLedger(domain.table('runs'))
    const registration = await Promise.allSettled([
      ledger.create('task', 'parent', 'Produce a tested result'), ledger.create('task', 'foreign', 'Replace it'),
    ])
    expect(registration.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    const starts = await Promise.allSettled([ledger.begin('task', 'parent', 3), ledger.begin('task', 'parent', 3)])
    expect(starts.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const owned = starts[0]
    if (owned?.status !== 'fulfilled') throw new Error('First attempt did not acquire ownership')
    const owner = owned.value
    await ledger.reject('task', owner, 'result.md', 'Required text is absent')
    expect(ledger.read('task')?.rejection).toEqual({ path: 'result.md', reason: 'Required text is absent', turn: 3 })
    await expect(ledger.reject('task', { ...owner, session: 'foreign' }, 'result.md', 'Forged'))
      .rejects.toMatchObject({ code: 'LYAGENT_RUN_REJECTED' })
    await expect(ledger.checked('task', { ...owner, session: 'foreign' }, evidence)).rejects.toMatchObject({ code: 'LYAGENT_RUN_REJECTED' })
    await ledger.settle('task', owner, { end: 'completed', deliveredCallId: undefined, versionsMatch: true,
      failureReasons: ['no final committed independently accepted delivery', 'required work orders are incomplete'] })
    expect(ledger.read('task')?.outcome.state).toBe('needs_attention')
    expect(ledger.read('task')?.outcome).toMatchObject({ reason: 'Task acceptance requires attention: '
      + 'no final committed independently accepted delivery; required work orders are incomplete. '
      + 'Review the recorded evidence before restarting.' })
    await ledger.reserveRepair('task', 'parent', 'work-a', ['work-a', 'work-b'], 1, [{ id: 'independent', revision: 4 }])
    await expect(ledger.reserveRepair('task', 'parent', 'work-a', ['work-a'], 1))
      .rejects.toMatchObject({ code: 'LYAGENT_RUN_REJECTED' })
    expect(ledger.read('task')?.repairs).toEqual([{ target: 'work-a', affected: ['work-a', 'work-b'],
      preserved: [{ id: 'independent', revision: 4 }] }])
    const resumed = await ledger.begin('task', 'parent', 20)
    expect(ledger.read('task')?.rejection).toBeUndefined()
    await expect(ledger.reject('task', owner, 'result.md', 'Late rejection'))
      .rejects.toMatchObject({ code: 'LYAGENT_RUN_REJECTED' })
    await ledger.reject('task', resumed, 'result.md', 'Temporary content failure')
    await expect(ledger.checked('task', owner, evidence)).rejects.toMatchObject({ code: 'LYAGENT_RUN_REJECTED' })
    await ledger.checked('task', resumed, evidence)
    expect(ledger.read('task')?.rejection).toBeUndefined()
    expect(ledger.read('task')?.outcome.state).toBe('checking')
    await ledger.invalidate('task', resumed)
    expect(ledger.read('task')?.outcome).toMatchObject({ state: 'running' })
    expect(ledger.read('task')?.outcome).not.toHaveProperty('evidence')
    await ledger.checked('task', resumed, { ...evidence, callId: 'replacement' })
    expect(ledger.read('task')?.outcome).toMatchObject({ state: 'checking', evidence: { callId: 'replacement' } })
    await ledger.settle('task', resumed, { end: 'completed', deliveredCallId: 'different', versionsMatch: true })
    expect(ledger.read('task')?.outcome.state).toBe('needs_attention')
    const changed = await ledger.begin('task', 'parent', 30)
    await ledger.checked('task', changed, evidence)
    await ledger.settle('task', changed, { end: 'completed', deliveredCallId: 'delivery', versionsMatch: false })
    expect(ledger.read('task')?.outcome.state).toBe('needs_attention')
    const final = await ledger.begin('task', 'parent', 40)
    await ledger.checked('task', final, evidence)
    await expect(ledger.settle('task', final, { end: 'completed', deliveredCallId: 'delivery', versionsMatch: true,
      expectedRevision: 0 })).rejects.toMatchObject({ code: 'LYAGENT_RUN_REJECTED' })
    await ledger.settle('task', final, { end: 'completed', deliveredCallId: 'delivery', versionsMatch: true })
    expect(ledger.read('task')?.outcome.state).toBe('completed')
    await expect(ledger.begin('task', 'parent', 50)).rejects.toMatchObject({ code: 'LYAGENT_RUN_REJECTED' })
    await expect(ledger.cancel('task', 'parent', 'Too late')).rejects.toMatchObject({ code: 'LYAGENT_RUN_REJECTED' })
    const detached = ledger.read('task')!
    detached.objective = 'mutated'
    expect(ledger.read('task')?.objective).toBe('Produce a tested result')
    const pins = [{ collection: 'manual', version: 1, sources: [{ id: 'policy', sha256: 'c'.repeat(64) }] }]
    await ledger.create('criteria-pinned', 'criteria-owner', 'Keep acceptance requirements', undefined, undefined, 'd'.repeat(64))
    expect(ledger.read('criteria-pinned')?.criteriaDigest).toBe('d'.repeat(64))
    const requirements = [{ path: 'extra.md', minBytes: 1, maxBytes: 1000, includes: ['Required'] }]
    await ledger.create('requirements', 'requirements-owner', 'Keep human checks', undefined, undefined, undefined, requirements)
    requirements[0]!.includes.length = 0
    expect(ledger.read('requirements')?.requirements?.[0]?.includes).toEqual(['Required'])
    await ledger.create('sourced', 'parent', 'Keep source versions', pins)
    const workOrders = ['task-1']
    await ledger.create('board', 'parent', 'Keep required work', undefined, workOrders)
    workOrders.length = 0
    expect(ledger.read('board')?.workOrders).toEqual(['task-1'])
    expect(ledger.list('foreign')).toEqual({ tasks: [] })
    expect(ledger.list('parent').tasks.map(task => task.id)).toEqual(['board', 'sourced', 'task'])
    const summaries = ledger.list('parent')
    summaries.tasks[0]!.objective = 'Changed summary'
    expect(ledger.read('board')?.objective).toBe('Keep required work')
    expect(ledger.list('parent', 'sourced').tasks.map(task => task.id)).toEqual(['task'])
    for (let index = 0; index < 51; index++) {
      await ledger.create(`page-${String(index).padStart(2, '0')}`, 'paged', 'x'.repeat(400))
    }
    const firstPage = ledger.list('paged')
    expect(firstPage.tasks).toHaveLength(50)
    expect(firstPage.tasks.every(task => task.objective.length === 240)).toBe(true)
    expect(firstPage.next).toBe('page-49')
    expect(ledger.list('paged', firstPage.next)).toEqual({ tasks: [{ id: 'page-50', objective: 'x'.repeat(240), state: 'queued' }] })
    pins[0]!.sources.length = 0
    expect(ledger.read('sourced')?.knowledge?.[0]?.sources).toHaveLength(1)
    await domain.close()
    const reopened = await ctx.storageDomain.open(runDomain)
    try {
      const restored = new RunLedger(reopened.table('runs'))
      await restored.recover()
      expect(restored.read('task')?.outcome).toMatchObject({ state: 'completed', evidence })
      expect(restored.read('task')?.repairs).toEqual([{ target: 'work-a', affected: ['work-a', 'work-b'],
        preserved: [{ id: 'independent', revision: 4 }] }])
      expect(restored.read('board')?.workOrders).toEqual(['task-1'])
      expect(restored.read('criteria-pinned')?.criteriaDigest).toBe('d'.repeat(64))
      expect(restored.read('requirements')?.requirements).toEqual([{
        path: 'extra.md', minBytes: 1, maxBytes: 1000, includes: ['Required'],
      }])
      expect(restored.read('sourced')?.knowledge).toEqual([{ collection: 'manual', version: 1,
        sources: [{ id: 'policy', sha256: 'c'.repeat(64) }] }])
    } finally { await reopened.close() }
  } finally {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})

it('recovers interrupted checks without replay and cancellation invalidates every pending owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-run-restart-'))
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(JsonStorage, { root })
    await ctx.plugin(DomainStorage, { backend: 'json' })
    const domain = await ctx.storageDomain.open(runDomain)
    const ledger = new RunLedger(domain.table('runs'))
    await ledger.create('task', 'parent', 'Test restart recovery')
    const old = await ledger.begin('task', 'parent', 1)
    await ledger.checked('task', old, evidence)
    await domain.close()
    const reopened = await ctx.storageDomain.open(runDomain)
    try {
      const restored = new RunLedger(reopened.table('runs'))
      await restored.recover()
      expect(restored.read('task')?.outcome.state).toBe('needs_attention')
      await expect(restored.settle('task', old, { end: 'completed', deliveredCallId: 'delivery', versionsMatch: true }))
        .rejects.toMatchObject({ code: 'LYAGENT_RUN_REJECTED' })
      const owner = await restored.begin('task', 'parent', 2)
      await expect(restored.cancel('task', 'foreign', 'Cancel')).rejects.toMatchObject({ code: 'LYAGENT_RUN_REJECTED' })
      await restored.cancel('task', 'parent', 'User cancelled')
      await expect(restored.checked('task', owner, evidence)).rejects.toMatchObject({ code: 'LYAGENT_RUN_REJECTED' })
      await expect(restored.settle('task', owner, { end: 'completed', deliveredCallId: 'delivery', versionsMatch: true }))
        .rejects.toMatchObject({ code: 'LYAGENT_RUN_REJECTED' })
      expect(restored.read('task')?.outcome.state).toBe('cancelled')
      expect(restored.list('parent').tasks.find(task => task.id === 'task')?.reason).toBe('User cancelled')
      await restored.create('long-diagnostic', 'parent', 'Bound the public diagnostic')
      await restored.cancel('long-diagnostic', 'parent', 'x'.repeat(2500))
      expect(restored.list('parent').tasks.find(task => task.id === 'long-diagnostic')?.reason).toHaveLength(2000)
      expect(restored.list('foreign').tasks).toEqual([])
      await restored.create('abort', 'parent', 'Native cancellation')
      const aborted = await restored.begin('abort', 'parent', 3)
      await restored.settle('abort', aborted, { end: 'aborted', deliveredCallId: undefined, versionsMatch: false })
      expect(restored.read('abort')?.outcome.state).toBe('cancelled')
    } finally { await reopened.close() }
  } finally {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})
