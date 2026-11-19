/** Scheduling, retry feedback, verification gates and knowledge inlining are behaviour, not text. */
import { runInNewContext } from 'node:vm'
import { expect, it } from 'vitest'
import { compilePlan } from '../src/plan.ts'

const team = { version: 1, definition: { kind: 'team' as const, description: 'demo',
  members: [{ role: 'reader', profile: { id: 'profile', version: 1 } }] } }
const profile = { version: 1, definition: { kind: 'profile' as const, description: 'reader',
  instructions: 'Read one file.', provider: 'deepseek-official', model: 'deepseek-flash', enabled: true } }
const readTeam = (id: string): typeof team | typeof profile => (id === 'team' ? team : profile)
const read = (): never => { throw new Error('No saved editions in these fixtures') }

/** Run one compiled script with a scripted agent implementation. */
const run = async (script: string, agent: (prompt: string, options: { label: string }) => Promise<string>,
  extra: Record<string, unknown> = {}): Promise<unknown> => await runInNewContext(
  `(async () => { ${script} })()`,
  { agent, phase: () => {}, log: () => {}, ...extra },
)

it('runs a layer wider than the capacity by queueing, never exceeding the limit', async () => {
  let active = 0
  let peak = 0
  const compiled = compilePlan({ id: 'wide', expectedVersion: 0, description: 'Three at once', nodes: [
    { id: 'a', kind: 'role', team: { id: 'team', version: 1 }, role: 'reader', prompt: 'A', dependsOn: [], retry: 1 },
    { id: 'b', kind: 'role', team: { id: 'team', version: 1 }, role: 'reader', prompt: 'B', dependsOn: [], retry: 1 },
    { id: 'c', kind: 'role', team: { id: 'team', version: 1 }, role: 'reader', prompt: 'C', dependsOn: [], retry: 1 },
  ] }, read, readTeam, 2)
  const result = await run(compiled.script, async () => {
    active += 1
    peak = Math.max(peak, active)
    await new Promise(resolve => setTimeout(resolve, 5))
    active -= 1
    return 'ok'
  })
  expect(peak).toBe(2)
  expect(result).toEqual({ a: 'ok', b: 'ok', c: 'ok' })
})

it('feeds the previous failure into the next attempt', async () => {
  const prompts: string[] = []
  const compiled = compilePlan({ id: 'retry', expectedVersion: 0, description: 'Retry once', nodes: [
    { id: 'a', kind: 'role', team: { id: 'team', version: 1 }, role: 'reader', prompt: 'A', dependsOn: [], retry: 2 },
  ] }, read, readTeam, 2)
  const result = await run(compiled.script, async (prompt) => {
    prompts.push(prompt)
    if (prompts.length === 1) throw new Error('first attempt broke')
    return 'ok'
  })
  expect(result).toEqual({ a: 'ok' })
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('Previous attempt failed')
  expect(prompts[1]).toContain('first attempt broke')
})

it('fails the gate with the missing token and passes when the content satisfies it', async () => {
  const nodes = [
    { id: 'src', kind: 'role' as const, team: { id: 'team', version: 1 }, role: 'reader', prompt: 'A', dependsOn: [], retry: 1 },
    { id: 'gate', kind: 'check' as const, dependsOn: ['src'], retry: 1, expect: { mustNotContain: [], mustContain: ['SC-1007'], minLength: 3 } },
  ]
  const failing = compilePlan({ id: 'gate-no', expectedVersion: 0, description: 'Gate', nodes }, read, readTeam, 2)
  await expect(run(failing.script, async () => 'no token here')).rejects.toThrow('missing required content')
  const passing = compilePlan({ id: 'gate-yes', expectedVersion: 0, description: 'Gate', nodes }, read, readTeam, 2)
  const result = await run(passing.script, async () => 'asset SC-1007 borrowed')
  expect(result).toMatchObject({ gate: { passed: true } })
})

const roleSrc = { id: 'src', kind: 'role' as const, team: { id: 'team', version: 1 }, role: 'reader', prompt: 'Write one line', dependsOn: [], retry: 1 }
const gateOn = (rework: string, attempts?: number, extra: Record<string, unknown> = {}) => ({
  id: 'gate', kind: 'check' as const, dependsOn: ['src'], retry: 1, rework, ...(attempts === undefined ? {} : { attempts }),
  expect: { mustNotContain: [], mustContain: ['SC-1007'], minLength: 3 }, ...extra,
})

