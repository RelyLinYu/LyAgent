/** Retry classification, rework graph integrity and nested-edition traceability. */
import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { compilePlan } from '../src/plan.ts'
import type { WorkflowEdition } from '../src/store.ts'

const team = { version: 1, definition: { kind: 'team' as const, description: 'demo',
  members: [{ role: 'reader', profile: { id: 'profile', version: 1 } }] } }
const profile = { version: 1, definition: { kind: 'profile' as const, description: 'reader',
  instructions: 'Read one file.', provider: 'fixture', model: 'fixture', enabled: true } }
const readTeam = (id: string): typeof team | typeof profile => (id === 'team' ? team : profile)
const noSaved = (): never => { throw new Error('no saved editions') }

/** One nested edition in the shape the store returns. */
const nestedEdition = (script: string, extra: Partial<WorkflowEdition> = {}): WorkflowEdition => ({
  version: 1, description: 'Nested', script, knowledge: [], knowledgeMode: 'managed',
  sha256: createHash('sha256').update(script).digest('hex'), ...extra,
})

/** A saved-edition reader over one fixed identity. */
const reads = (edition: WorkflowEdition) => (id: string): WorkflowEdition => {
  if (id !== 'inner') throw new Error('missing edition')
  return edition
}

/** Run one compiled script with a scripted agent implementation. */
const run = async (script: string, agent: (prompt: string) => Promise<unknown>): Promise<unknown> =>
  await runInNewContext(`(async () => { ${script} })()`, { agent, phase: () => {}, log: () => {} })

const roleNode = (extra: Record<string, unknown> = {}) => ({ id: 'draft', kind: 'role' as const,
  team: { id: 'team', version: 1 }, role: 'reader', prompt: 'Draft it', dependsOn: [], retry: 1, ...extra })

it('retries an ordinary failure up to the configured attempt count and then fails the node', async () => {
  let calls = 0
  const compiled = compilePlan({ id: 'retry-plain', expectedVersion: 0, description: 'Retry',
    nodes: [roleNode({ retry: 3 })] }, noSaved, readTeam, 2)
  await expect(run(compiled.script, async () => { calls += 1; throw new Error('provider hiccup') }))
    .rejects.toThrow('node draft failed after 3 attempt(s)')
  expect(calls).toBe(3)
})

it('stops after the first unknown result instead of retrying it', async () => {
  let calls = 0
  const compiled = compilePlan({ id: 'retry-null', expectedVersion: 0, description: 'Null result',
    nodes: [roleNode({ retry: 3 })] }, noSaved, readTeam, 2)
  await expect(run(compiled.script, async () => { calls += 1; return null }))
    .rejects.toThrow('returned no successful value')
  expect(calls).toBe(1)
})

it('stops on a cancellation instead of retrying it', async () => {
  let calls = 0
  const compiled = compilePlan({ id: 'retry-abort', expectedVersion: 0, description: 'Cancelled',
    nodes: [roleNode({ retry: 3 })] }, noSaved, readTeam, 2)
  await expect(run(compiled.script, async () => {
    calls += 1
    const error = new Error('the child run was aborted')
    error.name = 'AbortError'
    throw error
  })).rejects.toThrow('node draft failed after 1 attempt(s)')
  expect(calls).toBe(1)
})

it('does not re-run a failed assertion, because the same content yields the same verdict', async () => {
  let calls = 0
  const compiled = compilePlan({ id: 'retry-gate', expectedVersion: 0, description: 'Gate', nodes: [
    roleNode(),
    { id: 'gate', kind: 'check', dependsOn: ['draft'], retry: 3, expect: { mustNotContain: [], mustContain: ['SC-1007'], minLength: 0 } },
  ] }, noSaved, readTeam, 2)
  await expect(run(compiled.script, async () => { calls += 1; return 'no token' }))
    .rejects.toThrow('node gate failed after 1 attempt(s): missing required content')
  expect(calls).toBe(1)
})

