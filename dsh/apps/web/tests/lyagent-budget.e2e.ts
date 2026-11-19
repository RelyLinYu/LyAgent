/** Real shipped Web Loader composition for the opt-in batch guard; no provider network traffic. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import { launchWebScaffold } from './scaffold.ts'

it('charges spawned child requests to their parent turn and denies exhausted child shares before dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-run-budget-'))
  const overlay = join(root, 'budget.overlay.yml')
  await writeFile(overlay, [
    '- id: llm-retry', '  disabled: true', '- insert:', '    - id: lyagent-budget',
    "      name: '@deepseek-ai/dsh-lyagent-budget'", '      config:',
    '        batchId: parent-turn-fixture', '        maxRequests: 8', '        maxTokens: 80',
    '        reservationTokens: 10', '        maxConcurrent: 2', '        runLimits:',
    '          maxRequests: 2', '          maxTokens: 40',
    '          childMaxRequests: 1', '          childMaxTokens: 20', '',
  ].join('\n'))
  const scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
  const ctx = scaffold.ctx
  let calls = 0
  class RunAdapter extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      calls++
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['run-budget-fixture'], new RunAdapter())
  const parentHandle = await ctx.agents.create({
    sessionId: SessionId('run-budget-parent'), meta: { cwd: scaffold.workspaceCwd },
    agentOptions: { provider: 'run-budget-fixture', model: 'fixture' },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
  })
  const parent = parentHandle.agent
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const disposeHold = ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (agent === parent) { entered.resolve(undefined); await release.promise }
    return next()
  })
  let child: SubagentActivation | undefined
  try {
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Parent budget task' }], source: { kind: 'user' } }))
    await entered.promise
    await expect((async () => {
      for await (const _chunk of ctx.llm.stream({ provider: 'run-budget-fixture', model: 'fixture', messages: [] })) { /* unowned calls cannot bypass shares */ }
    })()).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
    expect(calls).toBe(0)
    child = await ctx.subagents.startActivation({
      parent, provider: 'spawn', label: 'Bound child', delivery: 'caller',
      prompt: [{ type: 'text', text: 'Return once' }], signal: new AbortController().signal,
    })
    const agent = ctx.agents.get(child.childId)
    if (agent === undefined) throw new Error('Budget child is unavailable')
    await agent.whenIdle()
    expect(calls).toBe(1)
    const request = { provider: 'run-budget-fixture', model: 'fixture', messages: [], sessionId: child.childId }
    await expect((async () => {
      for await (const _chunk of ctx.llm.stream(request)) { /* share denial precedes adapter */ }
    })()).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
    expect(calls).toBe(1)
    release.resolve(undefined)
    await parent.whenIdle()
    expect(calls).toBe(2)
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Independent next turn' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(calls).toBe(3)
    await expect((async () => {
      for await (const _chunk of ctx.llm.stream(request)) { /* old child remains bound to old exhausted run */ }
    })()).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
    expect(calls).toBe(3)
    // The root is idle between tasks; a detached request must not reuse its last turn.
    await expect((async () => {
      for await (const _chunk of ctx.llm.stream({ provider: 'run-budget-fixture', model: 'fixture', messages: [], sessionId: parent.id })) { /* closed root turn */ }
    })()).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
  } finally {
    release.resolve(undefined)
    disposeHold()
    try { await child?.dispose() } finally {
      try { await parentHandle.dispose() } finally {
        try { await scaffold.close() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  }
})

it('loads the native batch guard and durably rejects an exhausted batch before the replay adapter', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-budget-composition-'))
  const overlay = join(root, 'budget.overlay.yml')
  await writeFile(overlay, [
    '- id: llm-retry', '  disabled: true',
    '- insert:', '    - id: lyagent-budget', "      name: '@deepseek-ai/dsh-lyagent-budget'", '      config:',
    '        batchId: loader-acceptance-only', '        maxRequests: 1', '        maxTokens: 20',
    '        reservationTokens: 10', '        maxConcurrent: 1', '',
  ].join('\n'))
  const replayOverride = join(root, 'replay.override.json')
  await writeFile(replayOverride, JSON.stringify([{ kind: 'chunks', chunks: [
    { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] }]))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  try {
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay, replayFixture: join(root, 'override-only.jsonl'), replayOverride, compareReplaySession: false })
    const request = { provider: 'deepseek-official', model: 'deepseek-v4-flash', messages: [] }
    for await (const _chunk of scaffold.ctx.llm.stream(request)) { /* consume the single authorized fixture call */ }
    await expect((async () => {
      for await (const _chunk of scaffold.ctx.llm.stream(request)) { /* denial must occur before replay */ }
    })()).rejects.toMatchObject({ code: 'LYAGENT_BUDGET_STOPPED' })
  } finally {
    try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
  }
})
