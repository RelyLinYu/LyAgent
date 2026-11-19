/** Keyless acceptance: a failed run releases its board task and records why on the task itself. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-team'
import type {} from '@deepseek-ai/dsh-lyagent-knowledge'
import type {} from '@deepseek-ai/dsh-lyagent-workflow-library'
import { launchWebScaffold } from './scaffold.ts'

/** Answer every child with a fixed line, so the gate — not the dispatch — is what fails. */
class FixedTextAdapter extends LlmAdapter {
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    void options
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('releases the board task and writes the failure reason instead of leaving it silently pending', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-board-failure-'))
  const overlay = join(root, 'board.json')
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
    scaffold.ctx.llm.registerAdapter(['board-fixture'], new FixedTextAdapter())
    const ctx = scaffold.ctx
    const commands = ctx.get('commands')
    const library = ctx.get('lyagentWorkflowLibrary')
    if (commands === undefined || library === undefined) throw new Error('plugins missing')
    const owner = await ctx.agents.create({ sessionId: SessionId('board-owner'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'board-fixture', model: 'fixture' },
      setup: scope => scaffold?.ctx.agentPresets.mount(scope, 'standard').then(() => undefined) })
    created.push(owner)
    ctx.permissionPresets.set(owner.agent.session, 'danger-full-access')
    const agent = owner.agent
    await ctx.agentTeams.setEnabled(agent, true)
    const saved = (input: string) => commands.execute(agent, `/saved-workflow ${input}`, [], new AbortController().signal)

    expect((await saved(`publish-team ${JSON.stringify({ id: 'p-profile', expectedVersion: 0, definition: {
      kind: 'profile', description: 'Worker', instructions: 'Do it.', provider: 'board-fixture', model: 'fixture', enabled: true } })}`)).result.kind).toBe('success')
    expect((await saved(`publish-team ${JSON.stringify({ id: 'p-team', expectedVersion: 0, definition: {
      kind: 'team', description: 'Team', members: [{ role: 'worker', profile: { id: 'p-profile', version: 1 } }] } })}`)).result.kind).toBe('success')
    const plan = { id: 'failing', expectedVersion: 0, description: 'Always fails its gate', nodes: [
      { id: 'draft', kind: 'role', team: { id: 'p-team', version: 1 }, role: 'worker', prompt: 'Say done.',
        dependsOn: [], retry: 1 },
      { id: 'gate', kind: 'check', dependsOn: ['draft'], retry: 1, expect: { mustContain: ['SC-1007'] } },
    ] }
    expect((await saved(`publish-plan ${JSON.stringify(plan)}`)).result.kind).toBe('success')

    const run = await saved('run failing 1')
    expect(run.result.kind).toBe('error')
    const envelope = JSON.parse(String(run.result.text)) as { board: { task: string, transition: string } }
    expect(envelope.board.transition).toBe('released')

    // Released for a retry, but the reason stays visible on the task instead of vanishing with the run.
    await expect.poll(() => ctx.agentTeams.listTasks(agent).find(candidate => candidate.id === envelope.board.task)?.description)
      .toContain('missing required content')
    const task = ctx.agentTeams.listTasks(agent).find(candidate => candidate.id === envelope.board.task)
    expect(task?.status).toBe('pending')
    expect(task?.description).toContain('run failed:')
    // The board reader gets the reason, not the VM stack trace.
    expect(task?.description).not.toContain('at workflow:')
  } finally {
    for (const handle of created) await handle.dispose()
    try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
  }
}, 180000)