it('re-runs the rejected generator once and hands it the concrete gate reason', async () => {
  const prompts: string[] = []
  const compiled = compilePlan({ id: 'rework-once', expectedVersion: 0, description: 'Rework once',
    nodes: [roleSrc, gateOn('src')] }, read, readTeam, 2)
  const result = await run(compiled.script, async (prompt) => {
    prompts.push(prompt)
    return prompts.length === 1 ? 'the asset was borrowed' : 'asset SC-1007 borrowed'
  })
  expect(result).toMatchObject({ gate: { passed: true } })
  expect(prompts).toHaveLength(2)
  expect(prompts[1]).toContain('missing required content')
  expect(prompts[1]).toContain('SC-1007')
})

it('re-runs only the rework target, never an unrelated node in the same layer', async () => {
  const prompts: string[] = []
  const sibling = { id: 'other', kind: 'role' as const, team: { id: 'team', version: 1 }, role: 'reader',
    prompt: 'Unrelated branch', dependsOn: [], retry: 1 }
  const compiled = compilePlan({ id: 'rework-scope', expectedVersion: 0, description: 'Rework scope',
    nodes: [roleSrc, sibling, gateOn('src')] }, read, readTeam, 2)
  await run(compiled.script, async (prompt) => {
    prompts.push(prompt)
    if (prompt.includes('Unrelated branch')) return 'unrelated output'
    return prompts.length <= 2 ? 'the asset was borrowed' : 'asset SC-1007 borrowed'
  })
  expect(prompts.filter(prompt => prompt.includes('Task: Unrelated branch'))).toHaveLength(1)
  expect(prompts.filter(prompt => prompt.includes('Task: Write one line'))).toHaveLength(2)
})

it('stops at the rework limit and never starts downstream work', async () => {
  const prompts: string[] = []
  const downstream = { id: 'after', kind: 'role' as const, team: { id: 'team', version: 1 }, role: 'reader',
    prompt: 'Downstream work', dependsOn: ['gate'], retry: 1 }
  const compiled = compilePlan({ id: 'rework-limit', expectedVersion: 0, description: 'Rework limit',
    nodes: [roleSrc, gateOn('src', 2), downstream] }, read, readTeam, 2)
  await expect(run(compiled.script, async (prompt) => { prompts.push(prompt); return 'still no token' }))
    .rejects.toThrow('missing required content')
  expect(prompts).toHaveLength(3)
  expect(prompts.some(prompt => prompt.includes('Task: Downstream work'))).toBe(false)
})

it('does not rework when the generation itself throws or returns an unknown result', async () => {
  const throwing = compilePlan({ id: 'rework-throw', expectedVersion: 0, description: 'Throwing generator',
    nodes: [roleSrc, gateOn('src', 2)] }, read, readTeam, 2)
  let calls = 0
  await expect(run(throwing.script, async () => {
    calls += 1
    if (calls === 1) return 'the asset was borrowed'
    throw new Error('provider cancelled the request')
  })).rejects.toThrow('provider cancelled the request')
  expect(calls).toBe(2)

  const unknown = compilePlan({ id: 'rework-null', expectedVersion: 0, description: 'Unknown generator result',
    nodes: [roleSrc, gateOn('src', 2)] }, read, readTeam, 2)
  let nullCalls = 0
  await expect(run(unknown.script, async () => {
    nullCalls += 1
    return nullCalls === 1 ? 'the asset was borrowed' : (null as unknown as string)
  })).rejects.toThrow('no successful value')
  expect(nullCalls).toBe(2)
})

it('rejects rework targets that are not a direct role or agent dependency', async () => {
  const missing = { id: 'gate', kind: 'check' as const, dependsOn: [], retry: 1, rework: 'ghost',
    expect: { mustNotContain: [], mustContain: [], minLength: 0 } }
  expect(() => compilePlan({ id: 'bad-missing', expectedVersion: 0, description: 'Bad rework',
    nodes: [roleSrc, missing] }, read, readTeam, 2)).toThrow()

  const indirect = { id: 'gate', kind: 'check' as const, dependsOn: ['src'], retry: 1, rework: 'far',
    expect: { mustNotContain: [], mustContain: [], minLength: 0 } }
  const far = { id: 'far', kind: 'role' as const, team: { id: 'team', version: 1 }, role: 'reader',
    prompt: 'Far', dependsOn: ['src'], retry: 1 }
  expect(() => compilePlan({ id: 'bad-indirect', expectedVersion: 0, description: 'Bad rework',
    nodes: [roleSrc, far, indirect] }, read, readTeam, 2)).toThrow()

  const chained = { id: 'gate2', kind: 'check' as const, dependsOn: ['gate'], retry: 1, rework: 'gate',
    expect: { mustNotContain: [], mustContain: [], minLength: 0 } }
  expect(() => compilePlan({ id: 'bad-check-target', expectedVersion: 0, description: 'Bad rework',
    nodes: [roleSrc, { ...gateOn('src') }, chained] }, read, readTeam, 2)).toThrow()

  const attemptsWithoutRework = { id: 'gate3', kind: 'check' as const, dependsOn: ['src'], retry: 1, attempts: 2,
    expect: { mustNotContain: [], mustContain: [], minLength: 0 } }
  expect(() => compilePlan({ id: 'bad-attempts', expectedVersion: 0, description: 'Bad attempts',
    nodes: [roleSrc, attemptsWithoutRework] }, read, readTeam, 2)).toThrow()
})

