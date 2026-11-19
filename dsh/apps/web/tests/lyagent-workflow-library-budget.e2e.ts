/** Saved scripts retain native parent-turn and child budget attribution. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-lyagent-workflow-library'
import type {} from '@deepseek-ai/dsh-lyagent-budget'
import { launchWebScaffold } from './scaffold.ts'

it('charges a saved workflow child and its caller to one sealed parent allocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-saved-budget-'))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let owner: Awaited<ReturnType<NonNullable<typeof scaffold>['ctx']['agents']['create']>> | undefined
  try {
    const overlay = join(root, 'library.json')
    await writeFile(overlay, JSON.stringify([{ id: 'llm-retry', disabled: true }, { insert: [
      { id: 'lyagent-workflow-library', name: '@deepseek-ai/dsh-lyagent-workflow-library',
        config: { maxDefinitionBytes: 4096, maxEntries: 10 } },
      { id: 'lyagent-budget', name: '@deepseek-ai/dsh-lyagent-budget', config: {
        batchId: 'keyless-saved-workflow', maxRequests: 3, maxTokens: 100, reservationTokens: 10, maxConcurrent: 1,
        runLimits: { maxRequests: 3, maxTokens: 100, childMaxRequests: 1, childMaxTokens: 20 },
      } },
    ] }]))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const ctx = scaffold.ctx
    let parents = 0
    let children = 0
    class Adapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const child = options.sessionId !== undefined && ctx.agents.get(options.sessionId)?.session.header.origin === 'subagent'
        if (child) {
          expect(JSON.stringify(options.messages)).toContain('Review the assigned evidence only')
          expect(JSON.stringify(options.messages)).toContain('Pinned team: review-team:1; role: review; profile: reviewer:1')
          children++
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'saved-child-result' } }
        } else if (parents++ === 0) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('saved-budget-call'),
            name: 'saved_workflow', arguments: JSON.stringify({ id: 'delegated', version: 1 }) } }
        }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: !child && parents === 1 ? 'tool-calls' : 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['saved-budget-fixture'], new Adapter())
    owner = await ctx.agents.create({ sessionId: SessionId('saved-budget-owner'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'saved-budget-fixture', model: 'scripted' },
      setup: scope => ctx.agentPresets.mount(scope, 'standard').then(() => undefined) })
    const agent = owner.agent
    ctx.permissionPresets.set(agent.session, 'danger-full-access')
    const library = ctx.get('lyagentWorkflowLibrary')
    if (library === undefined) throw new Error('Missing saved workflow library')
    const commands = ctx.get('commands')
    if (commands === undefined) throw new Error('Missing native commands')
    for (const publication of [
      { id: 'reviewer', expectedVersion: 0, definition: { kind: 'profile', description: 'Reviewer', instructions: 'Review the assigned evidence only',
        provider: 'saved-budget-fixture', model: 'scripted', enabled: true } },
      { id: 'review-team', expectedVersion: 0, definition: { kind: 'team', description: 'Review team',
        members: [{ role: 'review', profile: { id: 'reviewer', version: 1 } }] } },
    ]) {
      expect((await commands.execute(agent, `/saved-workflow publish-team ${JSON.stringify(publication)}`, [], new AbortController().signal))?.result.kind).toBe('success')
    }
    const published = await commands.execute(agent, `/saved-workflow publish-plan ${JSON.stringify({ id: 'delegated', expectedVersion: 0, description: 'Review with one child', nodes: [
      { id: 'review', kind: 'role', dependsOn: [], prompt: 'Return the saved child result',
        team: { id: 'review-team', version: 1 }, role: 'review' },
    ] })}`, [], new AbortController().signal)
    expect(published?.result.kind).toBe('success')
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'Execute delegated version 1.' }] }))
    await agent.whenIdle()
    expect(parents).toBe(2)
    expect(children).toBe(1)
    const events = agent.session.snapshotEvents()
    const result = events.find(event => event.type === 'tool/result' && event.data.message.toolCallId === 'saved-budget-call')
    expect(result?.type === 'tool/result' && result.data.message.isError).toBe(false)
    expect(JSON.stringify(result)).toContain('saved-child-result')
    const turn = events.find(event => event.type === 'turn/start')
    if (turn === undefined) throw new Error('Missing parent turn')
    expect(await ctx.get('lyagentBudget')?.seal(`${agent.id}:${turn.seq}`)).toMatchObject({ requests: 3, tokens: 12, ready: true })
    expect(await ctx.subagents.waitForTreeWork(agent)).toBe(false)
  } finally {
    try { await owner?.dispose() } finally {
      try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
}, 120000)