it('rejects content that carries a known-wrong value, so a wrong total cannot pass by mentioning the right one', async () => {
  const compiled = compilePlan({ id: 'forbid-gate', expectedVersion: 0, description: 'Forbid', nodes: [
    roleNode(),
    { id: 'gate', kind: 'check', dependsOn: ['draft'], retry: 1, expect: { mustContain: ['合计', '494'], mustNotContain: ['594'], minLength: 0 } },
  ] }, noSaved, readTeam, 2)
  await expect(run(compiled.script, async () => '合计 594 元；参考 494 元'))
    .rejects.toThrow('contains rejected content: 594')
  await expect(run(compiled.script, async () => '合计 494 元，未超过上限')).resolves.toBeTruthy()
})

it('pins the assertion to the total row, so a wrong total fails even when the right number appears elsewhere', async () => {
  const compiled = compilePlan({ id: 'row-gate', expectedVersion: 0, description: 'Row gate', nodes: [
    roleNode(),
    { id: 'gate', kind: 'check', dependsOn: ['draft'], retry: 1, expect: { mustNotContain: [], mustContain: ['合计', '494'],
      mustMatch: ['合计.*494'], minLength: 0 } },
  ] }, noSaved, readTeam, 2)
  await expect(run(compiled.script, async () => '| 合计 | — | 694 元 |\n参考 494 元'))
    .rejects.toThrow('missing required pattern')
  await expect(run(compiled.script, async () => '| 合计 | — | 494 元 |\n（注：曾误计 594，已剔除押金）')).resolves.toBeTruthy()
})

it('bounds the rework loop to one generator call plus the declared attempts', async () => {
  let calls = 0
  const compiled = compilePlan({ id: 'rework-bound', expectedVersion: 0, description: 'Bound', nodes: [
    roleNode(),
    { id: 'gate', kind: 'check', dependsOn: ['draft'], retry: 1, rework: 'draft', attempts: 2,
      expect: { mustNotContain: [], mustContain: ['SC-1007'], minLength: 0 } },
  ] }, noSaved, readTeam, 2)
  await expect(run(compiled.script, async () => { calls += 1; return 'still wrong' }))
    .rejects.toThrow('missing required content')
  expect(calls).toBe(3)
})

it('refuses to publish a rework target that feeds another node, because that node would keep stale input', () => {
  const nodes = [
    roleNode(),
    { id: 'derived', kind: 'agent' as const, prompt: 'Derive from the draft', provider: 'fixture', model: 'fixture',
      dependsOn: ['draft'], retry: 1 },
    { id: 'gate', kind: 'check' as const, dependsOn: ['draft'], retry: 1, rework: 'draft', attempts: 1,
      expect: { mustNotContain: [], mustContain: ['SC-1007'], minLength: 0 } },
    { id: 'final', kind: 'agent' as const, prompt: 'Finish', provider: 'fixture', model: 'fixture',
      dependsOn: ['derived', 'gate'], retry: 1 },
  ]
  expect(() => compilePlan({ id: 'stale', expectedVersion: 0, description: 'Stale consumer', nodes },
    noSaved, readTeam, 2)).toThrow('A rework target must be consumed only by the check that reworks it')
})

it('refuses two checks reworking the same target, because their reruns would race', () => {
  const nodes = [
    roleNode(),
    { id: 'gate-a', kind: 'check' as const, dependsOn: ['draft'], retry: 1, rework: 'draft', attempts: 1,
      expect: { mustNotContain: [], mustContain: ['A'], minLength: 0 } },
    { id: 'gate-b', kind: 'check' as const, dependsOn: ['draft'], retry: 1, rework: 'draft', attempts: 1,
      expect: { mustNotContain: [], mustContain: ['B'], minLength: 0 } },
  ]
  expect(() => compilePlan({ id: 'double', expectedVersion: 0, description: 'Two checks', nodes },
    noSaved, readTeam, 2)).toThrow('Only one check may rework a given node')
})

