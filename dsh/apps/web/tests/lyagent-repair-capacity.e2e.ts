/** Concurrent native repairs reserve candidates before asynchronous child startup. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-lyagent-artifact-acceptance'
import { launchWebScaffold } from './scaffold.ts'

it('uses a spare while the preferred repair candidate is occupied and releases both reservations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-repair-capacity-'))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  const handles: Awaited<ReturnType<NonNullable<typeof scaffold>['ctx']['agents']['create']>>[] = []
  const entered = Promise.withResolvers<undefined>()
  const bothEntered = Promise.withResolvers<undefined>()
  const releaseWorkers = Promise.withResolvers<undefined>()
  try {
    const evaluator = 'import unittest\nclass Check(unittest.TestCase):\n def test_unused(self): self.assertTrue(True)\n'
    await writeFile(join(root, 'test_capacity.py'), evaluator)
    const python = execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
    const overlay = join(root, 'capacity.json')
    await writeFile(overlay, JSON.stringify([{ id: 'llm-retry', disabled: true }, { insert: [
      { id: 'lyagent-budget', name: '@deepseek-ai/dsh-lyagent-budget', config: {
        batchId: 'keyless-capacity', maxRequests: 60, maxTokens: 1000, reservationTokens: 10, maxConcurrent: 2,
        runLimits: { maxRequests: 4, maxTokens: 100, childMaxRequests: 1, childMaxTokens: 20 },
      } },
      { id: 'lyagent-artifact-check', name: '@deepseek-ai/dsh-lyagent-artifact-acceptance', config: {
        taskRuns: true, maxRepairs: 1, artifacts: ['result.md', 'other.md']
          .map(path => ({ path, minBytes: 1, maxBytes: 100, includes: ['required'] })),
        repairTargets: [{ path: 'other.md', workOrder: 'task-1',
          worker: { provider: 'wrong-artifact-worker', model: 'scripted', readOnlyTools: [] } },
        { path: 'result.md', workOrder: 'task-1', requiredCapabilities: ['review'], candidates:
          ['preferred', 'spare'].map(id => ({ id, enabled: true, capabilities: ['review'], maxActive: 1,
            provider: 'keyless-capacity-worker', model: 'scripted', readOnlyTools: [] })) }],
        tests: { python, root, files: [{ path: 'test_capacity.py', sha256: createHash('sha256').update(evaluator).digest('hex') }],
          minTests: 1, timeoutMs: 15000, maxChildResultBytes: 4096 },
      } },
    ] }]))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const ctx = scaffold.ctx
    const steps = new Map<string, number>()
    class Parent extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const key = options.sessionId ?? ''
        const step = steps.get(key) ?? 0
        steps.set(key, step + 1)
        if (key === 'capacity-ambiguous') {
          yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        if (step % 3 < 2) {
          const write = step % 3 === 0
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`${key}-${step}`),
            name: write ? 'write' : 'present', arguments: JSON.stringify(write
              ? { file_path: 'result.md', content: 'incorrect' } : { files: [{ path: 'result.md' }] }) } }
        }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: step % 3 < 2 ? 'tool-calls' : 'stop' } }
      }
    }
    const selected: string[] = []
    class Worker extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const input = options.messages.flatMap(message => message.content)
          .filter(block => block.type === 'text').map(block => block.text).join('\n')
        const id = input.includes('"selected":"preferred"') ? 'preferred' : input.includes('"selected":"spare"') ? 'spare' : 'missing'
        selected.push(id)
        entered.resolve(undefined)
        if (selected.length === 2) bothEntered.resolve(undefined)
        await releaseWorkers.promise
        options.signal?.throwIfAborted()
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Unverified review proposal' } }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['keyless-capacity-parent'], new Parent())
    ctx.llm.registerAdapter(['keyless-capacity-worker'], new Worker())
    const tasks = ctx.get('lyagentTaskRuns')
    if (tasks === undefined) throw new Error('Missing task runtime')
    for (const id of ['first', 'second', 'third', 'cleanup-failure', 'after-failure', 'saturated', 'start-failure', 'after-start-failure', 'ambiguous']) {
      const cwd = join(scaffold.workspaceCwd, id)
      await mkdir(cwd)
      const handle = await ctx.agents.create({ sessionId: SessionId(`capacity-${id}`), meta: { cwd },
        agentOptions: { provider: 'keyless-capacity-parent', model: 'scripted' },
        setup: owner => ctx.agentPresets.mount(owner, 'standard').then(() => undefined) })
      handles.push(handle)
      const agent = handle.agent
      ctx.permissionPresets.set(agent.session, 'danger-full-access')
      await ctx.agentTeams.setEnabled(agent, true)
      const work = await ctx.agentTeams.createTask(agent, { subject: 'Review', description: 'Repair mapping' })
      expect(work.id).toBe('task-1')
      const claimed = await ctx.agentTeams.updateTask(agent, { taskId: work.id, expectedRevision: work.revision, action: 'claim' })
      await ctx.agentTeams.updateTask(agent, { taskId: work.id, expectedRevision: claimed.revision, action: 'complete' })
      await tasks.register(id, agent, 'Attempt the mapped result without automatic retries')
      await tasks.execute(id, agent, new AbortController().signal)
      expect(tasks.read(id)?.outcome.state).toBe('needs_attention')
      await tasks.repair(id, agent, work.id)
    }
    const first = handles[0]?.agent
    const second = handles[1]?.agent
    const third = handles[2]?.agent
    if (first === undefined || second === undefined || third === undefined) throw new Error('Missing owners')
    const running = tasks.execute('first', first, new AbortController().signal)
    await entered.promise
    const secondRunning = tasks.execute('second', second, new AbortController().signal)
    await bothEntered.promise
    const saturated = handles[5]?.agent
    if (saturated === undefined) throw new Error('Missing saturated owner')
    const requestsBefore = steps.get(saturated.id)
    await tasks.execute('saturated', saturated, new AbortController().signal)
    expect(tasks.read('saturated')?.outcome.state).toBe('needs_attention')
    expect(steps.get(saturated.id)).toBe(requestsBefore)
    expect(selected).toEqual(['preferred', 'spare'])
    expect(await ctx.subagents.waitForTreeWork(saturated)).toBe(false)
    releaseWorkers.resolve(undefined)
    await Promise.all([running, secondRunning])
    expect(selected).toEqual(['preferred', 'spare'])
    await tasks.execute('third', third, new AbortController().signal)
    expect(selected).toEqual(['preferred', 'spare', 'preferred'])
    expect(tasks.read('third')?.outcome.state).toBe('needs_attention')
    const decisions = second.session.deriveMessages().flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text)
      .filter(text => text.startsWith('Repair worker selection:')).map(text => text.split('\n')[0])
    expect(decisions).toEqual([
      'Repair worker selection: {"selected":"spare","decisions":[{"id":"preferred","reason":"capacity-full"},{"id":"spare","reason":"selected"}]}',
    ])
    const fourth = handles[3]?.agent
    const fifth = handles[4]?.agent
    if (fourth === undefined || fifth === undefined) throw new Error('Missing cleanup owners')
    const start = ctx.subagents.startActivation.bind(ctx.subagents)
    const fault = vi.spyOn(ctx.subagents, 'startActivation').mockImplementation(async (spec) => {
      const activation = await start(spec)
      return { ...activation, dispose: async () => {
        await activation.dispose()
        throw new Error('Injected disposal acknowledgement failure')
      } }
    })
    try { await tasks.execute('cleanup-failure', fourth, new AbortController().signal) } finally { fault.mockRestore() }
    expect(tasks.read('cleanup-failure')?.outcome.state).toBe('needs_attention')
    await tasks.execute('after-failure', fifth, new AbortController().signal)
    expect(selected).toEqual(['preferred', 'spare', 'preferred', 'preferred', 'spare'])
    expect(await ctx.subagents.waitForTreeWork(fourth)).toBe(false)
    expect(await ctx.subagents.waitForTreeWork(fifth)).toBe(false)
    const failedStart = handles[6]?.agent
    const afterFailedStart = handles[7]?.agent
    if (failedStart === undefined || afterFailedStart === undefined) throw new Error('Missing startup owners')
    const noStart = vi.spyOn(ctx.subagents, 'startActivation').mockRejectedValue(new Error('Injected startup failure'))
    try { await tasks.execute('start-failure', failedStart, new AbortController().signal) } finally { noStart.mockRestore() }
    expect(tasks.read('start-failure')?.outcome.state).toBe('needs_attention')
    expect(await ctx.subagents.waitForTreeWork(failedStart)).toBe(false)
    await tasks.execute('after-start-failure', afterFailedStart, new AbortController().signal)
    expect(selected).toEqual(['preferred', 'spare', 'preferred', 'preferred', 'spare', 'spare'])
    const ambiguous = handles[8]?.agent
    if (ambiguous === undefined) throw new Error('Missing ambiguous owner')
    expect(tasks.read('ambiguous')?.rejection).toBeUndefined()
    await tasks.execute('ambiguous', ambiguous, new AbortController().signal)
    expect(tasks.read('ambiguous')?.outcome.state).toBe('needs_attention')
    expect(steps.get(ambiguous.id)).toBe(1)
    expect(selected).toHaveLength(6)
    expect(await ctx.subagents.waitForTreeWork(ambiguous)).toBe(false)
  } finally {
    bothEntered.resolve(undefined)
    releaseWorkers.resolve(undefined)
    try { await Promise.all(handles.map(handle => handle.dispose())) } finally {
      try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
}, 120000)
