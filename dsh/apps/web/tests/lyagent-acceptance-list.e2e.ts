/** Keyless acceptance: revoked knowledge grants, check-driven rework, and child failure reasons. */
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

const OWNER = SessionId('acceptance-owner')

/** Serve scripted text to every child; the owner session makes no direct request. */
class ChildTextAdapter extends LlmAdapter {
  /** Child prompts in request order, so a rework rerun is observable. */
  readonly prompts: string[] = []
  /** Total model requests served, so a refused run can prove it dispatched nothing. */
  requests = 0
  constructor(private readonly respond: (prompt: string, index: number) => string) { super() }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const prompt = options.messages.flatMap(message => message.content
      .flatMap(block => (block.type === 'text' ? [block.text] : []))).join('\n')
    this.prompts.push(prompt)
    const index = this.requests++
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: this.respond(prompt, index) } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** End one child's run without a completed stop reason, so the parent sees `null`. */
class TokenCeilingAdapter extends ChildTextAdapter {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    this.prompts.push(options.messages.length === 0 ? '' : 'prompt')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'partial answer' } }
    yield { type: 'finish', reason: { kind: 'max-tokens' } }
  }
}

interface Fixture {
  readonly root: string
  readonly scaffold: Awaited<ReturnType<typeof launchWebScaffold>>
}

/** Launch the shipped Loader with both list extensions and one scripted provider. */
async function launch(adapter: LlmAdapter): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-acceptance-'))
  const overlay = join(root, 'acceptance.json')
  await writeFile(overlay, JSON.stringify([{ insert: [
    { id: 'lyagent-knowledge', name: '@deepseek-ai/dsh-lyagent-knowledge', config: {
      maxCollectionBytes: 20000, maxResultBytes: 4000, maxMatches: 4, maxLineChars: 200,
    } },
    { id: 'lyagent-workflow-library', name: '@deepseek-ai/dsh-lyagent-workflow-library',
      config: { maxDefinitionBytes: 65536, maxEntries: 10, maxParallelNodes: 2 } },
  ] }]))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  scaffold.ctx.llm.registerAdapter(['acceptance-fixture'], adapter)
  return { root, scaffold }
}

