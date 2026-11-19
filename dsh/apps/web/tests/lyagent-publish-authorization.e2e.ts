/** Keyless acceptance: publishing a plan never discloses a nested edition the caller may not read. */
import { handledCommand } from './lyagent-command.ts'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-lyagent-knowledge'
import type {} from '@deepseek-ai/dsh-lyagent-workflow-library'
import { launchWebScaffold } from './scaffold.ts'

const OWNER = SessionId('publish-owner')
const STRANGER = SessionId('publish-stranger')
const SECRET = '设备编号必须与台账一致'

/** Every child is scripted; a publish must never reach this adapter. */
class SilentAdapter extends LlmAdapter {
  requests = 0
  override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'SC-1007 一致' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('refuses to publish a plan that embeds a protected edition the caller cannot read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-publish-auth-'))
  const overlay = join(root, 'auth.json')
  await writeFile(overlay, JSON.stringify([{ insert: [
    { id: 'lyagent-knowledge', name: '@deepseek-ai/dsh-lyagent-knowledge', config: {
      maxCollectionBytes: 20000, maxResultBytes: 4000, maxMatches: 4, maxLineChars: 200 } },
    { id: 'lyagent-workflow-library', name: '@deepseek-ai/dsh-lyagent-workflow-library',
      config: { maxDefinitionBytes: 65536, maxEntries: 20, maxParallelNodes: 2 } },
  ] }]))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  const created: Awaited<ReturnType<NonNullable<typeof scaffold>['ctx']['agents']['create']>>[] = []
  try {
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const ctx = scaffold.ctx
    const adapter = new SilentAdapter()
    ctx.llm.registerAdapter(['pub-fixture'], adapter)
    const knowledge = ctx.get('lyagentKnowledge')
    const commands = ctx.get('commands')
    const library = ctx.get('lyagentWorkflowLibrary')
    if (knowledge === undefined || commands === undefined || library === undefined) throw new Error('List plugins did not load')
    const workspaceCwd = scaffold.workspaceCwd
    const make = async (sessionId: SessionId) => {
      const handle = await ctx.agents.create({ sessionId, meta: { cwd: workspaceCwd },
        agentOptions: { provider: 'pub-fixture', model: 'fixture' },
        setup: scope => ctx.agentPresets.mount(scope, 'standard').then(() => undefined) })
      created.push(handle)
      ctx.permissionPresets.set(handle.agent.session, 'danger-full-access')
      return handle.agent
    }
    const owner = await make(OWNER)
    const stranger = await make(STRANGER)
    const saved = (agent: typeof owner, input: string) => handledCommand(commands.execute(agent, `/saved-workflow ${input}`, [], new AbortController().signal))
    const versionOf = (id: string): number | undefined => library.list().find(entry => entry.id === id)?.version

    await knowledge.publish('rules', 'Rules', [{ id: 'rule-1', title: 'Rule', text: SECRET }])
    await knowledge.grant(owner.id, [{ collection: 'rules', version: 1 }])
    expect((await saved(owner, `publish-team ${JSON.stringify({ id: 'pa-profile', expectedVersion: 0, definition: {
      kind: 'profile', description: 'Reader', instructions: 'Read it.', provider: 'pub-fixture', model: 'fixture', enabled: true } })}`)).result.kind).toBe('success')
    expect((await saved(owner, `publish-team ${JSON.stringify({ id: 'pa-team', expectedVersion: 0, definition: {
      kind: 'team', description: 'Team', members: [{ role: 'reader', profile: { id: 'pa-profile', version: 1 } }] } })}`)).result.kind).toBe('success')
    const secretPlan = { id: 'secret', expectedVersion: 0, description: 'Protected', nodes: [
      { id: 'draft', kind: 'role', team: { id: 'pa-team', version: 1 }, role: 'reader', prompt: 'Name it',
        dependsOn: [], retry: 1, knowledge: { collection: 'rules', version: 1, query: '编号' } },
    ] }
    expect((await saved(owner, `publish-plan ${JSON.stringify(secretPlan)}`)).result.kind).toBe('success')
    // A plain human edition gives the branch node a legal source.
    expect((await saved(owner, `publish ${JSON.stringify({ id: 'router', expectedVersion: 0, description: 'Router',
      script: 'return { route: true }' })}`)).result.kind).toBe('success')

    // Positive: the owner holds the grant and may embed the protected edition.
    const authorized = await saved(owner, `publish-plan ${JSON.stringify({ id: 'outer', expectedVersion: 0,
      description: 'Outer', nodes: [
        { id: 'call', kind: 'saved', dependsOn: [], retry: 1, workflow: { id: 'secret', version: 1 } },
      ] })}`)
    expect(authorized?.result.kind).toBe('success')
    expect(authorized?.result.text).toContain(SECRET)
    expect(library.read('outer', 1).knowledge).toEqual([{ collection: 'rules', version: 1 }])

    // Negative: a caller without the grant must be refused before any body is returned or stored.
    const strangerAttempts: { name: string; plan: unknown }[] = [
      { name: 'saved', plan: { id: 'x-saved', expectedVersion: 0, description: 'Saved', nodes: [
        { id: 'call', kind: 'saved', dependsOn: [], retry: 1, workflow: { id: 'secret', version: 1 } }] } },
      { name: 'repeat', plan: { id: 'x-repeat', expectedVersion: 0, description: 'Repeat', nodes: [
        { id: 'call', kind: 'repeat', dependsOn: [], retry: 1, count: 2, workflow: { id: 'secret', version: 1 } }] } },
      { name: 'branch', plan: { id: 'x-branch', expectedVersion: 0, description: 'Branch', nodes: [
        { id: 'source', kind: 'saved', dependsOn: [], retry: 1, workflow: { id: 'router', version: 1 } },
        { id: 'choose', kind: 'branch', dependsOn: ['source'], retry: 1, source: 'source', path: ['route'],
          equals: true, then: { id: 'secret', version: 1 }, otherwise: { id: 'secret', version: 1 } }] } },
    ]
    for (const attempt of strangerAttempts) {
      const result = await saved(stranger, `publish-plan ${JSON.stringify(attempt.plan)}`)
      expect(result?.result.kind, attempt.name).toBe('error')
      expect(result?.result.text, attempt.name).toContain('Knowledge access was revoked for rules:1')
      expect(result?.result.text, attempt.name).not.toContain(SECRET)
      expect(result?.result.text, attempt.name).not.toContain('Knowledge excerpts')
      expect(versionOf((attempt.plan as { id: string }).id), attempt.name).toBeUndefined()
    }

    // Multi-layer: the dependency is inherited through an intermediate edition and still refused.
    expect((await saved(owner, `publish-plan ${JSON.stringify({ id: 'mid', expectedVersion: 0, description: 'Mid', nodes: [
      { id: 'call', kind: 'saved', dependsOn: [], retry: 1, workflow: { id: 'secret', version: 1 } }] })}`)).result.kind).toBe('success')
    const layered = await saved(stranger, `publish-plan ${JSON.stringify({ id: 'top', expectedVersion: 0, description: 'Top', nodes: [
      { id: 'call', kind: 'saved', dependsOn: [], retry: 1, workflow: { id: 'mid', version: 1 } }] })}`)
    expect(layered?.result.kind).toBe('error')
    expect(layered?.result.text).toContain('Knowledge access was revoked for rules:1')
    expect(layered?.result.text).not.toContain(SECRET)
    expect(versionOf('top')).toBeUndefined()

    // After a revoke the former owner is refused the same way, so no body leaves in the response.
    expect((await commands.execute(owner, '/knowledge revoke', [], new AbortController().signal))?.result.kind).toBe('success')
    const revoked = await saved(owner, `publish-plan ${JSON.stringify({ id: 'after-revoke', expectedVersion: 0, description: 'After', nodes: [
      { id: 'call', kind: 'saved', dependsOn: [], retry: 1, workflow: { id: 'secret', version: 1 } }] })}`)
    expect(revoked?.result.kind).toBe('error')
    expect(revoked?.result.text).toContain('Knowledge access was revoked for rules:1')
    expect(revoked?.result.text).not.toContain(SECRET)
    expect(versionOf('after-revoke')).toBeUndefined()
    expect(versionOf('secret')).toBe(1)
    // A committed write cannot be reported as an uncommitted failure when access changes before reply.
    await knowledge.grant(owner.id, [{ collection: 'rules', version: 1 }])
    const publish = library.publish.bind(library)
    const spy = vi.spyOn(library, 'publish').mockImplementationOnce(async (...args) => {
      const edition = await publish(...args)
      await knowledge.grant(owner.id, [])
      return edition
    })
    try {
      const committed = await saved(owner, `publish-plan ${JSON.stringify({ id: 'during-write', expectedVersion: 0,
        description: 'Write race', nodes: [
          { id: 'call', kind: 'saved', dependsOn: [], retry: 1, workflow: { id: 'secret', version: 1 } },
        ] })}`)
      expect(committed.result.kind).toBe('success')
      if (committed.result.text === undefined) throw new Error('Committed publication omitted its receipt')
      expect(JSON.parse(committed.result.text)).toMatchObject({ id: 'during-write', version: 1,
        publication: { state: 'committed', body: 'withheld' } })
      expect(committed.result.text).not.toContain(SECRET)
      expect(committed.result.text).not.toContain('Knowledge excerpts')
      expect(versionOf('during-write')).toBe(1)
      // The receipt withholds the body; a later human read re-grants the pinned collection and succeeds.
      expect((await saved(owner, 'read during-write 1')).result.kind).toBe('success')
    } finally { spy.mockRestore() }
    // Publishing never starts a model call, in the refused and the accepted paths alike.
    expect(adapter.requests).toBe(0)
  } finally {
    for (const handle of created) await handle.dispose()
    try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
  }
}, 180000)
