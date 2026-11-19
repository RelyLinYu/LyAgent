/** Saved editions execute through the shipped Loader and native workflow tool. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-lyagent-workflow-library'
import { launchWebScaffold } from './scaffold.ts'

it('publishes without requests and executes a pinned edition instead of the latest script', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-saved-workflow-'))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let owner: Awaited<ReturnType<NonNullable<typeof scaffold>['ctx']['agents']['create']>> | undefined
  try {
    const overlay = join(root, 'library.json')
    await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'lyagent-workflow-library',
      name: '@deepseek-ai/dsh-lyagent-workflow-library', config: { maxDefinitionBytes: 4096, maxEntries: 10 } }] }]))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const ctx = scaffold.ctx
    let modelSteps = 0
    class SavedAdapter extends LlmAdapter {
      override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        if (modelSteps++ === 0) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('model-saved'),
            name: 'saved_workflow', arguments: JSON.stringify({ id: 'pinned', version: 1 }) } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['saved-fixture'], new SavedAdapter())
    owner = await ctx.agents.create({ sessionId: SessionId('saved-workflow-owner'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'saved-fixture', model: 'scripted' },
      setup: scope => ctx.agentPresets.mount(scope, 'standard').then(() => undefined) })
    ctx.permissionPresets.set(owner.agent.session, 'danger-full-access')
    const commands = ctx.get('commands')
    if (commands === undefined) throw new Error('Missing native commands')
    const agent = owner.agent
    let requests = 0
    const stop = ctx.on('llm/stream', async function* (_options, next) { requests++; yield* next() })
    try {
      const command = async (input: string) => {
        const execution = await commands.execute(agent, `/saved-workflow ${input}`, [], new AbortController().signal)
        if (execution === undefined) throw new Error('Saved workflow command was not registered')
        return execution
      }
      const first = { id: 'pinned', expectedVersion: 0, description: 'Pinned workflow', script: 'return { marker: "edition-one" }' }
      expect((await command(`publish ${JSON.stringify(first)}`)).result.kind).toBe('success')
      expect((await command(`publish ${JSON.stringify({ ...first, expectedVersion: 1, script: 'return { marker: "edition-two" }' })}`)).result.kind).toBe('success')
      expect((await command(`publish ${JSON.stringify(first)}`)).result.kind).toBe('error')
      expect(requests).toBe(0)
      const old = await command('run pinned 1')
      expect(old.result.kind).toBe('success')
      expect(old.result.text).toContain('edition-one')
      expect(old.result.text).not.toContain('edition-two')
      expect(old.result.text).toContain('"version":1')
      expect((await command('run pinned 3')).result.kind).toBe('error')
      expect((await command('run pinned latest')).result.kind).toBe('error')
      expect(requests).toBe(0)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'tool-workflow/run-start')).toHaveLength(1)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'tool-workflow/run-end')).toHaveLength(1)
      const library = ctx.get('lyagentWorkflowLibrary')
      expect(library?.read('pinned', 1).script).toBe(first.script)
      const native = await ctx.tools.execute({ agent, signal: new AbortController().signal, calls: [{
        type: 'tool-call', id: ToolCallId('saved-edition'), name: 'saved_workflow',
        arguments: JSON.stringify({ id: 'pinned', version: 1 }),
      }] })
      expect(native.results[0]?.result.isError).toBe(false)
      expect(native.results[0]?.result.content).toEqual([{ type: 'text', text: JSON.stringify({
        id: 'pinned', version: 1, sha256: createHash('sha256').update(first.script).digest('hex'),
        result: JSON.stringify([{ type: 'text', text: 'workflow "pinned" completed (0 agents).\nReturn value:\n{\n  "marker": "edition-one"\n}' }]),
      }) }])
      const runsBeforeDenied = agent.session.snapshotEvents().filter(event => event.type === 'tool-workflow/run-start').length
      const savedDefinition = ctx.tools.get('saved_workflow', agent)
      if (savedDefinition === undefined) throw new Error('Missing saved workflow tool')
      const denied = await ctx.tools.execute({ agent, signal: new AbortController().signal,
        toolSet: { dispose() {}, view: scope => new Map(scope === agent ? [['saved_workflow', savedDefinition]] : []) },
        calls: [{ type: 'tool-call', id: ToolCallId('saved-not-admitted'), name: 'saved_workflow',
          arguments: JSON.stringify({ id: 'pinned', version: 1 }) }],
      })
      const deniedResult = denied.results[0]?.result
      expect(deniedResult?.isError).toBe(true)
      expect(deniedResult?.isError && deniedResult.error).toEqual({
        message: 'Saved workflows need the native workflow tool, which is not available to this conversation. Use a preset that exposes workflow, or have the model author the orchestration directly.',
        info: { name: 'WorkflowLibraryError', code: 'LYAGENT_WORKFLOW_LIBRARY_REJECTED' },
      })
      expect(agent.session.snapshotEvents().filter(event => event.type === 'tool-workflow/run-start')).toHaveLength(runsBeforeDenied)
      expect((await command(`publish-plan ${JSON.stringify({ id: 'nested', expectedVersion: 0, description: 'Fixed nested plan', nodes: [
        { id: 'first', kind: 'saved', dependsOn: [], workflow: { id: 'pinned', version: 1 } },
        { id: 'loop', kind: 'repeat', dependsOn: ['first'], count: 2, workflow: { id: 'pinned', version: 1 } },
      ] })}`)).result.kind).toBe('success')
      const nested = await command('run nested 1')
      expect(nested.result.kind).toBe('success')
      expect(nested.result.text).toContain('edition-one')
      expect(nested.result.text).not.toContain('edition-two')
      expect((await command(`publish ${JSON.stringify({ id: 'not-selected', expectedVersion: 0, description: 'Must stay unselected',
        script: 'throw new Error("Unselected branch executed")' })}`)).result.kind).toBe('success')
      expect((await command(`publish-plan ${JSON.stringify({ id: 'branch-plan', expectedVersion: 0, description: 'Native branch and parallel dependencies', nodes: [
        { id: 'source', kind: 'saved', dependsOn: [], workflow: { id: 'pinned', version: 1 } },
        { id: 'parallel', kind: 'repeat', dependsOn: [], count: 2, workflow: { id: 'pinned', version: 1 } },
        { id: 'choose', kind: 'branch', dependsOn: ['source', 'parallel'], source: 'source', path: ['marker'], equals: 'edition-one',
          then: { id: 'nested', version: 1 }, otherwise: { id: 'not-selected', version: 1 } },
      ] })}`)).result.kind).toBe('success')
      const branched = await command('run branch-plan 1')
      expect(branched.result.kind).toBe('success')
      expect(branched.result.text).toContain('edition-one')
      expect(branched.result.text).not.toContain('edition-two')
      const deny = ctx.tools.guard(exec => exec.name === 'workflow' ? {
        reason: 'Saved workflows remain subject to tool policy.',
        info: { name: 'SavedWorkflowTestDenied', code: 'SAVED_WORKFLOW_TEST_DENIED' },
      } : undefined)
      try { expect((await command('run pinned 1')).result.kind).toBe('error') } finally { deny() }
      expect((await command(`publish ${JSON.stringify({ id: 'broken', expectedVersion: 0,
        description: 'Invalid script', script: 'return {' })}`)).result.kind).toBe('success')
      expect((await command('run broken 1')).result.kind).toBe('error')
      const cancelled = new AbortController()
      cancelled.abort()
      await expect(commands.execute(agent, '/saved-workflow run pinned 1', [], cancelled.signal)).rejects.toBeDefined()
      expect(requests).toBe(0)
    } finally { stop() }
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Execute saved workflow pinned version 1.' }] }))
    await agent.whenIdle()
    expect(modelSteps).toBe(2)
    const delivered = agent.session.snapshotEvents().find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'model-saved')
    expect(delivered?.type === 'tool/result' && delivered.data.message.isError).toBe(false)
    expect(JSON.stringify(delivered)).toContain('edition-one')
    const plugin = [...ctx.loader.entries()].find(entry => entry.options.id === 'lyagent-workflow-library')
    if (plugin?.fiber === undefined) throw new Error('Missing workflow library owner')
    const entered = Promise.withResolvers<undefined>()
    let drained = false
    const release = ctx.on('tools/execute', async (exec, next) => {
      if (exec.name !== 'workflow') return next()
      entered.resolve(undefined)
      try {
        await new Promise<void>((resolve) => {
          if (exec.signal.aborted) resolve()
          else exec.signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        return await next()
      } finally { drained = true }
    })
    try {
      const active = commands.execute(agent, '/saved-workflow run pinned 1', [], new AbortController().signal)
      await Promise.race([entered.promise, active.then(() => { throw new Error('Workflow ended before dispatch') })])
      await plugin.fiber.dispose()
      expect((await active)?.result.kind).toBe('error')
      expect(drained).toBe(true)
      expect(ctx.tools.get('saved_workflow', agent)).toBeUndefined()
      expect(commands.find(agent, 'saved-workflow')).toBeUndefined()
      expect(ctx.get('lyagentWorkflowLibrary')).toBeUndefined()
    } finally { release() }
  } finally {
    try { await owner?.dispose() } finally {
      try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
}, 120000)