it('refuses a revoked, ungranted or nested knowledge path before any dispatch', async () => {
  const adapter = new ChildTextAdapter(() => '设备编号 SC-1007 已与台账一致')
  const fixture = await launch(adapter)
  const { scaffold } = fixture
  const ctx = scaffold.ctx
  const created: Awaited<ReturnType<typeof ctx.agents.create>>[] = []
  try {
    const knowledge = ctx.get('lyagentKnowledge')
    const commands = ctx.get('commands')
    if (knowledge === undefined || commands === undefined) throw new Error('List plugins did not load')
    const owner = await ctx.agents.create({ sessionId: OWNER, meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'acceptance-fixture', model: 'fixture' },
      setup: scope => ctx.agentPresets.mount(scope, 'standard').then(() => undefined) })
    created.push(owner)
    ctx.permissionPresets.set(owner.agent.session, 'danger-full-access')
    const agent = owner.agent
    const saved = (input: string) => handledCommand(commands.execute(agent, `/saved-workflow ${input}`, [], new AbortController().signal))
    const knowledgeCommand = async (input: string) => await commands.execute(agent, `/knowledge ${input}`, [], new AbortController().signal)
    const runStarts = (): number => agent.session.snapshotEvents().filter(event => event.type === 'tool-workflow/run-start').length
    const library = ctx.get('lyagentWorkflowLibrary')
    if (library === undefined) throw new Error('Workflow library did not load')

    await knowledge.publish('rules', 'Rules', [{ id: 'rule-1', title: 'Rule', text: '设备编号必须与台账一致' }])
    await knowledge.grant(agent.id, [{ collection: 'rules', version: 1 }])
    const profile = { kind: 'profile', description: 'Reader', instructions: 'Read the source and answer.',
      provider: 'acceptance-fixture', model: 'fixture', enabled: true }
    expect((await saved(`publish-team ${JSON.stringify({ id: 'reader-profile', expectedVersion: 0, definition: profile })}`)).result.kind).toBe('success')
    const team = { kind: 'team', description: 'Readers', members: [{ role: 'reader', profile: { id: 'reader-profile', version: 1 } }] }
    expect((await saved(`publish-team ${JSON.stringify({ id: 'team-a', expectedVersion: 0, definition: team })}`)).result.kind).toBe('success')
    const plan = { id: 'know-plan', expectedVersion: 0, description: 'Knowledge plan', nodes: [
      { id: 'draft', kind: 'role', team: { id: 'team-a', version: 1 }, role: 'reader', prompt: 'Name the asset',
        dependsOn: [], retry: 1, knowledge: { collection: 'rules', version: 1, query: '编号' } },
      { id: 'gate', kind: 'check', dependsOn: ['draft'], retry: 1, expect: { mustContain: ['SC-1007'], minLength: 4 } },
    ] }
    expect((await saved(`publish-plan ${JSON.stringify(plan)}`)).result.kind).toBe('success')
    expect(library.read('know-plan', 1).script).toContain('Knowledge excerpts')
    expect(library.read('know-plan', 1).knowledge).toEqual([{ collection: 'rules', version: 1 }])

    // 1. A granted plan dispatches and inlines the excerpt.
    const granted = await saved('run know-plan 1')
    expect(granted?.result.kind).toBe('success')
    expect(adapter.prompts[0]).toContain('设备编号必须与台账一致')
    const runsAfterGrant = runStarts()
    const requestsAfterGrant = adapter.requests
    expect(runsAfterGrant).toBe(1)

    // 2. Publishing a nested edition is itself authorized, so it happens while the grant is held.
    const outer = { id: 'know-outer', expectedVersion: 0, description: 'Outer plan', nodes: [
      { id: 'inner', kind: 'saved', dependsOn: [], retry: 1, workflow: { id: 'know-plan', version: 1 } },
    ] }
    expect((await saved(`publish-plan ${JSON.stringify(outer)}`)).result.kind).toBe('success')
    expect(library.read('know-outer', 1).knowledge).toEqual([{ collection: 'rules', version: 1 }])

    // 3. Revoking the grant refuses the command entry with zero further dispatch.
    expect((await knowledgeCommand('revoke'))?.result.kind).toBe('success')
    const revoked = await saved('run know-plan 1')
    expect(revoked?.result.kind).toBe('error')
    expect(revoked?.result.text).toContain('Knowledge access was revoked for rules:1')
    expect(runStarts()).toBe(runsAfterGrant)
    expect(adapter.requests).toBe(requestsAfterGrant)

    // 3. The model-facing tool entry refuses the same way, before any child starts.
    const definition = ctx.tools.get('saved_workflow', agent)
    if (definition === undefined) throw new Error('Missing saved workflow tool')
    const denied = await ctx.tools.execute({ agent, signal: new AbortController().signal, calls: [{
      type: 'tool-call', id: ToolCallId('acceptance-revoked'), name: 'saved_workflow',
      arguments: JSON.stringify({ id: 'know-plan', version: 1 }),
    }] })
    const deniedResult = denied.results[0]?.result
    expect(deniedResult?.isError).toBe(true)
    expect(deniedResult?.isError === true && deniedResult.error.message).toContain('Knowledge access was revoked for rules:1')
    expect(runStarts()).toBe(runsAfterGrant)
    expect(adapter.requests).toBe(requestsAfterGrant)

    // 4. Another conversation cannot read what it was never granted.
    const stranger = await ctx.agents.create({ sessionId: SessionId('acceptance-stranger'), meta: { cwd: scaffold.workspaceCwd } })
    created.push(stranger)
    expect(knowledge.snapshot(stranger.agent.id)).toEqual([])
    expect(() => knowledge.search(stranger.agent.id, 'rules', 1, '编号')).toThrow()

    // 5. The already-published nested edition inherits the dependency and is refused after the revoke.
    const nested = await saved('run know-outer 1')
    expect(nested?.result.kind).toBe('error')
    expect(nested?.result.text).toContain('Knowledge access was revoked for rules:1')
    expect(runStarts()).toBe(runsAfterGrant)
  } finally {
    for (const handle of created) await handle.dispose()
    try { await scaffold.close() } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }
}, 120000)

