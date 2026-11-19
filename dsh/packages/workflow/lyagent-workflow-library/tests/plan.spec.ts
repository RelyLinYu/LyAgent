/** Compilation preserves fixed editions, dependencies and bounded branch execution. */
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { compilePlan } from '../src/plan.ts'
import type { WorkflowEdition } from '../src/store.ts'

const edition = (script: string): WorkflowEdition => ({ version: 1, description: 'Fixture', script,
  sha256: createHash('sha256').update(script).digest('hex'), knowledge: [], knowledgeMode: 'human' })
const definitions = new Map([['source', edition('return { route: "yes" }')],
  ['yes', edition('return { selected: "yes", dependencies: Object.keys(args) }')],
  ['no', edition('throw new Error("Unselected branch ran")')],
  ['iteration', edition('return args.iteration')]])
const read = (id: string): WorkflowEdition => {
  const found = definitions.get(id)
  if (found === undefined) throw new Error('Missing fixed edition')
  return found
}

it('embeds fixed nested editions with sequential dependencies, parallel layers, branches and finite loops', async () => {
  const compiled = compilePlan({ id: 'combined', expectedVersion: 0, description: 'Five structures', nodes: [
    { id: 'source', kind: 'saved', dependsOn: [], retry: 1, workflow: { id: 'source', version: 1 } },
    { id: 'independent', kind: 'repeat', dependsOn: [], retry: 1, count: 3, workflow: { id: 'iteration', version: 1 } },
    { id: 'choose', kind: 'branch', dependsOn: ['source'], retry: 1, source: 'source', path: ['route'], equals: 'yes',
      then: { id: 'yes', version: 1 }, otherwise: { id: 'no', version: 1 } },
  ] }, read)
  const result: unknown = await runInNewContext(`(async () => { ${compiled.script} })()`, {
    agent: () => { throw new Error('No model expected') },
    parallel: (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map(thunk => thunk())),
    phase: () => {},
  })
  expect(result)
    .toEqual({ source: { route: 'yes' }, independent: [0, 1, 2], choose: { selected: 'yes', dependencies: ['source'] } })
  expect(compiled.script).toContain(`sha256=${read('source').sha256}`)
})

it('rejects cycles, missing dependencies, duplicate nodes and undeclared branch sources before execution', () => {
  const saved = { id: 'a', kind: 'saved' as const, dependsOn: ['b'], retry: 1, workflow: { id: 'source', version: 1 } }
  const plan = { id: 'invalid', expectedVersion: 0, description: 'Invalid' }
  expect(() => compilePlan({ ...plan, nodes: [saved] }, read)).toThrow('dependencies')
  expect(() => compilePlan({ ...plan, nodes: [saved, { ...saved, id: 'b', dependsOn: ['a'] }] }, read)).toThrow('cycle')
  expect(() => compilePlan({ ...plan, nodes: [{ ...saved, dependsOn: [] }, { ...saved, dependsOn: [] }] }, read)).toThrow('unique')
  expect(() => compilePlan({ ...plan, nodes: [{ id: 'branch', kind: 'branch', dependsOn: [], retry: 1, source: 'a', path: [],
    equals: true, then: { id: 'yes', version: 1 }, otherwise: { id: 'no', version: 1 } }] }, read)).toThrow('explicit dependency')
})

it('stops later iterations and dependent layers after an unsuccessful nested result', async () => {
  const compiled = compilePlan({ id: 'failed-loop', expectedVersion: 0, description: 'Stop on null', nodes: [
    { id: 'loop', kind: 'repeat', dependsOn: [], retry: 1, count: 3, workflow: { id: 'null', version: 1 } },
    { id: 'dependent', kind: 'agent', dependsOn: ['loop'], retry: 1, prompt: 'Must not start', provider: 'fixture', model: 'fixture' },
  ] }, () => edition('return null'))
  let children = 0
  const result: unknown = runInNewContext(`(async () => { ${compiled.script} })()`, {
    agent: () => { children++ },
    parallel: (thunks: (() => Promise<unknown>)[]) => Promise.all(thunks.map(thunk => thunk().catch(() => null))),
    phase: () => {},
  })
  await expect(result).rejects.toThrow('dependent nodes were not started')
  expect(children).toBe(0)
})
