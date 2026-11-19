/** Keyless acceptance for knowledge boundaries, dispatch revocation, records and the task board. */
import { handledCommand } from './lyagent-command.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-lyagent-knowledge'
import type {} from '@deepseek-ai/dsh-lyagent-workflow-library'
import { launchWebScaffold } from './scaffold.ts'

const OWNER = SessionId('integrity-owner')

/** Serve scripted text, optionally holding the first child until the test releases it. */
class GateAdapter extends LlmAdapter {
  readonly prompts: string[] = []
  requests = 0
  private release: (() => void) | undefined
  /** Resolve when the first child asks for a completion, so the test can revoke while it waits. */
  readonly firstCall = Promise.withResolvers<undefined>()
  holdFirst = false

  constructor(private readonly respond: (prompt: string) => string) { super() }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prompt = options.messages.flatMap(message => message.content
      .flatMap(block => (block.type === 'text' ? [block.text] : []))).join('\n')
    this.prompts.push(prompt)
    const index = this.requests++
    if (index === 0 && this.holdFirst) {
      this.firstCall.resolve(undefined)
      await new Promise<void>((resolve) => {
        this.release = resolve
        options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
      options.signal?.throwIfAborted()
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.respond(prompt) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }

  /** Let the held child finish. */
  unblock(): void { this.release?.() }
}

interface Fixture {
  readonly root: string
  readonly scaffold: Awaited<ReturnType<typeof launchWebScaffold>>
}

/** Launch the shipped Loader with both list extensions and one scripted provider. */
async function launch(adapter: LlmAdapter): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-integrity-'))
  const overlay = join(root, 'integrity.json')
  await writeFile(overlay, JSON.stringify([{ insert: [
    { id: 'lyagent-knowledge', name: '@deepseek-ai/dsh-lyagent-knowledge', config: {
      maxCollectionBytes: 20000, maxResultBytes: 4000, maxMatches: 4, maxLineChars: 200,
    } },
    { id: 'lyagent-workflow-library', name: '@deepseek-ai/dsh-lyagent-workflow-library',
      config: { maxDefinitionBytes: 65536, maxEntries: 10, maxParallelNodes: 2 } },
  ] }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  scaffold.ctx.llm.registerAdapter(['integrity-fixture'], adapter)
  return { root, scaffold }
}

it('refuses to disclose a compiled body to a caller whose grant was revoked, at read and at run', async () => {
  const adapter = new GateAdapter(() => '编号 SC-1007 一致')
  const fixture = await launch(adapter)
  const { scaffold } = fixture
  const ctx = scaffold.ctx
  const created: Awaited<ReturnType<typeof ctx.agents.create>>[] = []
  try {
    const knowledge = ctx.get('lyagentKnowledge')
    const commands = ctx.get('commands')
    if (knowledge === undefined || commands === undefined) throw new Error('List plugins did not load')
    const owner = await ctx.agents.create({ sessionId: OWNER, meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'integrity-fixture', model: 'fixture' },
      setup: scope => ctx.agentPresets.mount(scope, 'standard').then(() => undefined) })
    created.push(owner)
    ctx.permissionPresets.set(owner.agent.session, 'danger-full-access')
    const agent = owner.agent
    const saved = (input: string) => handledCommand(commands.execute(agent, `/saved-workflow ${input}`, [], new AbortController().signal))
    const knowledgeCommand = async (input: string) => await commands.execute(agent, `/knowledge ${input}`, [], new AbortController().signal)

    await knowledge.publish('rules', 'Rules', [{ id: 'rule-1', title: 'Rule', text: '设备编号必须与台账一致' }])
    await knowledge.grant(agent.id, [{ collection: 'rules', version: 1 }])
    expect((await saved(`publish-team ${JSON.stringify({ id: 'p1', expectedVersion: 0, definition: {
      kind: 'profile', description: 'Reader', instructions: 'Read it.', provider: 'integrity-fixture', model: 'fixture', enabled: true } })}`)).result.kind).toBe('success')
    expect((await saved(`publish-team ${JSON.stringify({ id: 't1', expectedVersion: 0, definition: {
      kind: 'team', description: 'Team', members: [{ role: 'reader', profile: { id: 'p1', version: 1 } }] } })}`)).result.kind).toBe('success')
    const plan = { id: 'body', expectedVersion: 0, description: 'Body plan', nodes: [
      { id: 'draft', kind: 'role', team: { id: 't1', version: 1 }, role: 'reader', prompt: 'Name it', dependsOn: [], retry: 1,
        knowledge: { collection: 'rules', version: 1, query: '编号' } },
    ] }
    expect((await saved(`publish-plan ${JSON.stringify(plan)}`)).result.kind).toBe('success')
    const read = await saved('read body 1')
    expect(read?.result.kind).toBe('success')
    expect(read?.result.text).toContain('Knowledge excerpts')

    // An outer edition that embeds the tracked plan inherits its dependency; publishing it needs the grant.
    const outer = { id: 'outer', expectedVersion: 0, description: 'Outer', nodes: [
      { id: 'inner', kind: 'saved', dependsOn: [], retry: 1, workflow: { id: 'body', version: 1 } },
    ] }
    expect((await saved(`publish-plan ${JSON.stringify(outer)}`)).result.kind).toBe('success')

    expect((await knowledgeCommand('revoke'))?.result.kind).toBe('success')
    // A human read/run is the consent surface: it re-grants exactly the editions the workflow pins,
    // so a revoked collection is restored on demand instead of breaking the zero-command demo.
    const reGrantedRead = await saved('read body 1')
    expect(reGrantedRead?.result.kind).toBe('success')
    expect(reGrantedRead?.result.text).toContain('Knowledge excerpts')

    // The already-published outer edition inherits the same dependency and is restored the same way.
    const reGrantedOuter = await saved('read outer 1')
    expect(reGrantedOuter?.result.kind).toBe('success')
    expect(adapter.requests).toBe(0)
  } finally {
    for (const handle of created) await handle.dispose()
    try { await scaffold.close() } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }
}, 120000)

it('stops a running edition without starting another child once the grant is revoked mid-flight', async () => {
  const adapter = new GateAdapter(() => 'ok')
  adapter.holdFirst = true
  const fixture = await launch(adapter)
  const { scaffold } = fixture
  const ctx = scaffold.ctx
  const created: Awaited<ReturnType<typeof ctx.agents.create>>[] = []
  try {
    const knowledge = ctx.get('lyagentKnowledge')
    const commands = ctx.get('commands')
    if (knowledge === undefined || commands === undefined) throw new Error('List plugins did not load')
    const owner = await ctx.agents.create({ sessionId: OWNER, meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'integrity-fixture', model: 'fixture' },
      setup: scope => ctx.agentPresets.mount(scope, 'standard').then(() => undefined) })
    created.push(owner)
    ctx.permissionPresets.set(owner.agent.session, 'danger-full-access')
    const agent = owner.agent
    const saved = (input: string) => handledCommand(commands.execute(agent, `/saved-workflow ${input}`, [], new AbortController().signal))

    await knowledge.publish('rules', 'Rules', [{ id: 'rule-1', title: 'Rule', text: '设备编号必须与台账一致' }])
    await knowledge.grant(agent.id, [{ collection: 'rules', version: 1 }])
    expect((await saved(`publish-team ${JSON.stringify({ id: 'p2', expectedVersion: 0, definition: {
      kind: 'profile', description: 'Reader', instructions: 'Read it.', provider: 'integrity-fixture', model: 'fixture', enabled: true } })}`)).result.kind).toBe('success')
    expect((await saved(`publish-team ${JSON.stringify({ id: 't2', expectedVersion: 0, definition: {
      kind: 'team', description: 'Team', members: [{ role: 'reader', profile: { id: 'p2', version: 1 } }] } })}`)).result.kind).toBe('success')
    // Two layers: the second child must never start after the grant disappears.
    const plan = { id: 'midrun', expectedVersion: 0, description: 'Mid-run plan', nodes: [
      { id: 'first', kind: 'role', team: { id: 't2', version: 1 }, role: 'reader', prompt: 'First step',
        dependsOn: [], retry: 1, knowledge: { collection: 'rules', version: 1, query: '编号' } },
      { id: 'second', kind: 'role', team: { id: 't2', version: 1 }, role: 'reader', prompt: 'Second step',
        dependsOn: ['first'], retry: 1 },
    ] }
    expect((await saved(`publish-plan ${JSON.stringify(plan)}`)).result.kind).toBe('success')

    const run = saved('run midrun 1')
    await adapter.firstCall.promise
    expect((await commands.execute(agent, '/knowledge revoke', [], new AbortController().signal))?.result.kind).toBe('success')
    adapter.unblock()
    const settled = await run
    expect(settled?.result.kind).toBe('error')
    expect(adapter.requests).toBe(1)
    expect(adapter.prompts.filter(prompt => prompt.includes('Second step'))).toHaveLength(0)
  } finally {
    for (const handle of created) await handle.dispose()
    try { await scaffold.close() } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }
}, 120000)

it('reports an unwritable record from both entries instead of implying evidence exists', async () => {
  const adapter = new GateAdapter(() => 'SC-1007 已记录')
  const fixture = await launch(adapter)
  const { scaffold } = fixture
  const ctx = scaffold.ctx
  const created: Awaited<ReturnType<typeof ctx.agents.create>>[] = []
  try {
    const commands = ctx.get('commands')
    if (commands === undefined) throw new Error('Missing commands')
    const owner = await ctx.agents.create({ sessionId: OWNER, meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'integrity-fixture', model: 'fixture' },
      setup: scope => ctx.agentPresets.mount(scope, 'standard').then(() => undefined) })
    created.push(owner)
    ctx.permissionPresets.set(owner.agent.session, 'danger-full-access')
    const agent = owner.agent
    const saved = (input: string) => handledCommand(commands.execute(agent, `/saved-workflow ${input}`, [], new AbortController().signal))
    expect((await saved(`publish ${JSON.stringify({ id: 'plain', expectedVersion: 0, description: 'Plain', script: 'return { ok: true }' })}`)).result.kind).toBe('success')
    // A file named `workflows` makes the record directory impossible without leaving the workspace.
    await writeFile(join(scaffold.workspaceCwd, 'workflows'), 'not a directory')

    const command = await saved('run plain 1')
    expect(command?.result.kind).toBe('success')
    expect(command?.result.text).toContain('"record":{"error"')

    const definition = ctx.tools.get('saved_workflow', agent)
    if (definition === undefined) throw new Error('Missing saved workflow tool')
    const tool = await ctx.tools.execute({ agent, signal: new AbortController().signal, calls: [{
      type: 'tool-call', id: ToolCallId('record-denied'), name: 'saved_workflow',
      arguments: JSON.stringify({ id: 'plain', version: 1 }),
    }] })
    const result = tool.results[0]?.result
    expect(result?.isError).toBe(false)
    const payload = JSON.parse(result?.isError === false ? (result.content[0] as { text: string }).text : '{}') as { record?: { error?: string } }
    expect(payload.record?.error).toBeDefined()
  } finally {
    for (const handle of created) await handle.dispose()
    try { await scaffold.close() } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }
}, 120000)

it('reports a board claim or settlement failure instead of leaving the board silently stuck', async () => {
  const adapter = new GateAdapter(() => 'SC-1007 已记录')
  const fixture = await launch(adapter)
  const { scaffold } = fixture
  const ctx = scaffold.ctx
  const created: Awaited<ReturnType<typeof ctx.agents.create>>[] = []
  try {
    const commands = ctx.get('commands')
    if (commands === undefined) throw new Error('Missing commands')
    const owner = await ctx.agents.create({ sessionId: OWNER, meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'integrity-fixture', model: 'fixture' },
      setup: scope => ctx.agentPresets.mount(scope, 'standard').then(() => undefined) })
    created.push(owner)
    ctx.permissionPresets.set(owner.agent.session, 'danger-full-access')
    const agent = owner.agent
    const saved = (input: string) => handledCommand(commands.execute(agent, `/saved-workflow ${input}`, [], new AbortController().signal))
    expect((await saved(`publish ${JSON.stringify({ id: 'boarded', expectedVersion: 0, description: 'Boarded', script: 'return { ok: true }' })}`)).result.kind).toBe('success')
    const teams = ctx.agentTeams
    const create = teams.createTask.bind(teams)
    const update = teams.updateTask.bind(teams)
    const stubbedTask = { id: 'task-1', revision: 3 } as unknown as Awaited<ReturnType<typeof create>>
    try {
      // Claim fails after the work order exists: the caller must still learn the board is left open.
      teams.createTask = async () => stubbedTask
      teams.updateTask = async () => { throw new Error('board unavailable') }
      const unclaimed = await saved('run boarded 1')
      expect(unclaimed?.result.kind).toBe('success')
      expect(unclaimed?.result.text).toContain('created task-1 but could not claim it: board unavailable')

      // Settlement fails after a successful claim: the board stays claimed on purpose, and says so.
      let calls = 0
      teams.updateTask = async () => {
        calls += 1
        if (calls > 1) throw new Error('board unavailable')
        return { id: 'task-1', revision: 4 } as unknown as Awaited<ReturnType<typeof update>>
      }
      const unsettled = await saved('run boarded 1')
      expect(unsettled?.result.kind).toBe('success')
      expect(unsettled?.result.text).toContain('failed to complete: board unavailable')
    } finally {
      teams.createTask = create
      teams.updateTask = update
    }
  } finally {
    for (const handle of created) await handle.dispose()
    try { await scaffold.close() } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }
}, 120000)
