/** A PTC program cannot run a saved workflow: the composition omits the native workflow tool. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-lyagent-workflow-library'
import type {} from '@deepseek-ai/dsh-lyagent-budget'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { launchWebScaffold } from './scaffold.ts'

const DIAGNOSTIC = 'Saved workflows need the native workflow tool, which is not available to this conversation.'
const program = `const saved = await tools.saved_workflow({ id: 'delegated', version: 1 })
return saved`

it('reports the missing native workflow tool instead of a generic saved workflow failure under PTC', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-ptc-saved-denial-'))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let owner: Awaited<ReturnType<NonNullable<typeof scaffold>['ctx']['agents']['create']>> | undefined
  try {
    const overlay = join(root, 'library.json')
    await writeFile(overlay, JSON.stringify([{ id: 'llm-retry', disabled: true }, { insert: [
      { id: 'lyagent-workflow-library', name: '@deepseek-ai/dsh-lyagent-workflow-library',
        config: { maxDefinitionBytes: 4096, maxEntries: 10 } },
      { id: 'lyagent-budget', name: '@deepseek-ai/dsh-lyagent-budget', config: {
        batchId: 'keyless-ptc-saved-denial', maxRequests: 4, maxTokens: 100, reservationTokens: 10, maxConcurrent: 1,
        runLimits: { maxRequests: 4, maxTokens: 100, childMaxRequests: 1, childMaxTokens: 20 },
      } },
    ] }]))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const ctx = scaffold.ctx
    let parents = 0
    let children = 0
    class Adapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const child = options.sessionId !== undefined && ctx.agents.get(options.sessionId)?.session.header.origin === 'subagent'
        if (child) { children++ } else if (parents++ === 0) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('ptc-saved-denial-call'),
            name: 'run_code', arguments: JSON.stringify({ description: 'Run the saved review workflow version 1', code: program }) } }
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Saved workflow refused.' } }
        }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: !child && parents === 1 ? 'tool-calls' : 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['ptc-saved-denial-fixture'], new Adapter())
    owner = await ctx.agents.create({ sessionId: SessionId('ptc-saved-denial-owner'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'ptc-saved-denial-fixture', model: 'scripted' },
      setup: scope => ctx.agentPresets.mount(scope, 'ptc').then(() => undefined) })
    const agent = owner.agent
    ctx.permissionPresets.set(agent.session, 'danger-full-access')
    if (ctx.get('lyagentWorkflowLibrary') === undefined) throw new Error('Missing saved workflow library')
    const commands = ctx.get('commands')
    if (commands === undefined) throw new Error('Missing native commands')
    for (const publication of [
      { id: 'reviewer', expectedVersion: 0, definition: { kind: 'profile', description: 'Reviewer', instructions: 'Review the assigned evidence only',
        provider: 'ptc-saved-denial-fixture', model: 'scripted', enabled: true } },
      { id: 'review-team', expectedVersion: 0, definition: { kind: 'team', description: 'Review team',
        members: [{ role: 'review', profile: { id: 'reviewer', version: 1 } }] } },
    ]) {
      expect((await commands.execute(agent, `/saved-workflow publish-team ${JSON.stringify(publication)}`, [], new AbortController().signal))?.result.kind).toBe('success')
    }
    expect((await commands.execute(agent, `/saved-workflow publish-plan ${JSON.stringify({ id: 'delegated', expectedVersion: 0, description: 'Review with one child', nodes: [
      { id: 'review', kind: 'role', dependsOn: [], prompt: 'Return the saved child result',
        team: { id: 'review-team', version: 1 }, role: 'review' },
    ] })}`, [], new AbortController().signal))?.result.kind).toBe('success')
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Execute delegated version 1 through one program.' }] }))
    await agent.whenIdle()
    expect(parents).toBe(2)
    const events = agent.session.snapshotEvents()
    const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'ptc-saved-denial-call')
    if (result?.type !== 'tool/result') throw new Error('Missing run_code result')
    expect(result.data.message.isError).toBe(true)
    expect(JSON.stringify(result)).toContain(DIAGNOSTIC)
    expect(JSON.stringify(result)).not.toContain('Saved workflow execution failed (UNKNOWN_TOOL)')
    expect(children).toBe(0)
    const turn = events.find(event => event.type === 'turn/start')
    if (turn === undefined) throw new Error('Missing parent turn')
    expect(await ctx.get('lyagentBudget')?.seal(`${agent.id}:${turn.seq}`)).toMatchObject({ requests: 2, tokens: 8, ready: true })
    expect(await ctx.subagents.waitForTreeWork(agent)).toBe(false)
  } finally {
    try { await owner?.dispose() } finally {
      try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
}, 180000)