it('refuses a rework target or check whose own retry would multiply the rerun count', () => {
  const targetRetry = [roleNode({ retry: 2 }),
    { id: 'gate', kind: 'check' as const, dependsOn: ['draft'], retry: 1, rework: 'draft', attempts: 1,
      expect: { mustNotContain: [], mustContain: [], minLength: 0 } }]
  expect(() => compilePlan({ id: 'target-retry', expectedVersion: 0, description: 'Target retry', nodes: targetRetry },
    noSaved, readTeam, 2)).toThrow('must keep retry 1 when it is a rework target')

  const checkRetry = [roleNode(),
    { id: 'gate', kind: 'check' as const, dependsOn: ['draft'], retry: 2, rework: 'draft', attempts: 1,
      expect: { mustNotContain: [], mustContain: [], minLength: 0 } }]
  expect(() => compilePlan({ id: 'check-retry', expectedVersion: 0, description: 'Check retry', nodes: checkRetry },
    noSaved, readTeam, 2)).toThrow('must keep retry 1 when it reworks a node')
})

it('refuses to embed an untracked nested edition instead of treating its dependencies as empty', () => {
  const legacy = nestedEdition('return 1', { knowledgeMode: undefined })
  const plan = { id: 'nested-legacy', expectedVersion: 0, description: 'Nested legacy', nodes: [
    { id: 'inner', kind: 'saved' as const, dependsOn: [], retry: 1, workflow: { id: 'inner', version: 1 } },
  ] }
  expect(() => compilePlan(plan, reads(legacy), readTeam, 2))
    .toThrow('cannot embed inner v1, which predates knowledge tracking')
})

it('refuses an untracked nested edition at every nesting kind', () => {
  const legacy = nestedEdition('return 1', { knowledgeMode: undefined })
  const base = { expectedVersion: 0, description: 'Nested kinds' }
  expect(() => compilePlan({ ...base, id: 'repeat-legacy', nodes: [
    { id: 'loop', kind: 'repeat' as const, dependsOn: [], retry: 1, count: 1, workflow: { id: 'inner', version: 1 } },
  ] }, reads(legacy), readTeam, 2)).toThrow('predates knowledge tracking')
  expect(() => compilePlan({ ...base, id: 'branch-legacy', nodes: [
    { id: 'source', kind: 'saved' as const, dependsOn: [], retry: 1, workflow: { id: 'inner', version: 1 } },
    { id: 'choose', kind: 'branch' as const, dependsOn: ['source'], retry: 1, source: 'source', path: ['ok'],
      equals: true, then: { id: 'inner', version: 1 }, otherwise: { id: 'inner', version: 1 } },
  ] }, reads(legacy), readTeam, 2)).toThrow('predates knowledge tracking')
})

it('merges the dependencies of a tracked nested edition and of a human script nesting', () => {
  const inner = nestedEdition('return 1', { knowledge: [{ collection: 'inner-rules', version: 2 }] })
  const human = nestedEdition('return 2', { knowledgeMode: 'human' })
  const compiled = compilePlan({ id: 'nested-tracked', expectedVersion: 0, description: 'Tracked', nodes: [
    { id: 'inner', kind: 'saved', dependsOn: [], retry: 1, workflow: { id: 'inner', version: 1 } },
  ] }, reads(inner), readTeam, 2)
  expect(compiled.knowledge).toEqual([{ collection: 'inner-rules', version: 2 }])
  const humanNested = compilePlan({ id: 'nested-human', expectedVersion: 0, description: 'Human', nodes: [
    { id: 'inner', kind: 'saved', dependsOn: [], retry: 1, workflow: { id: 'inner', version: 1 } },
  ] }, reads(human), readTeam, 2)
  expect(humanNested.knowledge).toEqual([])
})

/** Compile a nested edition from one agent node, so the outer plan embeds a real compiled script. */
const innerEdition = (nodes: unknown[]): WorkflowEdition => {
  const compiled = compilePlan({ id: 'inner', expectedVersion: 0, description: 'Inner', nodes: nodes as never }, noSaved, readTeam, 2)
  return nestedEdition(compiled.script, { knowledge: compiled.knowledge })
}

