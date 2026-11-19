/** Heterogeneous task runs through native Loader, file tools and pinned independent tests. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-lyagent-artifact-acceptance'
import { launchWebScaffold } from './scaffold.ts'

const scenarios = [
  {
    name: 'materials', input: 'policy.txt', output: 'brief.md',
    source: 'Policy A: delivery is Friday.\nPolicy B: delivery is Monday.\n',
    artifact: '# Delivery brief\n\nPolicy A says Friday [policy.txt:1].\nPolicy B says Monday [policy.txt:2].\nConflict unresolved; request the authoritative edition.\n',
    markers: ['Conflict unresolved', '[policy.txt:1]', '[policy.txt:2]'],
    evaluator: `import pathlib, unittest
class MaterialTest(unittest.TestCase):
 def test_conflicting_sources(self):
  self.assertEqual(len(LYAGENT_CHILD_RESULTS), 2)
  self.assertTrue(all(c['output'] == [{'type': 'text', 'text': 'Source reviewed independently'}] for c in LYAGENT_CHILD_RESULTS))
  source = pathlib.Path('policy.txt').read_text(encoding='utf-8').splitlines()
  result = pathlib.Path('brief.md').read_text(encoding='utf-8')
  self.assertEqual(source, ['Policy A: delivery is Friday.', 'Policy B: delivery is Monday.'])
  self.assertIn('Friday [policy.txt:1]', result)
  self.assertIn('Monday [policy.txt:2]', result)
  self.assertIn('Conflict unresolved', result)
`,
  },
  {
    name: 'python-maintenance', input: 'totals.py', output: 'totals.py',
    source: 'def total(values):\n    return len(values)\n',
    artifact: 'def total(values):\n    return sum(values)\n',
    markers: ['def total(values):', 'return sum(values)'],
    evaluator: `import pathlib, unittest
class TotalTest(unittest.TestCase):
 def test_total(self):
  self.assertEqual(len(LYAGENT_CHILD_RESULTS), 2)
  self.assertTrue(all(c['output'] == [{'type': 'text', 'text': 'Source reviewed independently'}] for c in LYAGENT_CHILD_RESULTS))
  namespace = {}
  exec(compile(pathlib.Path('totals.py').read_text(encoding='utf-8'), 'totals.py', 'exec'), namespace)
  total = namespace['total']
  self.assertEqual(total([]), 0)
  self.assertEqual(total([3, -2, 8]), 9)
  self.assertEqual(total([1.5, 2.25]), 3.75)
`,
  },
]

for (const scenario of scenarios) {
  it(`settles an independently tested ${scenario.name} business run using real native tools`, async () => {
    const root = await mkdtemp(join(tmpdir(), `lyagent-business-${scenario.name}-`))
    let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
    let handle: Awaited<ReturnType<NonNullable<typeof scaffold>['ctx']['agents']['create']>> | undefined
    try {
      const evaluator = 'test_business.py'
      await writeFile(join(root, evaluator), scenario.evaluator)
      const python = execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
      const overlay = join(root, 'business.yml')
      await writeFile(overlay, JSON.stringify([{ id: 'llm-retry', disabled: true }, { insert: [
        { id: 'lyagent-single-writer', name: '@deepseek-ai/dsh-lyagent-single-writer',
          config: { childReadOnlyTools: ['read', 'read_digest', 'glob', 'grep', 'structured_output'] } },
        { id: 'lyagent-budget', name: '@deepseek-ai/dsh-lyagent-budget', config: {
          batchId: `keyless-business-${scenario.name}`, maxRequests: 24, maxTokens: 1000, reservationTokens: 10,
          maxConcurrent: 2, runLimits: { maxRequests: 16, maxTokens: 500, childMaxRequests: 2, childMaxTokens: 50 },
        } },
        { id: 'lyagent-artifact-check', name: '@deepseek-ai/dsh-lyagent-artifact-acceptance', config: {
          taskRuns: true, maxRepairs: 1,
          artifacts: [{ path: scenario.output, minBytes: 1, maxBytes: 4096, includes: scenario.markers }],
          tests: { python, root, files: [{ path: evaluator, sha256: createHash('sha256').update(scenario.evaluator).digest('hex') }],
            minTests: 1, timeoutMs: 15000, maxChildResultBytes: 8192 },
        } },
      ] }]))
      scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
      const ctx = scaffold.ctx
      const input = join(scaffold.workspaceCwd, scenario.input)
      const output = join(scaffold.workspaceCwd, scenario.output)
      const untouched = join(scaffold.workspaceCwd, 'untouched.txt')
      await writeFile(input, scenario.source)
      await writeFile(untouched, 'protected fixture\n')
      let entered = 0
      const bothEntered = Promise.withResolvers<undefined>()
      const childSteps = new Map<string, number>()
      class ReviewAdapter extends LlmAdapter {
        override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          const key = options.sessionId ?? ''
          const step = childSteps.get(key) ?? 0
          childSteps.set(key, step + 1)
          if (step === 0) {
            if (++entered === 2) bothEntered.resolve(undefined)
            await Promise.race([bothEntered.promise, new Promise<void>((resolve) => {
              if (options.signal?.aborted) resolve()
              else options.signal?.addEventListener('abort', () => { resolve() }, { once: true })
            })])
            options.signal?.throwIfAborted()
            const id = ToolCallId(`review-${key}`)
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: 'read',
              arguments: JSON.stringify({ file_path: input }) } }
          } else {
            yield { type: 'block-start', index: 0, blockType: 'text' }
            yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Source reviewed independently' } }
          }
          yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
          yield { type: 'finish', reason: { kind: step === 0 ? 'tool-calls' : 'stop' } }
        }
      }
      class BusinessAdapter extends LlmAdapter {
        private step = 0
        private request = 0
        private readonly review = new ReviewAdapter()
        override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          if (options.sessionId !== SessionId(`business-${scenario.name}`)) {
            yield* this.review.stream(options)
            return
          }
          const step = this.step
          const reviewsReady = new Set(options.messages.flatMap(message =>
            message.source?.kind === 'subagent-settled' ? [message.source.senderSessionId] : [])).size === 2
          const request = this.request++
          if (step !== 1 || reviewsReady) this.step++
          if (step === 0) {
            for (const [index, name] of ['source-review', 'independent-review'].entries()) {
              yield { type: 'block-start', index, blockType: 'tool-call' }
              yield { type: 'block-end', index, block: { type: 'tool-call',
                id: ToolCallId(`delegate-${scenario.name}-${index}`), name: 'subagent',
                arguments: JSON.stringify({ name, description: name,
                  prompt: `Read ${scenario.input} and report the source review.` }) } }
            }
            yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          const invocation = step === 1 && !reviewsReady ? { name: 'wait_agent', args: { timeout_ms: 10000 } }
            : step === 1 ? { name: 'read', args: { file_path: input } }
              : step === 2 ? { name: 'write', args: { file_path: output, content: scenario.artifact } }
                : step === 3 ? { name: 'team_task_create', args: { subject: 'Verify delivery',
                  description: 'Review both source reports and submit the independently tested artifact.' } }
                  : step === 4 || step === 5 ? { name: 'team_task_update', args: (() => {
                    const previous = options.messages.findLast(message => message.role === 'tool')
                    const text = previous?.content.find(block => block.type === 'text')?.text
                    const task: unknown = text === undefined ? undefined : JSON.parse(text)
                    if (task === null || typeof task !== 'object' || !('id' in task) || typeof task.id !== 'string'
                      || !('revision' in task) || typeof task.revision !== 'number') throw new Error('Missing task tool result')
                    return { task_id: task.id, expected_revision: task.revision, action: step === 4 ? 'claim' : 'complete' }
                  })() } : step === 6 ? { name: 'present', args: { files: [{ path: output }] } } : undefined
          if (invocation !== undefined) {
            const id = ToolCallId(`business-${scenario.name}-${request}`)
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id,
              name: invocation.name, arguments: JSON.stringify(invocation.args) } }
          }
          yield { type: 'usage', usage: { inputTokens: 3, outputTokens: 2 } }
          yield { type: 'finish', reason: { kind: invocation === undefined ? 'stop' : 'tool-calls' } }
        }
      }
      ctx.llm.registerAdapter(['keyless-business'], new BusinessAdapter())
      handle = await ctx.agents.create({ sessionId: SessionId(`business-${scenario.name}`),
        meta: { cwd: scaffold.workspaceCwd }, agentOptions: { provider: 'keyless-business', model: 'scripted' },
        setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined) })
      const agent = handle.agent
      ctx.permissionPresets.set(agent.session, 'danger-full-access')
      const team = ctx.get('agentTeams')
      if (team === undefined) throw new Error('Native task board is unavailable')
      await team.setEnabled(agent, true)
      const tasks = ctx.get('lyagentTaskRuns')
      if (tasks === undefined) throw new Error('Task runtime is unavailable')
      await tasks.register('business-task', agent, `Produce and independently verify the ${scenario.name} result.`)
      await tasks.execute('business-task', agent, new AbortController().signal)
      const toolResults = agent.session.snapshotEvents().filter(event => event.type === 'tool/result')
      expect(entered, JSON.stringify(toolResults)).toBe(2)
      expect([...childSteps.values()]).toEqual([2, 2])
      const run = tasks.read('business-task')
      expect(run?.outcome.state, JSON.stringify({ run, toolResults })).toBe('completed')
      if (run?.outcome.state !== 'completed') throw new Error(JSON.stringify(run))
      expect(run.outcome.evidence.tests).toBe(1)
      const budget = ctx.get('lyagentBudget')
      if (budget === undefined) throw new Error('Run budget is unavailable')
      const parentCalls = agent.session.snapshotEvents().filter(event => event.type === 'tool/call')
      const waits = parentCalls.filter(event => event.data.name === 'wait_agent').length
      expect(waits).toBeLessThanOrEqual(3)
      expect(new Set(parentCalls.map(event => event.data.callId)).size).toBe(parentCalls.length)
      expect(await budget.seal(`${agent.id}:${run.outcome.owner.turn}`))
        .toMatchObject({ requests: 12 + waits, tokens: (12 + waits) * 5, ready: true })
      expect(team.listTasks(agent)).toMatchObject([{ subject: 'Verify delivery', status: 'completed', ownerId: agent.id }])
      for (const childId of childSteps.keys()) {
        const childLog = await ctx.sessionPersistence.open(SessionId(childId), 'read')
        try {
          const events = (await childLog.read()).events
          expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name)).toEqual(['read'])
          expect(events.filter(event => event.type === 'tool/result').every(event => !event.data.message.isError)).toBe(true)
        } finally { await childLog.close() }
      }
      expect(run.outcome.evidence.artifacts).toEqual([{ path: output,
        sha256: createHash('sha256').update(scenario.artifact).digest('hex') }])
      expect(await readFile(output, 'utf8')).toBe(scenario.artifact)
      expect(await readFile(untouched, 'utf8')).toBe('protected fixture\n')
      if (scenario.input !== scenario.output) expect(await readFile(input, 'utf8')).toBe(scenario.source)
      await ctx.sessionPersistence.flush()
      const stored = await ctx.sessionPersistence.open(agent.id, 'read')
      try {
        const events = (await stored.read()).events
        expect(events.filter(event => event.type === 'tool/call').map(event => event.data.name).filter(name => name !== 'wait_agent'))
          .toEqual(['subagent', 'subagent', 'read', 'write', 'team_task_create', 'team_task_update', 'team_task_update', 'present'])
        expect(events.filter(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled')).toHaveLength(2)
        expect(events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'subagent-settled'
          ? [{ kind: event.data.source.kind, stopReason: event.data.source.stopReason,
            content: event.data.content.filter(block => block.type === 'text').map(block => block.text) }] : [])
          .sort((left, right) => (left.content[0] ?? '').localeCompare(right.content[0] ?? ''))).toMatchInlineSnapshot(`
            [
              {
                "content": [
                  "Background subagent independent-review finished and will do no further work unless you send it more.",
                  "Its closing message:",
                  "Source reviewed independently",
                ],
                "kind": "subagent-settled",
                "stopReason": "completed",
              },
              {
                "content": [
                  "Background subagent source-review finished and will do no further work unless you send it more.",
                  "Its closing message:",
                  "Source reviewed independently",
                ],
                "kind": "subagent-settled",
                "stopReason": "completed",
              },
            ]
          `)
        expect(events.filter(event => event.type === 'deliverables/presented')).toHaveLength(1)
        expect(events.filter(event => event.type === 'tool/result').every(event => !event.data.message.isError)).toBe(true)
        expect(JSON.stringify(events)).toContain(run.outcome.evidence.artifacts[0]?.sha256)
      } finally { await stored.close() }
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'No additional work.' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      expect(tasks.read('business-task')?.outcome.state).toBe('completed')
    } finally {
      try { await handle?.dispose() } finally {
        try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
      }
    }
  })
}