it('inlines retrieved knowledge into the node prompt', async () => {
  const prompts: string[] = []
  const compiled = compilePlan({ id: 'knowledge', expectedVersion: 0, description: 'Knowledge', nodes: [
    { id: 'a', kind: 'role', team: { id: 'team', version: 1 }, role: 'reader', prompt: 'A', dependsOn: [], retry: 1,
      knowledge: { collection: 'rules', version: 1, query: '编号' } },
  ] }, read, readTeam, 2, () => [{ title: 'Rule two', text: '设备编号必须与台账一致' }])
  await run(compiled.script, async (prompt) => { prompts.push(prompt); return 'ok' })
  expect(compiled.script).toContain('Knowledge excerpts')
  expect(prompts[0]).toContain('设备编号必须与台账一致')
})

it('inlines knowledge for plain agent nodes too and rejects the field where nothing runs a model', async () => {
  const prompts: string[] = []
  const withAgentKnowledge = compilePlan({ id: 'agent-knowledge', expectedVersion: 0, description: 'Agent knowledge', nodes: [
    { id: 'a', kind: 'agent', provider: 'deepseek-official', model: 'deepseek-flash', prompt: 'Summarize',
      dependsOn: [], retry: 1, knowledge: { collection: 'rules', version: 1, query: '编号' } },
  ] }, read, readTeam, 2, () => [{ title: 'Rule two', text: '设备编号必须与台账一致' }])
  await run(withAgentKnowledge.script, async (prompt) => { prompts.push(prompt); return 'ok' })
  expect(prompts[0]).toContain('Knowledge excerpts')
  expect(prompts[0]).toContain('设备编号必须与台账一致')

  const rejected = { id: 'bad', expectedVersion: 0, description: 'Unsupported knowledge',
    nodes: [{ id: 'c', kind: 'check' as const, dependsOn: [], retry: 1, expect: { mustNotContain: [], mustContain: [], minLength: 0 },
      knowledge: { collection: 'rules', version: 1, query: 'x' } }] }
  expect(() => compilePlan(rejected, read, readTeam, 2)).toThrow()
})

it('adds no excerpt when the search returns nothing', async () => {
  const prompts: string[] = []
  const compiled = compilePlan({ id: 'no-match', expectedVersion: 0, description: 'No match', nodes: [
    { id: 'a', kind: 'role', team: { id: 'team', version: 1 }, role: 'reader', prompt: 'A', dependsOn: [], retry: 1,
      knowledge: { collection: 'rules', version: 1, query: 'absent' } },
  ] }, read, readTeam, 2, () => [])
  await run(compiled.script, async (prompt) => { prompts.push(prompt); return 'ok' })
  expect(prompts[0]).not.toContain('Knowledge excerpts')
})

it('records the knowledge dependencies a published script depends on, including nested editions', async () => {
  const nestedScript = 'return { ok: true }'
  const nested = { version: 1, description: 'Nested', script: nestedScript, knowledgeMode: 'managed' as const,
    sha256: (await import('node:crypto')).createHash('sha256').update(nestedScript).digest('hex'),
    knowledge: [{ collection: 'nested-rules', version: 2 }] }
  const readNested = (id: string) => (id === 'inner' ? nested : (() => { throw new Error('missing') })())
  const compiled = compilePlan({ id: 'with-deps', expectedVersion: 0, description: 'Deps', nodes: [
    { id: 'a', kind: 'role', team: { id: 'team', version: 1 }, role: 'reader', prompt: 'A', dependsOn: [], retry: 1,
      knowledge: { collection: 'rules', version: 1, query: '编号' } },
    { id: 'n', kind: 'saved', dependsOn: [], retry: 1, workflow: { id: 'inner', version: 1 } },
  ] }, readNested, readTeam, 2)
  expect(compiled.knowledge).toEqual([
    { collection: 'rules', version: 1 },
    { collection: 'nested-rules', version: 2 },
  ])
})