it('re-runs only the rejected generator and hands it the gate reason', async () => {
  const adapter = new ChildTextAdapter(prompt => (prompt.includes('Previous result was rejected')
    ? 'asset SC-1007 recorded'
    : 'no asset identifier here'))
  const fixture = await launch(adapter)
  const { scaffold } = fixture
  const ctx = scaffold.ctx
  const created: Awaited<ReturnType<typeof ctx.agents.create>>[] = []
  try {
    const commands = ctx.get('commands')
    if (commands === undefined) throw new Error('Missing commands')
    const owner = await ctx.agents.create({ sessionId: OWNER, meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'acceptance-fixture', model: 'fixture' },
      setup: scope => ctx.agentPresets.mount(scope, 'standard').then(() => undefined) })
    created.push(owner)
    ctx.permissionPresets.set(owner.agent.session, 'danger-full-access')
    const agent = owner.agent
    const saved = (input: string) => handledCommand(commands.execute(agent, `/saved-workflow ${input}`, [], new AbortController().signal))
    const profile = { kind: 'profile', description: 'Reader', instructions: 'Write the line.',
      provider: 'acceptance-fixture', model: 'fixture', enabled: true }
    expect((await saved(`publish-team ${JSON.stringify({ id: 'writer-profile', expectedVersion: 0, definition: profile })}`)).result.kind).toBe('success')
    const team = { kind: 'team', description: 'Writers', members: [{ role: 'writer', profile: { id: 'writer-profile', version: 1 } }] }
    expect((await saved(`publish-team ${JSON.stringify({ id: 'team-w', expectedVersion: 0, definition: team })}`)).result.kind).toBe('success')
    const plan = { id: 'rework-plan', expectedVersion: 0, description: 'Rework plan', nodes: [
      { id: 'draft', kind: 'role', team: { id: 'team-w', version: 1 }, role: 'writer', prompt: 'Report the asset',
        dependsOn: [], retry: 1 },
      { id: 'anchor', kind: 'agent', prompt: 'Unrelated analysis', provider: 'acceptance-fixture', model: 'fixture',
        dependsOn: [], retry: 1 },
      { id: 'gate', kind: 'check', dependsOn: ['draft'], retry: 1, rework: 'draft', attempts: 2,
        expect: { mustContain: ['SC-1007'], minLength: 4 } },
    ] }
    expect((await saved(`publish-plan ${JSON.stringify(plan)}`)).result.kind).toBe('success')
    const run = await saved('run rework-plan 1')
    expect(run?.result.kind).toBe('success')
    expect(run?.result.text).toContain('SC-1007')
    // The unrelated sibling ran once; only the rejected generator ran again, with the gate reason.
    expect(adapter.prompts.filter(prompt => prompt.includes('Unrelated analysis'))).toHaveLength(1)
    const draftPrompts = adapter.prompts.filter(prompt => prompt.includes('Report the asset'))
    expect(draftPrompts).toHaveLength(2)
    expect(draftPrompts[1]).toContain('Previous result was rejected: gate rejected the previous result: missing required content: SC-1007')
    // The gate never calls a model: only the two drafts and the sibling settle, all as completed runs.
    const settlements = agent.session.snapshotEvents().filter(event => event.type === 'tool-workflow/agent-end')
      .map(event => (event.data as { outcome: string }).outcome)
    expect(settlements).toEqual(['completed', 'completed', 'completed'])
  } finally {
    for (const handle of created) await handle.dispose()
    try { await scaffold.close() } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }
}, 120000)

it('reports a child that stopped without completing through the durable settlement', async () => {
  const adapter = new TokenCeilingAdapter(() => '')
  const fixture = await launch(adapter)
  const { scaffold } = fixture
  const ctx = scaffold.ctx
  const created: Awaited<ReturnType<typeof ctx.agents.create>>[] = []
  try {
    const commands = ctx.get('commands')
    if (commands === undefined) throw new Error('Missing commands')
    const owner = await ctx.agents.create({ sessionId: OWNER, meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'acceptance-fixture', model: 'fixture' },
      setup: scope => ctx.agentPresets.mount(scope, 'standard').then(() => undefined) })
    created.push(owner)
    ctx.permissionPresets.set(owner.agent.session, 'danger-full-access')
    const agent = owner.agent
    const saved = (input: string) => handledCommand(commands.execute(agent, `/saved-workflow ${input}`, [], new AbortController().signal))
    const profile = { kind: 'profile', description: 'Leaky', instructions: 'Answer briefly.',
      provider: 'acceptance-fixture', model: 'fixture', enabled: true }
    expect((await saved(`publish-team ${JSON.stringify({ id: 'leaky-profile', expectedVersion: 0, definition: profile })}`)).result.kind).toBe('success')
    const team = { kind: 'team', description: 'Leaky', members: [{ role: 'leaky', profile: { id: 'leaky-profile', version: 1 } }] }
    expect((await saved(`publish-team ${JSON.stringify({ id: 'team-l', expectedVersion: 0, definition: team })}`)).result.kind).toBe('success')
    const plan = { id: 'ceiling-plan', expectedVersion: 0, description: 'Ceiling plan', nodes: [
      { id: 'leaky', kind: 'role', team: { id: 'team-l', version: 1 }, role: 'leaky', prompt: 'Write the long answer',
        dependsOn: [], retry: 1 },
    ] }
    expect((await saved(`publish-plan ${JSON.stringify(plan)}`)).result.kind).toBe('success')
    const run = await saved('run ceiling-plan 1')
    // A child without a successful value fails its layer; that error text cannot name the reason.
    expect(run?.result.kind).toBe('error')
    expect(run?.result.text).toContain('returned no successful value')
    const settlements = agent.session.snapshotEvents()
      .filter(event => event.type === 'tool-workflow/agent-end')
      .map(event => event.data as { outcome: string; stopReason?: string; error?: string })
    expect(settlements).toHaveLength(1)
    expect(settlements[0]).toMatchObject({ outcome: 'failed', stopReason: 'max-tokens' })
  } finally {
    for (const handle of created) await handle.dispose()
    try { await scaffold.close() } finally { await rm(fixture.root, { recursive: true, force: true }) }
  }
}, 120000)
