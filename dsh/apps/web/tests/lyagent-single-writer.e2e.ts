/** Native Loader and execution-pipeline acceptance for parent-only tool effects. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { requireBuilt } from './support.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ApprovalRequestId } from '@deepseek-ai/dsh-user-approval'
import type { SubagentActivation } from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-lyagent-knowledge'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { launchWebScaffold } from './scaffold.ts'

it('records native deliveries only after host-owned artifact checks pass for that version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-artifact-loader-'))
  const overlay = join(root, 'acceptance.yml')
  const evaluator = join(root, 'test_artifact.py')
  const testSource = `import pathlib, unittest
class ArtifactTest(unittest.TestCase):
 def test_body(self):
  path = pathlib.Path('result.md')
  content = path.read_text(encoding='utf-8')
  self.assertIn('tested', content)
  for child in LYAGENT_CHILD_RESULTS:
   self.assertEqual(child['output'], [{'type': 'text', 'text': 'Independent child checked'}])
  if 'timeout' in content:
   __import__('time').sleep(60)
  if 'mutate' in content:
   path.write_text('required tested but changed during evaluation', encoding='utf-8')
  if 'skip' in content:
   self.skipTest('not verified')
def load_tests(loader, tests, pattern):
 if 'zero' in pathlib.Path('result.md').read_text(encoding='utf-8'):
  return unittest.TestSuite()
 return tests
`
  await writeFile(evaluator, testSource)
  const python = execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
  await writeFile(overlay, JSON.stringify([{ id: 'llm-retry', disabled: true }, { insert: [{ id: 'lyagent-knowledge',
    name: '@deepseek-ai/dsh-lyagent-knowledge', config: {
      maxCollectionBytes: 10000, maxResultBytes: 2000, maxMatches: 4, maxLineChars: 200,
    } }, { id: 'lyagent-budget', name: '@deepseek-ai/dsh-lyagent-budget', config: {
    batchId: 'artifact-local-fixture', maxRequests: 100, maxTokens: 10000, reservationTokens: 10, maxConcurrent: 2,
    runLimits: { maxRequests: 8, maxTokens: 100, childMaxRequests: 2, childMaxTokens: 20 },
  } }, { id: 'lyagent-artifact-check',
    name: '@deepseek-ai/dsh-lyagent-artifact-acceptance', config: { artifacts: [
      { path: 'result.md', minBytes: 1, maxBytes: 128, includes: ['required'] },
    ], taskRuns: true, maxRepairs: 2, tests: { python, root, files: [{ path: 'test_artifact.py', sha256: createHash('sha256').update(testSource).digest('hex') }],
      minTests: 1, timeoutMs: 15000, maxChildResultBytes: 4096 } } }] }]))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let handle: Awaited<ReturnType<NonNullable<typeof scaffold>['ctx']['agents']['create']>> | undefined
  try {
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const ctx = scaffold.ctx
    const path = join(scaffold.workspaceCwd, 'result.md')
    let attempt = 0
    let readAfterDelivery = false
    let readBeforeDelivery = false
    let omitFinalUsage = false
    let finalInputTokens = 2
    let beforeSettlement: (() => Promise<void>) | undefined
    let afterBegin: (() => Promise<void>) | undefined
    let childEntered = Promise.withResolvers<undefined>()
    let childRelease = Promise.withResolvers<undefined>()
    let childPendingApproval = false
    let childText = 'Independent child checked'
    class ChildAdapter extends LlmAdapter {
      override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        childEntered.resolve(undefined)
        await Promise.race([childRelease.promise, new Promise<void>((resolve) => {
          if (options.signal?.aborted) resolve()
          else options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
        })])
        options.signal?.throwIfAborted()
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: childText } }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
    ctx.llm.registerAdapter(['settlement-child-fixture'], new ChildAdapter())
    class DeliveryAdapter extends LlmAdapter {
      override async *stream(): AsyncIterable<StreamChunk> {
        if (readBeforeDelivery) {
          readBeforeDelivery = false
          const id = ToolCallId(`before-delivery-read-${attempt}`)
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read', arguments: JSON.stringify({ file_path: path }) } }
          yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        if (readAfterDelivery && attempt % 2 === 1) {
          readAfterDelivery = false
          const id = ToolCallId(`after-delivery-read-${attempt}`)
          const args = JSON.stringify({ file_path: path })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read', arguments: args } }
          yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
          return
        }
        if (attempt++ % 2 === 0) {
          const id = ToolCallId(`delivery-${attempt}`)
          const args = JSON.stringify({ files: [{ path }] })
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'tool-call-delta', index: 0, id, name: 'present', argumentsDelta: args }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'present', arguments: args } }
          yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
          yield { type: 'finish', reason: { kind: 'tool-calls' } }
        } else {
          if (!omitFinalUsage) yield { type: 'usage', usage: { inputTokens: finalInputTokens, outputTokens: 1 } }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
    }
    ctx.llm.registerAdapter(['artifact-fixture'], new DeliveryAdapter())
    handle = await ctx.agents.create({ sessionId: SessionId('artifact-parent'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'artifact-fixture', model: 'fixture' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined) })
    const agent = handle.agent
    const knowledge = ctx.get('lyagentKnowledge')
    if (knowledge === undefined) throw new Error('Knowledge service is unavailable')
    await knowledge.publish('manual', 'Manual', [{ id: 'policy', title: 'Policy', text: 'required tested' }])
    await knowledge.grant(agent.id, [{ collection: 'manual', version: 1 }])
    let timedOutTests = 0
    ctx.on('tools/result', (exec, result) => {
      if (exec.agent === agent && exec.name === 'pwsh' && !result.isError && result.value !== null
        && typeof result.value === 'object' && !Array.isArray(result.value) && result.value.timedOut === true) timedOutTests++
    })
    ctx.permissionPresets.set(agent.session, 'danger-full-access')
    const deliver = async (content: string, changeBeforeSettlement = false, readAfter = false,
      revokeSource = false, pendingApproval = false) => {
      readAfterDelivery = readAfter
      const task = `task-${attempt}`
      const tasks = ctx.get('lyagentTaskRuns')
      if (tasks === undefined) throw new Error('Task run service is unavailable')
      await tasks.register(task, agent, 'Deliver an independently tested result')
      let started = false
      const stop = agent.ctx.on('agent/pre-step', async (_payload, next) => {
        if (!started) {
          await tasks.begin(task, agent)
          await afterBegin?.()
          if (pendingApproval) agent.session.append('approval/asked', {
            id: ApprovalRequestId(`unsettled-${task}`), toolName: 'fixture',
          })
          started = true
        }
        return next()
      })
      await writeFile(path, content)
      try {
        agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Deliver the result file.' }], source: { kind: 'user' } }))
        await agent.whenIdle()
        expect(started, JSON.stringify(agent.session.snapshotEvents().slice(-3))).toBe(true)
        expect(tasks.read(task)?.outcome.state).not.toBe('completed')
        if (changeBeforeSettlement) await writeFile(path, 'changed after delivery before task settlement'.repeat(100))
        if (revokeSource) await knowledge.grant(agent.id, [])
        await beforeSettlement?.()
        await tasks.settle(task, agent)
        return tasks.read(task)
      } finally { stop() }
    }
    expect((await deliver('missing marker'))?.outcome.state).toBe('needs_attention')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(0)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)?.data).toMatchObject({
      message: { isError: true }, error: { code: 'LYAGENT_ARTIFACT_REJECTED' },
    })
    await deliver('required content')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(0)
    for (const content of ['required tested zero', 'required tested skip', 'required tested mutate', 'required tested timeout']) {
      await deliver(content)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(0)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)?.data).toMatchObject({
        message: { isError: true }, error: { code: 'LYAGENT_ARTIFACT_REJECTED' },
      })
    }
    expect((await deliver('required tested content'))?.outcome.state).toBe('completed')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(1)
    expect(timedOutTests).toBe(1)
    const stopTests = ctx.tools.guard(exec => exec.name === 'pwsh' ? {
      reason: 'Evaluator permission withheld', info: { name: 'EvaluatorDenied', code: 'EVALUATOR_DENIED' },
    } : undefined)
    try {
      await deliver('required tested content')
      expect(agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(1)
      expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)?.data).toMatchObject({
        message: { isError: true }, error: { code: 'LYAGENT_ARTIFACT_REJECTED' },
      })
    } finally { stopTests() }
    await deliver('required tested content')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(2)
    const checked = agent.session.snapshotEvents().filter(event => event.type === 'tool/result').at(-1)
    expect(JSON.stringify(checked)).toContain('1 tests, exit 0')
    await writeFile(evaluator, testSource)
    expect((await deliver('required tested content', true))?.outcome.state).toBe('needs_attention')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(3)
    await writeFile(evaluator, testSource.replace('self.assertIn', 'self.assertNotIn'))
    await deliver('required tested content')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(3)
    await deliver('changed invalid')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(3)
    expect(await readFile(path, 'utf8')).toBe('changed invalid')
    await writeFile(evaluator, testSource)
    expect((await deliver('required tested content', false, true))?.outcome.state).toBe('needs_attention')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call').at(-1)?.data).toMatchObject({ name: 'read' })
    expect(agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(4)
    let restoreRead: (() => void) | undefined
    beforeSettlement = async () => {
      const { FsError } = requireBuilt('@deepseek-ai/dsh-fs') as typeof import('@deepseek-ai/dsh-fs')
      const deniedRead = vi.spyOn(ctx.fs, 'readBytes')
        .mockRejectedValue(new FsError('Read permission withdrawn', 'FS_PERMISSION_DENIED'))
      restoreRead = () => { deniedRead.mockRestore() }
    }
    let revoked: Awaited<ReturnType<typeof deliver>>
    try { revoked = await deliver('required tested content', false, false, true) } finally {
      restoreRead?.()
      beforeSettlement = undefined
    }
    expect(revoked?.outcome.state).toBe('needs_attention')
    if (revoked?.outcome.state !== 'needs_attention') throw new Error('Denied final read unexpectedly accepted')
    expect(revoked.outcome.reason).toContain('artifact or evaluator versions are unverified or changed')
    expect(revoked?.knowledge).toMatchObject([{ collection: 'manual', version: 1, sources: [{ id: 'policy' }] }])
    finalInputTokens = 2
    expect((await deliver('required tested content', false, false, false, true))?.outcome.state).toBe('needs_attention')
    const teams = ctx.get('agentTeams')
    if (teams === undefined) throw new Error('Native team service is unavailable')
    await teams.setEnabled(agent, true)
    const work = await teams.createTask(agent, { subject: 'Check result', description: 'Required native work order' })
    expect((await deliver('required tested content'))?.outcome.state).toBe('needs_attention')
    const claimed = await teams.updateTask(agent, { taskId: work.id, expectedRevision: work.revision, action: 'claim' })
    await teams.setEnabled(agent, false)
    expect((await deliver('required tested content'))?.outcome.state).toBe('needs_attention')
    await teams.setEnabled(agent, true)
    const completedWork = await teams.updateTask(agent, { taskId: work.id, expectedRevision: claimed.revision, action: 'complete' })
    expect((await deliver('required tested content'))?.outcome.state).toBe('completed')
    beforeSettlement = async () => {
      await teams.updateTask(agent, { taskId: work.id, expectedRevision: completedWork.revision, action: 'edit',
        description: 'Changed requirement after acceptance' })
    }
    expect((await deliver('required tested content'))?.outcome.state).toBe('needs_attention')
    beforeSettlement = undefined
    expect((await deliver('required tested content'))?.outcome.state).toBe('completed')
    const removed = await teams.createTask(agent, { subject: 'Required review', description: 'Must not disappear at settlement' })
    beforeSettlement = async () => {
      await teams.updateTask(agent, { taskId: removed.id, expectedRevision: removed.revision, action: 'delete' })
    }
    finalInputTokens = 2
    const deletedWork = await deliver('required tested content')
    expect(deletedWork?.outcome.state).toBe('needs_attention')
    expect(deletedWork?.workOrders).toContain(removed.id)
    beforeSettlement = undefined
    let childActivation: SubagentActivation | undefined
    afterBegin = async () => {
      childEntered = Promise.withResolvers<undefined>()
      childRelease = Promise.withResolvers<undefined>()
      childActivation = await ctx.subagents.startActivation({
        parent: agent, provider: 'spawn', label: 'Settlement child', delivery: 'caller',
        prompt: [{ type: 'text', text: 'Finish the isolated check.' }],
        agentOptions: { provider: 'settlement-child-fixture', model: 'fixture' },
        signal: new AbortController().signal,
      })
      const child = ctx.agents.get(childActivation.childId)
      if (child === undefined) throw new Error('Settlement child is unavailable')
      await childEntered.promise
      if (childPendingApproval) child.session.append('approval/asked', {
        id: ApprovalRequestId(`child-unsettled-${attempt}`), toolName: 'fixture',
      })
      if (beforeSettlement !== undefined) {
        childRelease.resolve(undefined)
        await childActivation.result
      }
    }
    try {
      expect((await deliver('required tested content'))?.outcome.state).toBe('needs_attention')
      childRelease.resolve(undefined)
      expect((await childActivation?.result)?.stopReason).toBe('completed')
      beforeSettlement = async () => {
        childRelease.resolve(undefined)
        expect((await childActivation?.result)?.stopReason).toBe('completed')
      }
      expect((await deliver('required tested content'))?.outcome.state).toBe('completed')
      childText = 'Unverified child assertion'
      expect((await deliver('required tested content'))?.outcome.state).toBe('needs_attention')
      childText = 'Independent child checked'
      expect(JSON.stringify(agent.session.snapshotEvents())).toContain('Independently tested child measurements SHA-256:')
      childText = 'x'.repeat(4097)
      expect((await deliver('required tested content'))?.outcome.state).toBe('needs_attention')
      childText = 'Independent child checked'
      childPendingApproval = true
      expect((await deliver('required tested content'))?.outcome.state).toBe('needs_attention')
    } finally {
      await childActivation?.dispose()
      afterBegin = undefined
      beforeSettlement = undefined
    }
    finalInputTokens = 101
    const commands = ctx.get('commands')
    if (commands === undefined) throw new Error('Native command registry is unavailable')
    const beforeCommand = attempt
    const criteria = await commands.execute(agent, '/task criteria', [], new AbortController().signal)
    expect(criteria?.result.kind).toBe('success')
    expect(criteria?.result.text).toContain('result.md')
    expect(criteria?.result.text).not.toContain(root)
    expect(attempt).toBe(beforeCommand)
    finalInputTokens = 2
    const unknownTool = ctx.tools.guard(exec => exec.name === 'read' ? {
      reason: 'The external effect outcome is unknown.',
      info: { name: 'ToolOutcomeUnknownError', code: 'TOOL_OUTCOME_UNKNOWN' },
    } : undefined)
    try {
      readBeforeDelivery = true
      expect((await deliver('required tested content'))?.outcome.state).toBe('needs_attention')
      expect(agent.session.snapshotEvents().filter(event => event.type === 'tool/call').at(-1)?.data.name).toBe('present')
      expect(JSON.stringify(agent.session.snapshotEvents())).toContain('TOOL_OUTCOME_UNKNOWN')
    } finally { unknownTool() }
    const registered = await commands.execute(agent, '/task new Deliver the result file.', [], new AbortController().signal)
    expect(registered?.result.kind).toBe('success')
    expect(attempt).toBe(beforeCommand + 2)
    const commandTask = registered?.result.text?.match(/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}/)?.[0]
    if (commandTask === undefined) throw new Error('Registered task identity is absent')
    finalInputTokens = 2
    const executed = await commands.execute(agent, `/task run ${commandTask}`, [], new AbortController().signal)
    expect(executed?.result).toMatchObject({ kind: 'success' })
    expect(ctx.get('lyagentTaskRuns')?.read(commandTask)?.outcome.state).toBe('completed')
    const repeated = await commands.execute(agent, `/task run ${commandTask}`, [], new AbortController().signal)
    expect(repeated?.result.kind).toBe('error')
    expect(attempt).toBe(beforeCommand + 4)
    const status = await commands.execute(agent, `/task status ${commandTask}`, [], new AbortController().signal)
    expect(status?.result.text).toContain('completed')
    const foreign = await commands.execute(agent, '/task status nonexistent-task', [], new AbortController().signal)
    expect(foreign?.result.kind).toBe('error')
    const queued = ctx.get('lyagentTaskRuns')
    if (queued === undefined) throw new Error('Task service disappeared')
    await queued.register('cancel-command-task', agent, 'Do not execute this task')
    const cancelled = await commands.execute(agent, '/task cancel cancel-command-task', [], new AbortController().signal)
    expect(cancelled?.result.text).toContain('cancelled')
    expect(queued.read('cancel-command-task')?.outcome.state).toBe('cancelled')
    expect(attempt).toBe(beforeCommand + 4)
    const foreignHandle = await ctx.agents.create({ sessionId: SessionId('other-owner'), meta: { cwd: scaffold.workspaceCwd } })
    try {
      await queued.register('foreign-command-task', foreignHandle.agent, 'Foreign conversation task')
      const listed = await commands.execute(agent, '/task list', [], new AbortController().signal)
      expect(listed?.result.kind).toBe('success')
      expect(listed?.result.text).toContain('cancel-command-task')
      expect(listed?.result.text).not.toContain('foreign-command-task')
      const foreignTask = await commands.execute(agent, '/task status foreign-command-task', [], new AbortController().signal)
      expect(foreignTask?.result.kind).toBe('error')
    } finally { await foreignHandle.dispose() }
    finalInputTokens = 101
    const failedId = `task-${attempt}`
    const overBudget = await deliver('required tested content')
    const dependent = await teams.createTask(agent, { subject: 'Dependent review', description: 'Depends on corrected work', blockedBy: [work.id] })
    const independent = await teams.createTask(agent, { subject: 'Independent review', description: 'Must remain unchanged' })
    for (const task of [dependent, independent]) {
      const owned = await teams.updateTask(agent, { taskId: task.id, expectedRevision: task.revision, action: 'claim' })
      await teams.updateTask(agent, { taskId: task.id, expectedRevision: owned.revision, action: 'complete' })
    }
    const preserved = teams.getTask(agent, independent.id)
    if (overBudget === undefined) throw new Error('Missing failed run')
    expect(queued.read(failedId)).toEqual(overBudget)
    const repaired = await commands.execute(agent, `/task repair ${failedId} ${work.id}`, [], new AbortController().signal)
    expect(repaired?.result).toMatchObject({ kind: 'success' })
    expect(repaired?.result.text).toContain(`${work.id}, ${dependent.id}`)
    expect(teams.getTask(agent, work.id).status).toBe('pending')
    expect(teams.getTask(agent, dependent.id).status).toBe('pending')
    expect(teams.getTask(agent, independent.id)).toEqual(preserved)
    expect(queued.read(failedId)?.repairs).toEqual([{ target: work.id, affected: [work.id, dependent.id],
      preserved: [{ id: independent.id, revision: preserved.revision }] }])
    finalInputTokens = 2
    let corrected = false
    const correctWork = agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (!corrected) {
        corrected = true
        for (const task of [work, dependent]) {
          const current = teams.getTask(agent, task.id)
          const owned = await teams.updateTask(agent, { taskId: task.id, expectedRevision: current.revision, action: 'claim' })
          await teams.updateTask(agent, { taskId: task.id, expectedRevision: owned.revision, action: 'complete' })
        }
      }
      return decision
    })
    try {
      await queued.execute(failedId, agent, new AbortController().signal)
    } catch (error) {
      throw new Error(JSON.stringify(agent.session.snapshotEvents().slice(-12)), { cause: error })
    } finally { correctWork() }
    expect(queued.read(failedId)?.outcome.state).toBe('completed')
    expect(teams.getTask(agent, independent.id)).toEqual(preserved)
    expect(JSON.stringify(agent.session.snapshotEvents())).toContain(`Local repair scope: ${work.id}, ${dependent.id}.`)
    expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('completed')
    expect(overBudget?.outcome.state).toBe('needs_attention')
    finalInputTokens = 101
    const changedRepairId = `task-${attempt}`
    await deliver('required tested content')
    await queued.repair(changedRepairId, agent, work.id)
    finalInputTokens = 2
    let changedIndependent = false
    const changeIndependent = agent.ctx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      if (!changedIndependent) {
        changedIndependent = true
        for (const task of [work, dependent]) {
          const current = teams.getTask(agent, task.id)
          const owned = await teams.updateTask(agent, { taskId: task.id, expectedRevision: current.revision, action: 'claim' })
          await teams.updateTask(agent, { taskId: task.id, expectedRevision: owned.revision, action: 'complete' })
        }
        const current = teams.getTask(agent, independent.id)
        await teams.updateTask(agent, { taskId: independent.id, expectedRevision: current.revision,
          action: 'edit', description: 'Unexpected modification during local repair' })
      }
      return decision
    })
    try { await queued.execute(changedRepairId, agent, new AbortController().signal) } finally { changeIndependent() }
    expect(queued.read(changedRepairId)?.outcome.state).toBe('needs_attention')
    class RepairAdapter extends LlmAdapter {
      private calls = 0
      override async *stream(): AsyncIterable<StreamChunk> {
        const id = ToolCallId(`bounded-repair-${++this.calls}`)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'present', arguments: JSON.stringify({ files: [{ path }] }) } }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    ctx.llm.registerAdapter(['bounded-repair-fixture'], new RepairAdapter())
    const repairHandle = await ctx.agents.create({ sessionId: SessionId('bounded-repair-parent'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'bounded-repair-fixture', model: 'fixture' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined) })
    try {
      await writeFile(path, 'invalid')
      await queued.register('bounded-repair-task', repairHandle.agent, 'Deliver the required result')
      await queued.execute('bounded-repair-task', repairHandle.agent, new AbortController().signal)
      expect(queued.read('bounded-repair-task')?.outcome.state).not.toBe('completed')
      expect(repairHandle.agent.session.snapshotEvents().filter(event => event.type === 'tool/call')).toHaveLength(4)
      expect(JSON.stringify(repairHandle.agent.session.snapshotEvents())).toContain('exhausted its configured local repair checks')
    } finally { await repairHandle.dispose() }
    await writeFile(path, 'required tested content')
    finalInputTokens = 2
    omitFinalUsage = true
    const unknownBudget = await deliver('required tested content')
    expect(unknownBudget?.outcome.state).toBe('needs_attention')
    expect(agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented')).toHaveLength(20)
    expect(JSON.stringify(agent.session.snapshotEvents())).toContain('LYAGENT_USAGE_UNKNOWN')
    await ctx.sessionPersistence.flush()
    const stored = await ctx.sessionPersistence.open(agent.id, 'read')
    try {
      const persisted = await stored.read()
      expect(persisted.events.filter(event => event.type === 'deliverables/presented')).toHaveLength(20)
      expect(JSON.stringify(persisted.events)).toContain('1 tests, exit 0')
      expect(JSON.stringify(persisted.events)).toContain(createHash('sha256').update(testSource).digest('hex'))
      expect(JSON.stringify(persisted.events)).toContain('LYAGENT_ARTIFACT_REJECTED')
    } finally { await stored.close() }
    const taskPlugin = [...ctx.loader.entries()].find(value => value.options.id === 'lyagent-artifact-check')
    const cancelling = await ctx.agents.create({ sessionId: SessionId('command-cancel-active'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'artifact-fixture', model: 'fixture' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined) })
    const cancelEntered = Promise.withResolvers<undefined>()
    const holdCancel = cancelling.agent.ctx.on('agent/pre-step', async ({ signal }, next) => {
      const decision = await next()
      cancelEntered.resolve(undefined)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      return decision
    }, { prepend: true })
    try {
      await queued.register('active-command-cancel', cancelling.agent, 'Cancel before dispatch')
      const execution = commands.execute(cancelling.agent, '/task run active-command-cancel', [], new AbortController().signal)
      const observed = execution.then(value => value, (error: unknown) => ({ failure: String(error) }))
      await cancelEntered.promise
      const cancellation = await commands.execute(cancelling.agent, '/task cancel active-command-cancel', [], new AbortController().signal)
      expect(cancellation?.result.kind).toBe('success')
      const executionResult = await observed
      expect(executionResult).toHaveProperty('result.kind', 'success')
      expect(executionResult).toHaveProperty('result.text')
      expect(JSON.stringify(executionResult)).toContain('cancelled')
      expect(queued.read('active-command-cancel')?.outcome.state).toBe('cancelled')
      expect(cancelling.agent.status).toBe('idle')
      expect(cancelling.agent.session.snapshotEvents().filter(event => event.type === 'request/header')).toHaveLength(0)
    } finally { holdCancel(); await cancelling.dispose() }
    if (taskPlugin?.fiber === undefined) throw new Error('Task plugin fiber is unavailable')
    const closing = await ctx.agents.create({ sessionId: SessionId('closing-task-parent'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'artifact-fixture', model: 'fixture' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined) })
    const closeEntered = Promise.withResolvers<undefined>()
    await queued.register('criteria-stale-task', agent, 'Keep the registered acceptance requirements')
    const holdClose = closing.agent.ctx.on('agent/pre-step', async ({ signal }, next) => {
      const decision = await next()
      closeEntered.resolve(undefined)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      return decision
    }, { prepend: true })
    try {
      await queued.register('closing-task', closing.agent, 'Stop this active task during runtime unload')
      const execution = queued.execute('closing-task', closing.agent, new AbortController().signal)
      const observed = execution.then(() => 'settled', () => 'rejected')
      await closeEntered.promise
      await taskPlugin.fiber.dispose()
      expect(await observed).toBe('settled')
      expect(closing.agent.status).toBe('idle')
      expect(() => queued.read('closing-task')).toThrow('closed')
    } finally { holdClose(); await closing.dispose() }
    expect(ctx.get('lyagentTaskRuns')).toBeUndefined()
    expect(await commands.execute(agent, '/task status nonexistent-task', [], new AbortController().signal)).toBeUndefined()
    await taskPlugin.update({ disabled: true })
    await taskPlugin.update({ disabled: false, config: {
      artifacts: [{ path: 'result.md', minBytes: 1, maxBytes: 129, includes: ['required'] }],
      taskRuns: true, maxRepairs: 2, tests: { python, root, files: [{
        path: 'test_artifact.py', sha256: createHash('sha256').update(testSource).digest('hex'),
      }], minTests: 1, timeoutMs: 15000, maxChildResultBytes: 4096 },
    } })
    await ctx.loader.await()
    const reconfigured = ctx.get('lyagentTaskRuns')
    if (reconfigured === undefined) throw new Error('Reconfigured task runtime is unavailable')
    const beforeReconfigured = attempt
    await expect(reconfigured.execute('criteria-stale-task', agent, new AbortController().signal))
      .rejects.toThrow('Acceptance criteria changed')
    expect(attempt).toBe(beforeReconfigured)
    expect(reconfigured.read('criteria-stale-task')?.outcome.state).toBe('queued')
  } finally {
    try { await handle?.dispose() } finally {
      try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
})

it('rechecks a hash-bound model edit after native approval and preserves the competing file', async () => {
  const scaffold = await launchWebScaffold({ extraOverlayPath:
    fileURLToPath(new URL('../../../lyagent-orchestration.overlay.yml', import.meta.url)) })
  const ctx = scaffold.ctx
  const path = join(scaffold.workspaceCwd, 'approved-hash.txt')
  const baseline = 'original\nunchanged\n'
  const args = { file_path: path, old_string: 'original', new_string: 'accepted',
    expected_sha256: createHash('sha256').update(baseline).digest('hex') }
  let calls = 0
  let approvals = 0
  class EditAdapter extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      if (calls++ === 0) {
        const id = ToolCallId('approved-hash-edit')
        const argumentsJson = JSON.stringify(args)
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'tool-call-delta', index: 0, id, name: 'edit', argumentsDelta: argumentsJson }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'edit', arguments: argumentsJson } }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      } else {
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }
  }
  ctx.llm.registerAdapter(['hash-fixture'], new EditAdapter())
  const handle = await ctx.agents.create({
    sessionId: SessionId('hash-approval-parent'), meta: { cwd: scaffold.workspaceCwd },
    agentOptions: { provider: 'hash-fixture', model: 'fixture' },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
  })
  const stopAsk = ctx.on('tools/pre-execute', async (exec, next) => exec.agent === handle.agent && exec.name === 'edit'
    ? { kind: 'ask' as const, reason: 'Approve the exact hash-bound edit.' } : next(), { prepend: true })
  const stopAnswer = ctx.on('approval/request', async (request, next) => {
    if (request.agent !== handle.agent) return next()
    approvals++
    expect(request.callId).toBe('approved-hash-edit')
    await writeFile(path, 'original\nexternal during approval\n')
    return 'allowed-once' as const
  }, { prepend: true })
  try {
    await writeFile(path, baseline)
    const digest = await executeToolFixture(ctx, { agent: handle.agent, name: 'read_digest',
      callId: ToolCallId('root-digest'), arguments: { file_path: path }, signal: new AbortController().signal })
    expect(digest.isError).toBe(false)
    expect(digest.content).toContainEqual({ type: 'text', text: `${path}\nSHA-256: ${args.expected_sha256}` })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Apply the reviewed change.' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    expect(approvals).toBe(1)
    const events = handle.agent.session.snapshotEvents()
    expect(events.find(event => event.type === 'tool/call')?.data).toBeDefined()
    expect(events.find(event => event.type === 'approval/decided')?.data).toMatchObject({ outcome: 'allowed-once' })
    expect(events.find(event => event.type === 'tool/result')?.data).toMatchObject({
      message: { isError: true }, error: { code: 'FS_STALE_VERSION' },
    })
    expect(await readFile(path, 'utf8')).toBe('original\nexternal during approval\n')
  } finally {
    stopAnswer()
    stopAsk()
    try { await handle.dispose() } finally { await scaffold.close() }
  }
})

it('accepts a schema-validated child proposal without granting file mutation', async () => {

  const root = await mkdtemp(join(tmpdir(), 'lyagent-structured-'))
  const override = join(root, 'replay.override.json')
  const proposal = { path: 'target.txt', expected: 'original', replacement: 'reviewed' }
  const args = JSON.stringify(proposal)
  const id = ToolCallId('structured-proposal')
  const replay: ReplayOverrideDoc = [{ kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: ToolCallId('invalid-proposal'), name: 'structured_output', argumentsDelta: '{}' },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId('invalid-proposal'), name: 'structured_output', arguments: '{}' } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] }, { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: 'structured_output', argumentsDelta: args },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'structured_output', arguments: args } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: 3 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ] }]
  await writeFile(override, JSON.stringify(replay))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let parentHandle: Awaited<ReturnType<NonNullable<typeof scaffold>['ctx']['agents']['create']>> | undefined
  let activation: SubagentActivation | undefined
  try {
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('../../../lyagent-orchestration.overlay.yml', import.meta.url)),
      replayFixture: join(root, 'authored.jsonl'), replayOverride: override, compareReplaySession: false,
    })
    const ctx = scaffold.ctx
    const target = join(scaffold.workspaceCwd, 'target.txt')
    await writeFile(target, 'original')
    parentHandle = await ctx.agents.create({
      sessionId: SessionId('structured-parent'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    activation = await ctx.subagents.startActivation({
      parent: parentHandle.agent, provider: 'spawn', label: 'Structured proposal', delivery: 'caller',
      prompt: [{ type: 'text', text: 'Return a structured proposal without writing files.' }],
      signal: new AbortController().signal,
      outputSchema: { type: 'object', properties: {
        path: { type: 'string' }, expected: { type: 'string' }, replacement: { type: 'string' },
      }, required: ['path', 'expected', 'replacement'], additionalProperties: false },
    })
    const child = ctx.agents.get(activation.childId)
    if (child === undefined) throw new Error('Structured child is unavailable')
    await child.whenIdle()
    const results = child.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(2)
    expect(results[0]!.data).toMatchObject({ message: { isError: true }, error: { code: 'INVALID_ARGS' } })
    expect(results[1]!.data.message.isError).not.toBe(true)
    await activation.dispose()
    const result = await activation.result
    expect(result.structured).toEqual(proposal)
    expect(result.stopReason).toBe('completed')
    expect(await readFile(target, 'utf8')).toBe('original')
    ctx.permissionPresets.set(parentHandle.agent.session, 'danger-full-access')
    const edit = (call: string) => executeToolFixture(ctx, {
      agent: parentHandle!.agent, name: 'edit', callId: ToolCallId(call),
      arguments: { file_path: target, old_string: proposal.expected, new_string: proposal.replacement,
        expected_sha256: createHash('sha256').update('original').digest('hex') },
      signal: new AbortController().signal,
    })
    await writeFile(target, 'original with external changes outside the matched text')
    expect((await edit('stale-proposal')).isError).toBe(true)
    expect(await readFile(target, 'utf8')).toBe('original with external changes outside the matched text')
    await writeFile(target, 'original')
    expect((await edit('reviewed-proposal')).isError).not.toBe(true)
    expect(await readFile(target, 'utf8')).toBe('reviewed')
  } finally {
    try { await activation?.dispose() } finally {
      try { await parentHandle?.dispose() } finally {
        try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  }
})

it('cancels accepted child work with its root turn and permits a later root turn', async () => {
  const scaffold = await launchWebScaffold({ extraOverlayPath:
    fileURLToPath(new URL('../../../lyagent-orchestration.overlay.yml', import.meta.url)) })
  const ctx = scaffold.ctx
  expect([...ctx.loader.entries()].find(value => value.options.id === 'lyagent-cancel-tree')?.fiber).toBeDefined()
  const entered = Promise.withResolvers<undefined>()
  const childEntered = Promise.withResolvers<AbortSignal>()
  let hold = true
  class CancellationAdapter extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      if (hold) {
        const signal = options.signal
        if (signal === undefined) throw new Error('Missing child operation signal')
        childEntered.resolve(signal)
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
        signal.throwIfAborted()
      }
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  ctx.llm.registerAdapter(['cancellation-fixture'], new CancellationAdapter())
  const parentHandle = await ctx.agents.create({
    sessionId: SessionId('cancel-parent'), meta: { cwd: scaffold.workspaceCwd },
    agentOptions: { provider: 'cancellation-fixture', model: 'fixture' },
    setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
  })
  const parent = parentHandle.agent
  const disposeHold = ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (agent === parent && hold) {
      entered.resolve(undefined)
      await new Promise<void>((resolve) => {
        if (signal.aborted) resolve()
        else signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
    }
    return next()
  })
  const activations: SubagentActivation[] = []
  try {
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Start isolated cancellation task' }], source: { kind: 'user' } }))
    await entered.promise
    const start = () => ctx.subagents.startActivation({
      parent, provider: 'spawn', label: 'Cancellation child', delivery: 'caller' as const,
      prompt: [{ type: 'text' as const, text: 'Wait for cancellation' }], signal: new AbortController().signal,
    })
    const first = await start()
    activations.push(first)
    const childSignal = await childEntered.promise
    parent.cancel({ kind: 'user' })
    expect(childSignal.aborted).toBe(true)
    await parent.whenIdle()
    const child = ctx.agents.get(first.childId)
    if (child === undefined) throw new Error('Accepted child disappeared before inspection')
    await child.whenIdle()
    expect(child.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('aborted')
    const prepared = await new ToolExecutionPipeline(ctx).prepare({
      callId: ToolCallId('cancelled-child-read'), name: 'read', agent: child,
      arguments: {}, signal: new AbortController().signal,
    })
    expect(ctx.tools.checkGuards(prepared.exec)?.info?.code).toBe('LYAGENT_PARENT_STOPPED')
    await first.dispose()
    expect((await first.result).stopReason).toBe('aborted')
    hold = false
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'Start a new task after cancellation' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    const second = await start()
    activations.push(second)
    await ctx.agents.get(second.childId)?.whenIdle()
    await second.dispose()
    expect((await second.result).stopReason).toBe('completed')
    const entry = [...ctx.loader.entries()].find(value => value.options.id === 'lyagent-cancel-tree')
    if (entry?.fiber === undefined) throw new Error('Cancellation plugin is not mounted')
    await entry.fiber.dispose()
    expect(ctx.tools.checkGuards(prepared.exec)).toBeUndefined()
  } finally {
    disposeHold()
    parent.cancel({ kind: 'user' })
    try { for (const activation of activations) await activation.dispose() } finally {
      try { await parentHandle.dispose() } finally { await scaffold.close() }
    }
  }
})

it('keeps a real spawned child read-only and returns its proposal before the parent commits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-delegation-'))
  const override = join(root, 'replay.override.json')
  const tool = (id: string, name: string, args: Record<string, string>): { kind: 'chunks'; chunks: StreamChunk[] } => {
    const callId = ToolCallId(id)
    const argumentsJson = JSON.stringify(args)
    return { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
      { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ] }
  }
  const replay: ReplayOverrideDoc = [
    tool('delegated-read', 'read', { file_path: 'proposal-target.txt' }),
    tool('delegated-write', 'write', { file_path: 'proposal-target.txt', content: 'child bypass\n' }),
    { kind: 'chunks', chunks: [
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'PROPOSAL: parent should replace original with accepted.' },
      { type: 'block-end', index: 0, block: { type: 'text', text: 'PROPOSAL: parent should replace original with accepted.' } },
      { type: 'usage', usage: { inputTokens: 8, outputTokens: 4 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ] },
  ]
  await writeFile(override, JSON.stringify(replay))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let parentHandle: Awaited<ReturnType<NonNullable<typeof scaffold>['ctx']['agents']['create']>> | undefined
  let activation: SubagentActivation | undefined
  try {
    scaffold = await launchWebScaffold({
      extraOverlayPath: fileURLToPath(new URL('../../../lyagent-orchestration.overlay.yml', import.meta.url)),
      replayFixture: join(root, 'authored.jsonl'), replayOverride: override, compareReplaySession: false,
    })
    const ctx = scaffold.ctx
    const target = join(scaffold.workspaceCwd, 'proposal-target.txt')
    await writeFile(target, 'original\n')
    parentHandle = await ctx.agents.create({
      sessionId: SessionId('delegation-parent'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    })
    const parent = parentHandle.agent
    ctx.permissionPresets.set(parent.session, 'danger-full-access')
    activation = await ctx.subagents.startActivation({
      parent, provider: 'spawn', label: 'Review isolated file', delivery: 'caller',
      prompt: [{ type: 'text', text: 'Read proposal-target.txt and propose a change without committing it.' }],
      signal: new AbortController().signal,
    })
    const child = ctx.agents.get(activation.childId)
    if (child === undefined) throw new Error('Spawned child is unavailable')
    await child.whenIdle()
    expect(child.session.header).toMatchObject({ origin: 'subagent', delegationDepth: 1 })
    const results = child.session.snapshotEvents().filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(2)
    expect(results[0]!.data.message.isError).not.toBe(true)
    expect(results[1]!.data).toMatchObject({ message: { isError: true }, error: { code: 'LYAGENT_PARENT_WRITE_REQUIRED' } })
    expect(await readFile(target, 'utf8')).toBe('original\n')
    await activation.dispose()
    const result = await activation.result
    expect(result.output.some(block => block.type === 'text' && block.text.includes('PROPOSAL:'))).toBe(true)
    const committed = await executeToolFixture(ctx, {
      agent: parent, callId: ToolCallId('reviewed-parent-write'), name: 'write',
      arguments: { file_path: target, content: 'accepted\n' }, signal: new AbortController().signal,
    })
    expect(committed.isError).not.toBe(true)
    expect(await readFile(target, 'utf8')).toBe('accepted\n')
  } finally {
    try { await activation?.dispose() } finally {
      try { await parentHandle?.dispose() } finally {
        try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  }
})

it('denies child writes after an allow listener and permits reads and parent writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-single-writer-'))
  const scaffold = await launchWebScaffold({ extraOverlayPath: [
    fileURLToPath(new URL('../../../lyagent-orchestration.overlay.yml', import.meta.url)),
  ] })
  const ctx = scaffold.ctx
  const target = join(scaffold.workspaceCwd, 'policy-target.txt')
  await writeFile(target, 'original\n')
  const handles = []
  try {
    for (const child of [false, true]) handles.push(await ctx.agents.create({
      sessionId: SessionId(child ? 'single-writer-child' : 'single-writer-parent'),
      meta: { cwd: scaffold.workspaceCwd, ...(child ? { origin: 'subagent', parentSession: SessionId('single-writer-parent'), delegationDepth: 1 } : {}) },
      setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined),
    }))
    const parent = handles[0]!.agent
    const child = handles[1]!.agent
    ctx.permissionPresets.set(parent.session, 'danger-full-access')
    ctx.permissionPresets.set(child.session, 'danger-full-access')
    const disposeAllow = ctx.on('tools/pre-execute', async () => ({ kind: 'allow' as const }), { prepend: true })
    try {
      const denied = await executeToolFixture(ctx, {
        callId: ToolCallId('child-write'), name: 'write', agent: child,
        signal: new AbortController().signal, arguments: { file_path: target, content: 'forbidden\n' },
      })
      expect(denied).toMatchObject({ isError: true, error: { info: { code: 'LYAGENT_PARENT_WRITE_REQUIRED' } } })
      expect(await readFile(target, 'utf8')).toBe('original\n')
      const read = await executeToolFixture(ctx, {
        callId: ToolCallId('child-read'), name: 'read', agent: child,
        signal: new AbortController().signal, arguments: { file_path: target },
      })
      expect(read.isError).toBe(false)
      const written = await executeToolFixture(ctx, {
        callId: ToolCallId('parent-write'), name: 'write', agent: parent,
        signal: new AbortController().signal, arguments: { file_path: target, content: 'parent committed\n' },
      })
      expect(written.isError).toBe(false)
      expect(await readFile(target, 'utf8')).toBe('parent committed\n')
      for (const name of ['pwsh', 'bash', 'run_code', 'mcp_unreviewed']) {
        const prepared = await new ToolExecutionPipeline(ctx).prepare({
          callId: ToolCallId(`child-${name}`), name, agent: child,
          arguments: {}, signal: new AbortController().signal,
        })
        expect(ctx.tools.checkGuards(prepared.exec)?.info?.code).toBe('LYAGENT_PARENT_WRITE_REQUIRED')
      }
      const entry = [...ctx.loader.entries()].find(value => value.options.id === 'lyagent-single-writer')
      if (entry?.fiber === undefined) throw new Error('Single-writer Loader fiber is unavailable')
      await entry.fiber.dispose()
      const afterDisposal = await new ToolExecutionPipeline(ctx).prepare({
        callId: ToolCallId('after-disposal'), name: 'write', agent: child,
        arguments: {}, signal: new AbortController().signal,
      })
      expect(ctx.tools.checkGuards(afterDisposal.exec)).toBeUndefined()
    } finally { disposeAllow() }
  } finally {
    try { for (const handle of handles.reverse()) await handle.dispose() } finally {
      try { await scaffold.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
})