const outerPlan = (kind: 'saved' | 'repeat' | 'branch', retry = 3) => {
  const call = kind === 'saved'
    ? { id: 'call', kind: 'saved' as const, dependsOn: [], retry, workflow: { id: 'inner', version: 1 } }
    : kind === 'repeat'
      ? { id: 'call', kind: 'repeat' as const, dependsOn: [], retry: 1, count: 2, workflow: { id: 'inner', version: 1 } }
      : { id: 'source', kind: 'saved' as const, dependsOn: [], retry: 1, workflow: { id: 'inner', version: 1 } }
  const nodes = kind === 'branch'
    ? [call, { id: 'choose', kind: 'branch' as const, dependsOn: ['source'], retry, source: 'source', path: ['route'],
      equals: true, then: { id: 'inner', version: 1 }, otherwise: { id: 'inner', version: 1 } }]
    : [call]
  return compilePlan({ id: 'outer', expectedVersion: 0, description: 'Outer', nodes },
    reads(innerEdition([{ id: 'w', kind: 'agent', provider: 'fixture', model: 'fixture', prompt: 'work', dependsOn: [], retry: 1 }])),
    readTeam, 2)
}

it('stops the outer node when a nested edition ends on an unknown result', async () => {
  const compiled = outerPlan('saved')
  let calls = 0
  await expect(run(compiled.script, async () => { calls += 1; return calls === 1 ? null : 'GOOD' }))
    .rejects.toThrow('returned no successful value')
  expect(calls).toBe(1)
})

it('stops the outer node when a nested assertion fails, even with outer retry 3', async () => {
  const inner = innerEdition([
    { id: 'w', kind: 'agent', provider: 'fixture', model: 'fixture', prompt: 'work', dependsOn: [], retry: 1 },
    { id: 'gate', kind: 'check', dependsOn: ['w'], retry: 1, expect: { mustNotContain: [], mustContain: ['GOOD'], minLength: 0 } },
  ])
  const compiled = compilePlan({ id: 'outer', expectedVersion: 0, description: 'Outer', nodes: [
    { id: 'call', kind: 'saved', dependsOn: [], retry: 3, workflow: { id: 'inner', version: 1 } },
  ] }, reads(inner), readTeam, 2)
  let calls = 0
  await expect(run(compiled.script, async () => { calls += 1; return 'BAD' })).rejects.toThrow('missing required content')
  expect(calls).toBe(1)
})

it('does not replay a repeat that already completed an earlier iteration', async () => {
  const compiled = outerPlan('repeat')
  let calls = 0
  await expect(run(compiled.script, async () => { calls += 1; return calls === 1 ? 'GOOD' : null }))
    .rejects.toThrow('returned no successful value')
  expect(calls).toBe(2)
})

it('stops when the selected branch edition fails a verification gate', async () => {
  const inner = innerEdition([
    { id: 'w', kind: 'agent', provider: 'fixture', model: 'fixture', prompt: 'work', dependsOn: [], retry: 1 },
    { id: 'gate', kind: 'check', dependsOn: ['w'], retry: 1, expect: { mustNotContain: [], mustContain: ['GOOD'], minLength: 0 } },
  ])
  const compiled = compilePlan({ id: 'outer', expectedVersion: 0, description: 'Outer', nodes: [
    { id: 'source', kind: 'agent', provider: 'fixture', model: 'fixture', prompt: 'route', dependsOn: [], retry: 1 },
    { id: 'choose', kind: 'branch', dependsOn: ['source'], retry: 3, source: 'source', path: ['route'],
      equals: true, then: { id: 'inner', version: 1 }, otherwise: { id: 'inner', version: 1 } },
  ] }, reads(inner), readTeam, 2)
  let calls = 0
  await expect(run(compiled.script, async () => { calls += 1; return 'BAD' })).rejects.toThrow('missing required content')
  expect(calls).toBe(2)
})

it('still retries an ordinary nested failure, so retryable semantics survive the boundary', async () => {
  const compiled = outerPlan('saved')
  let calls = 0
  const result = await run(compiled.script, async () => {
    calls += 1
    if (calls < 2) throw new Error('provider hiccup')
    return 'GOOD'
  })
  expect(calls).toBe(2)
  expect(Object.hasOwn(result as object, 'call')).toBe(true)
})

