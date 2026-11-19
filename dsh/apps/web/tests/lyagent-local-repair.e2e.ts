/** Bounded artifact-driven correction through the real native Loader and command registry. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-lyagent-artifact-acceptance'
import { launchWebScaffold, rawSessionLog, normalizeWebSessionVolatiles } from './scaffold.ts'
import { normalizeSessionSnapshots } from '@deepseek-ai/dsh-session-snapshot'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'

it.each([false, true])('corrects mapped work and stops unsafe continuation (cancel worker: %s)', async (cancelCase) => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-local-repair-'))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let handle: Awaited<ReturnType<NonNullable<typeof scaffold>['ctx']['agents']['create']>> | undefined
  try {
    const source = `import pathlib, unittest
class Result(unittest.TestCase):
 def test_result(self):
  self.assertEqual(pathlib.Path('result.md').read_text(encoding='utf-8'), 'required corrected')
  self.assertEqual(len(LYAGENT_CHILD_RESULTS), 1)
  self.assertEqual(LYAGENT_CHILD_RESULTS[0]['output'], [{'type': 'text', 'text': 'Reopened work reviewed'}])
`
    await writeFile(join(root, 'test_result.py'), source)
    const python = execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
    const overlay = join(root, 'repair.yml')
    await writeFile(overlay, JSON.stringify([{ id: 'llm-retry', disabled: true }, { insert: [
      { id: 'lyagent-budget', name: '@deepseek-ai/dsh-lyagent-budget', config: {
        batchId: 'keyless-local-repair', maxRequests: 32, maxTokens: 1000, reservationTokens: 10, maxConcurrent: 1,
        runLimits: { maxRequests: 4, maxTokens: 100, childMaxRequests: 1, childMaxTokens: 20 },
      } },
      { id: 'lyagent-artifact-check', name: '@deepseek-ai/dsh-lyagent-artifact-acceptance', config: {
        taskRuns: true, maxRepairs: 1, repairTargets: [{ path: 'result.md', workOrder: 'task-1',
          requiredCapabilities: ['review'], candidates: [
            { id: 'disabled', enabled: false, capabilities: ['review'], provider: 'keyless-replacement', model: 'scripted', readOnlyTools: ['read'] },
            { id: 'wrong-role', enabled: true, capabilities: ['draft'], provider: 'keyless-replacement', model: 'scripted', readOnlyTools: ['read'] },
            { id: 'missing', enabled: true, capabilities: ['review'], provider: 'missing-provider', model: 'scripted', readOnlyTools: ['read'] },
            { id: 'reviewer', enabled: true, capabilities: ['review'], maxActive: 1, provider: 'keyless-replacement', model: 'scripted', readOnlyTools: ['read'] },
            { id: 'spare', enabled: true, capabilities: ['review'], provider: 'keyless-replacement', model: 'scripted', readOnlyTools: ['read'] },
          ] }],
        artifacts: [{ path: 'result.md', minBytes: 1, maxBytes: 1024, includes: ['required'] }],
        tests: { python, root, files: [{ path: 'test_result.py', sha256: createHash('sha256').update(source).digest('hex') }],
          minTests: 1, timeoutMs: 15000, maxChildResultBytes: 4096 },
      } },
    ] }]))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const ctx = scaffold.ctx
    let calls = 0
    let alwaysWrong = false
    let unknownUsage = false
    let beforeDelivery: (() => Promise<void>) | undefined
    let taskCwd = scaffold.workspaceCwd
    class Delivery extends LlmAdapter {
      override async *stream(): AsyncIterable<StreamChunk> {
        const index = calls++
        const step = index % 3
        if (step === 1) await beforeDelivery?.()
        if (step < 2) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`local-repair-${index}`),
            name: step === 0 ? 'write' : 'present', arguments: JSON.stringify(step === 0
              ? { file_path: join(taskCwd, 'result.md'), content: alwaysWrong || index < 3 ? 'incorrect' : 'required corrected' }
              : { files: [{ path: 'result.md' }] }) } }
        }
        if (!unknownUsage || step !== 2) yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: step < 2 ? 'tool-calls' : 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['keyless-local-repair'], new Delivery())
    let replacementCalls = 0
    let oversizedProposal = false
    let cancelWorker: AbortController | undefined
    class Replacement extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        replacementCalls++
        expect(options.messages.flatMap(message => message.content)
          .some(block => block.type === 'text' && block.text.includes('"selected":"reviewer"'))).toBe(true)
        if (cancelWorker !== undefined) {
          const cancelled = Promise.withResolvers<undefined>()
          const onAbort = (): void => { cancelled.resolve(undefined) }
          options.signal?.addEventListener('abort', onAbort, { once: true })
          try {
            cancelWorker.abort()
            if (!options.signal?.aborted) await cancelled.promise
          } finally { options.signal?.removeEventListener('abort', onAbort) }
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text',
          text: oversizedProposal ? '修复'.repeat(4096) : 'Reopened work reviewed' } }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['keyless-replacement'], new Replacement())
    handle = await ctx.agents.create({ sessionId: SessionId('local-repair-owner'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'keyless-local-repair', model: 'scripted' },
      setup: owner => ctx.agentPresets.mount(owner, 'standard').then(() => undefined) })
    const agent = handle.agent
    taskCwd = await ctx.workingDirectory.ensure(agent)
    ctx.permissionPresets.set(agent.session, 'danger-full-access')
    const teams = ctx.agentTeams
    await teams.setEnabled(agent, true)
    const work = await teams.createTask(agent, { subject: 'Correct report', description: 'Mapped artifact owner' })
    expect(work.id).toBe('task-1')
    const dependent = await teams.createTask(agent, { subject: 'Verify report', description: 'Dependent check', blockedBy: [work.id] })
    const independent = await teams.createTask(agent, { subject: 'Unrelated result', description: 'Preserve this revision' })
    for (const task of [work, dependent, independent]) {
      const claimed = await teams.updateTask(agent, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
      await teams.updateTask(agent, { taskId: task.id, expectedRevision: claimed.revision, action: 'complete' })
    }
    const preserved = teams.getTask(agent, independent.id)
    let reopened = false
    let deniedWrites = 0
    const stopWorkerCheck = ctx.on('agent/pre-step', async ({ agent: child, modelSelection, signal }, next) => {
      if (modelSelection.provider === 'keyless-replacement') {
        const allow = ctx.on('tools/pre-execute', async () => ({ kind: 'allow' as const }), { prepend: true })
        try {
          const denied = await executeToolFixture(ctx, { agent: child, signal, name: 'write',
            callId: ToolCallId(`repair-denied-${deniedWrites}`),
            arguments: { file_path: join(taskCwd, 'forbidden.txt'), content: 'not allowed' } })
          expect(denied).toMatchObject({ isError: true, error: { info: { code: 'LYAGENT_REPAIR_READ_ONLY' } } })
          deniedWrites++
        } finally { allow() }
      }
      return next()
    })
    const stop = agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (teams.getTask(agent, work.id).status === 'pending') {
        reopened = true
        expect(teams.getTask(agent, independent.id)).toEqual(preserved)
        for (const task of [work, dependent]) {
          const current = teams.getTask(agent, task.id)
          const claimed = await teams.updateTask(agent, { taskId: task.id, expectedRevision: current.revision, action: 'claim' })
          await teams.updateTask(agent, { taskId: task.id, expectedRevision: claimed.revision, action: 'complete' })
        }
      }
      return decision
    })
    const tasks = ctx.get('lyagentTaskRuns')
    if (tasks === undefined) throw new Error('Missing task runtime')
    await tasks.register('repair-task', agent, 'Produce the required corrected report')
    const result = await ctx.commands.execute(agent, '/task coordinate repair-task', [], new AbortController().signal)
    expect(result?.result.kind).toBe('success')

    expect(reopened).toBe(true)
    expect(calls).toBe(6)
    expect(replacementCalls).toBe(1)
    expect(JSON.stringify(agent.session.deriveMessages())).toContain('Repair worker selection:')
    expect(JSON.stringify(agent.session.deriveMessages())).toContain('provider-unavailable')
    await ctx.sessionPersistence.flush()
    const persisted = await ctx.sessionPersistence.open(agent.id, 'read')
    const history = await (async () => {
      try { return (await persisted.read()).events } finally { await persisted.close() }
    })()
    expect(JSON.stringify(history.filter(event => event.type === 'user/message')))
      .toContain('Host artifact rejection:')
    const repairInputs = history.flatMap(event => event.type === 'user/message'
      && event.data.source.kind === 'user' ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
    const portableCwd = taskCwd.replaceAll('\\', '/')
    const proposalInputs = repairInputs.filter(text => text.startsWith('Repair worker '))
    expect(proposalInputs).toHaveLength(1)
    expect(proposalInputs[0]).toContain('Reopened work reviewed')
    expect(proposalInputs[0]).toContain('unverified correction')
    expect(proposalInputs[0]?.replace(/Repair worker \S+ proposed/, 'Repair worker {{child}} proposed')
      .replace(/"childId":"[^"]+"/, '"childId":"{{child}}"')).toMatchInlineSnapshot(`
        "Repair worker selection: {\"selected\":\"reviewer\",\"decisions\":[{\"id\":\"disabled\",\"reason\":\"disabled\"},{\"id\":\"wrong-role\",\"reason\":\"capability-mismatch\"},{\"id\":\"missing\",\"reason\":\"provider-unavailable\"},{\"id\":\"reviewer\",\"reason\":\"selected\"},{\"id\":\"spare\",\"reason\":\"lower-preference\"}]}
        Repair worker {{child}} proposed the following unverified correction. Review it, update only reopened work and submit a fresh independently tested delivery:
        {\"childId\":\"{{child}}\",\"output\":[{\"type\":\"text\",\"text\":\"Reopened work reviewed\"}]}"
      `)
    expect(repairInputs.filter(text => !text.startsWith('Repair worker '))
      .map(text => text.replaceAll('\\\\', '/').replaceAll('\\', '/').split(portableCwd).join('{{cwd}}')))
      .toMatchInlineSnapshot(`
        [
          "Produce the required corrected report",
          "Produce the required corrected report

        Local repair scope: task-1, task-2. Correct work order task-1 and its reopened dependents. Preserve unrelated completed work and artifacts. Read the current task board, complete only reopened work, and submit a fresh independently tested delivery.

        Host artifact rejection: {\"path\":\"result.md\",\"reason\":\"Required text is absent: {{cwd}}/result.md\"}",
        ]
      `)
    expect(tasks.read('repair-task')).toMatchObject({ outcome: { state: 'completed' }, repairs: [{
      target: work.id, affected: [work.id, dependent.id], preserved: [{ id: independent.id, revision: preserved.revision }],
    }] })
    expect(history.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
      .toEqual(['completed', 'completed'])
    expect(history.filter(event => event.type === 'tool/result' && event.data.error?.code === 'LYAGENT_ARTIFACT_REJECTED'))
      .toHaveLength(1)
    expect(history.filter(event => event.type === 'deliverables/presented')).toHaveLength(1)
    expect(teams.getTask(agent, independent.id)).toEqual(preserved)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(1)
    alwaysWrong = true
    await tasks.register('bounded-failure', agent, 'Remain incomplete when correction is exhausted')
    await tasks.coordinate('bounded-failure', agent, new AbortController().signal)
    expect(calls).toBe(12)
    expect(replacementCalls).toBe(2)
    expect(deniedWrites).toBe(2)
    stopWorkerCheck()
    expect(tasks.read('bounded-failure')).toMatchObject({ outcome: { state: 'needs_attention' },
      repairs: [{ target: work.id }], rejection: { path: 'result.md', repairable: true } })
    expect(tasks.read('bounded-failure')?.repairs).toHaveLength(1)
    expect(teams.getTask(agent, independent.id)).toEqual(preserved)
    const transient = await teams.createTask(agent, { subject: 'Temporary work', description: 'Deletion blocks automatic correction' })
    await tasks.register('deleted-board', agent, 'Do not retry after board deletion')
    beforeDelivery = async () => {
      await teams.updateTask(agent, { taskId: transient.id, expectedRevision: transient.revision, action: 'delete' })
    }
    await tasks.coordinate('deleted-board', agent, new AbortController().signal)
    expect(calls).toBe(15)
    expect(tasks.read('deleted-board')).toMatchObject({ outcome: { state: 'needs_attention' },
      rejection: { repairable: false } })
    expect(tasks.read('deleted-board')?.repairs).toBeUndefined()
    const deletedOutcome = tasks.read('deleted-board')?.outcome
    if (deletedOutcome?.state !== 'needs_attention') throw new Error('Deleted board unexpectedly accepted')
    expect(deletedOutcome.reason).toContain('required work orders are incomplete, changed or unavailable')
    beforeDelivery = undefined
    await tasks.register('cancelled-before-start', agent, 'Never dispatch after cancellation')
    const aborted = new AbortController()
    aborted.abort()
    await expect(tasks.coordinate('cancelled-before-start', agent, aborted.signal)).rejects.toThrow()
    expect(calls).toBe(15)
    expect(tasks.read('cancelled-before-start')?.outcome.state).toBe('queued')
    expect(tasks.read('cancelled-before-start')?.repairs).toBeUndefined()
    await expect(tasks.repair('bounded-failure', agent, work.id, aborted.signal)).rejects.toThrow()
    expect(teams.getTask(agent, work.id).status).toBe('completed')
    expect(tasks.read('bounded-failure')?.repairs).toHaveLength(1)
    unknownUsage = false
    await tasks.register('cancel-during-repair', agent, 'Stop board mutation after cancellation')
    await tasks.execute('cancel-during-repair', agent, new AbortController().signal)
    const cancelRepair = new AbortController()
    const stopCancellation = ctx.on('session/event', (session, event) => {
      if (session.id === agent.id && event.type === 'team/task' && event.data.task.id === work.id
        && event.data.task.status === 'pending') cancelRepair.abort()
    })
    try {
      await expect(tasks.repair('cancel-during-repair', agent, work.id, cancelRepair.signal)).rejects.toThrow()
    } finally { stopCancellation() }
    expect(teams.getTask(agent, work.id).status).toBe('pending')
    expect(teams.getTask(agent, dependent.id).status).toBe('completed')
    expect(teams.getTask(agent, independent.id)).toEqual(preserved)
    expect(tasks.read('cancel-during-repair')?.repairs).toHaveLength(1)
    expect(calls).toBe(18)
    oversizedProposal = true
    for (const task of [work, dependent]) {
      const current = teams.getTask(agent, task.id)
      if (current.status === 'completed') continue
      const claimed = await teams.updateTask(agent, { taskId: task.id, expectedRevision: current.revision, action: 'claim' })
      await teams.updateTask(agent, { taskId: task.id, expectedRevision: claimed.revision, action: 'complete' })
    }
    await tasks.register('oversized-proposal', agent, 'Stop when a child proposal exceeds the configured byte bound')
    await tasks.coordinate('oversized-proposal', agent, new AbortController().signal)
    expect(tasks.read('oversized-proposal')?.outcome.state).toBe('needs_attention')
    expect(tasks.read('oversized-proposal')).toMatchObject({ repairs: [{ target: work.id }] })
    expect(calls).toBe(21)
    expect(replacementCalls).toBe(3)
    expect(await ctx.subagents.waitForTreeWork(agent)).toBe(false)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'user/message')
      .flatMap(event => event.data.content).filter(block => block.type === 'text' && block.text.includes('修复'.repeat(100))))
      .toHaveLength(0)
    oversizedProposal = false
    if (cancelCase) {
      cancelWorker = new AbortController()
      await tasks.register('cancelled-worker', agent, 'Cancel the replacement child without a parent model request')
      await tasks.coordinate('cancelled-worker', agent, cancelWorker.signal)
      expect(tasks.read('cancelled-worker')?.outcome.state).not.toBe('completed')
      expect(calls).toBe(24)
      expect(replacementCalls).toBe(4)
      expect(agent.status).toBe('idle')
      expect(await ctx.subagents.waitForTreeWork(agent)).toBe(false)
      stop()
      return
    }
    unknownUsage = true
    await tasks.register('unknown-usage', agent, 'Never retry unknown model usage')
    await tasks.coordinate('unknown-usage', agent, new AbortController().signal)
    expect(tasks.read('unknown-usage')).toMatchObject({ outcome: { state: 'needs_attention' },
      rejection: { path: 'result.md', repairable: false } })
    expect(tasks.read('unknown-usage')?.repairs).toBeUndefined()
    expect(calls).toBe(24)
    const unknownOutcome = tasks.read('unknown-usage')?.outcome
    if (unknownOutcome?.state !== 'needs_attention') throw new Error('Unknown budget unexpectedly accepted')
    expect(unknownOutcome.reason).toContain('budget usage is unsettled, over limit or its service changed')
    const unknownStatus = await ctx.commands.execute(agent, '/task status unknown-usage', [], new AbortController().signal)
    expect(unknownStatus?.result).toMatchInlineSnapshot(`
      {
        "kind": "success",
        "text": "unknown-usage: needs_attention
      Never retry unknown model usage
      Task acceptance requires attention: the native turn did not complete; no final committed independently accepted delivery; artifact or evaluator versions are unverified or changed; budget usage is unsettled, over limit or its service changed; required work orders are incomplete, changed or unavailable; child work is active, failed or lacks matching persisted acceptance. Review the recorded evidence before restarting.",
      }
    `)
    stop()
  } finally {
    try { await handle?.dispose() } finally {
      try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
}, 120000)

it('settles a recorded rejected-then-corrected delivery through the task runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-task-recorded-'))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let handle: Awaited<ReturnType<NonNullable<typeof scaffold>['ctx']['agents']['create']>> | undefined
  try {
    const source = `import pathlib, unittest
class Delivery(unittest.TestCase):
 def test_result(self):
  self.assertEqual(pathlib.Path('result.md').read_text(encoding='utf-8'), 'required\\n')
`
    await writeFile(join(root, 'test_result.py'), source)
    const python = execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
    const overlay = join(root, 'recorded.yml')
    await writeFile(overlay, JSON.stringify([{ id: 'llm-retry', disabled: true }, { insert: [
      { id: 'lyagent-budget', name: '@deepseek-ai/dsh-lyagent-budget', config: {
        batchId: 'keyless-recorded-task', maxRequests: 6, maxTokens: 100, reservationTokens: 10, maxConcurrent: 1,
        runLimits: { maxRequests: 5, maxTokens: 100, childMaxRequests: 1, childMaxTokens: 10 },
      } },
      { id: 'lyagent-artifact-check', name: '@deepseek-ai/dsh-lyagent-artifact-acceptance', config: {
        taskRuns: true, maxRepairs: 1, artifacts: [{ path: 'result.md', minBytes: 1, maxBytes: 128, includes: ['required'] }],
        tests: { python, root, files: [{ path: 'test_result.py', sha256: createHash('sha256').update(source).digest('hex') }],
          minTests: 1, timeoutMs: 15000 },
      } },
    ] }]))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay, compareReplaySession: false,
      replayFixture: fileURLToPath(new URL('../../../snapshots/session/lyagent-artifact-gate/session.v4.jsonl', import.meta.url)) })
    const ctx = scaffold.ctx
    handle = await ctx.agents.create({ sessionId: SessionId('recorded-task-owner'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: owner => ctx.agentPresets.mount(owner, 'standard').then(() => undefined) })
    const agent = handle.agent
    ctx.permissionPresets.set(agent.session, 'danger-full-access')
    const tasks = ctx.get('lyagentTaskRuns')
    if (tasks === undefined) throw new Error('Missing task runtime')
    await tasks.register('recorded-delivery', agent,
      'Write missing into result.md, present it, write required followed by a newline into result.md and present again. Finish with DONE.')
    await tasks.execute('recorded-delivery', agent, new AbortController().signal)
    const run = tasks.read('recorded-delivery')
    expect(run?.outcome.state).toBe('completed')
    if (run?.outcome.state !== 'completed') throw new Error(JSON.stringify(run))
    expect(run.outcome.evidence.tests).toBe(1)
    expect(await ctx.lyagentBudget.seal(`${agent.id}:${run.outcome.owner.turn}`))
      .toMatchObject({ requests: 5, tokens: 20, ready: true })
    await ctx.sessionPersistence.flush()
    const persisted = await ctx.sessionPersistence.open(agent.id, 'read')
    try {
      const events = (await persisted.read()).events
      expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name))
        .toEqual(['write', 'present', 'write', 'present'])
      expect(events.filter(event => event.type === 'tool/result' && event.data.error?.code === 'LYAGENT_ARTIFACT_REJECTED'))
        .toHaveLength(1)
      expect(events.filter(event => event.type === 'deliverables/presented')).toHaveLength(1)
      expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind)).toEqual(['completed'])
    } finally { await persisted.close() }
    const normalized = normalizeSessionSnapshots([normalizeWebSessionVolatiles(rawSessionLog(agent.session))], {
      sessionIds: [agent.id], cwd: await ctx.workingDirectory.ensure(agent),
    })[0]
    if (normalized === undefined) throw new Error('Missing normalized task session')
    const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url))
    const portable = normalized.split(JSON.stringify(root).slice(1, -1)).join('{{evaluatorRoot}}')
      .split(root).join('{{evaluatorRoot}}')
      .split(scaffold.harnessHome).join('{{harnessHome}}')
      .split(JSON.stringify(sourceRoot).slice(1, -1)).join('{{sourceRoot}}')
      .split(sourceRoot).join('{{sourceRoot}}')
      .split(new URL(scaffold.authenticatedUrl).origin).join('{{webUrl}}')
    await expect(portable).toMatchFileSnapshot('./expected/lyagent-task-recorded-session.jsonl')
    const entered = Promise.withResolvers<undefined>()
    let requestSettled = false
    class Pending extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        entered.resolve(undefined)
        try {
          await new Promise<void>((resolve) => {
            if (options.signal?.aborted) resolve()
            else options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
          })
          options.signal?.throwIfAborted()
          yield { type: 'finish', reason: { kind: 'stop' } }
        } finally { requestSettled = true }
      }
    }
    ctx.llm.registerAdapter(['keyless-pending'], new Pending())
    await handle.dispose()
    handle = await ctx.agents.create({ sessionId: SessionId('active-unload-owner'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'keyless-pending', model: 'scripted' },
      setup: owner => ctx.agentPresets.mount(owner, 'standard').then(() => undefined) })
    const pendingAgent = handle.agent
    await tasks.register('active-unload', pendingAgent, 'Cancel and drain before releasing task storage')
    const execution = tasks.execute('active-unload', pendingAgent, new AbortController().signal)
    await Promise.race([entered.promise, execution.then(() => { throw new Error('Execution ended before pending adapter entered') })])
    const plugin = [...ctx.loader.entries()].find(entry => entry.options.id === 'lyagent-artifact-check')
    if (plugin?.fiber === undefined) throw new Error('Missing task plugin owner')
    await plugin.fiber.dispose()
    await execution
    expect(requestSettled).toBe(true)
    expect(pendingAgent.status).toBe('idle')
    expect(ctx.get('lyagentTaskRuns')).toBeUndefined()
  } finally {
    try { await handle?.dispose() } finally {
      try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
}, 120000)