it('refuses a repeat node with retry above one, because a retry would replay completed iterations', () => {
  expect(() => compilePlan({ id: 'repeat-retry', expectedVersion: 0, description: 'Repeat retry', nodes: [
    { id: 'call', kind: 'repeat', dependsOn: [], retry: 2, count: 2, workflow: { id: 'inner', version: 1 } },
  ] }, reads(innerEdition([{ id: 'w', kind: 'agent', provider: 'fixture', model: 'fixture', prompt: 'work', dependsOn: [], retry: 1 }])),
  readTeam, 2)).toThrow('A repeat node must keep retry 1 so completed iterations are not replayed')
})

it('replays a saved unit including its completed iterations after an ordinary error', async () => {
  const human = nestedEdition('return await agent("iteration")', { knowledgeMode: 'human' })
  const loop = compilePlan({ id: 'loop', expectedVersion: 0, description: 'Loop', nodes: [
    { id: 'repeat', kind: 'repeat', dependsOn: [], retry: 1, count: 2, workflow: { id: 'inner', version: 1 } },
  ] }, reads(human), readTeam, 2)
  const outer = compilePlan({ id: 'outer', expectedVersion: 0, description: 'Outer', nodes: [
    { id: 'unit', kind: 'saved', dependsOn: [], retry: 2, workflow: { id: 'inner', version: 1 } },
  ] }, reads(nestedEdition(loop.script)), readTeam, 2)
  let calls = 0
  await expect(run(outer.script, async () => {
    calls += 1
    if (calls === 2) throw Error('ordinary failure after the first iteration')
    return 'GOOD'
  })).resolves.toBeDefined()
  expect(calls).toBe(4)
})

it('refuses to replay a nested script that predates the failure-class marker', () => {
  // Legacy compiler output: a plain error, so an outer retry would replay unknown-result work.
  const legacy = nestedEdition('const value = 1\nif (value === null) throw new Error("returned no successful value")\nreturn value')
  const plan = { id: 'legacy-replay', expectedVersion: 0, description: 'Legacy replay', nodes: [
    { id: 'call', kind: 'saved' as const, dependsOn: [], retry: 3, workflow: { id: 'inner', version: 1 } },
  ] }
  expect(() => compilePlan(plan, reads(legacy), readTeam, 2))
    .toThrow('predates non-retryable failure classes')
})

it('allows the same legacy script when the consumer does not retry', async () => {
  const legacy = nestedEdition('return { legacy: true }')
  const compiled = compilePlan({ id: 'legacy-once', expectedVersion: 0, description: 'Legacy once', nodes: [
    { id: 'call', kind: 'saved', dependsOn: [], retry: 1, workflow: { id: 'inner', version: 1 } },
  ] }, reads(legacy), readTeam, 2)
  const result = await run(compiled.script, async () => 'unused')
  expect(result).toEqual({ call: { legacy: true } })
})

it('refuses a branch that can select a legacy script while it retries', () => {
  const legacy = nestedEdition('return { route: true }')
  const classified = nestedEdition(String(compilePlan({ id: 'inner', expectedVersion: 0, description: 'Inner', nodes: [
    { id: 'w', kind: 'agent', provider: 'fixture', model: 'fixture', prompt: 'work', dependsOn: [], retry: 1 },
  ] }, noSaved, readTeam, 2).script))
  const byId = new Map<string, WorkflowEdition>([['legacy', legacy], ['inner', classified]])
  const plan = { id: 'branch-legacy', expectedVersion: 0, description: 'Branch legacy', nodes: [
    { id: 'source', kind: 'agent' as const, provider: 'fixture', model: 'fixture', prompt: 'route', dependsOn: [], retry: 1 },
    { id: 'choose', kind: 'branch' as const, dependsOn: ['source'], retry: 2, source: 'source', path: ['route'],
      equals: true, then: { id: 'legacy', version: 1 }, otherwise: { id: 'inner', version: 1 } },
  ] }
  expect(() => compilePlan(plan, (id) => {
    const found = byId.get(id)
    if (found === undefined) throw new Error('missing edition')
    return found
  }, readTeam, 2)).toThrow('predates non-retryable failure classes')
})
