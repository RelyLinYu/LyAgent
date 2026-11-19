/** Temporary probe: the replay rule must hold through the real publish-plan command. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-lyagent-knowledge'
import type {} from '@deepseek-ai/dsh-lyagent-workflow-library'
import { launchWebScaffold } from './scaffold.ts'

it('refuses to publish a retrying node that embeds a script without the failure-class marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-replay-probe-'))
  const overlay = join(root, 'replay.json')
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
    const commands = ctx.get('commands')
    const library = ctx.get('lyagentWorkflowLibrary')
    if (commands === undefined || library === undefined) throw new Error('plugins missing')
    const owner = await ctx.agents.create({ sessionId: SessionId('replay-owner'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'replay-fixture', model: 'fixture' },
      setup: scope => scaffold?.ctx.agentPresets.mount(scope, 'standard').then(() => undefined) })
    created.push(owner)
    ctx.permissionPresets.set(owner.agent.session, 'danger-full-access')
    const agent = owner.agent
    const saved = (input: string) => commands.execute(agent, `/saved-workflow ${input}`, [], new AbortController().signal)

    // A pre-marker script: no __stop( anywhere, exactly like the migrated flows.
    const legacy = { id: 'legacy', expectedVersion: 0, description: 'Legacy', script: 'const value = 1\nreturn value' }
    expect((await saved(`publish ${JSON.stringify(legacy)}`)).result.kind).toBe('success')
    const plan = (retry: number) => ({ id: `replay-${retry}`, expectedVersion: 0, description: `Replay ${retry}`, nodes: [
      { id: 'call', kind: 'saved', dependsOn: [], retry, workflow: { id: 'legacy', version: 1 } },
    ] })
    const refused = await saved(`publish-plan ${JSON.stringify(plan(3))}`)
    expect(refused.result.kind).toBe('error')
    expect(refused.result.text).toContain('predates non-retryable failure classes')
    expect(library.list().some(entry => entry.id === 'replay-3')).toBe(false)

    const allowed = await saved(`publish-plan ${JSON.stringify(plan(1))}`)
    expect(allowed.result.kind).toBe('success')
    const run = await saved('run replay-1 1')
    expect(run.result.kind).toBe('success')
    const envelope = JSON.parse(String(run.result.text)) as { content: { text: string }[] }
    expect(envelope.content[0]!.text).toMatch(/"call":\s*1/)
  } finally {
    for (const handle of created) await handle.dispose()
    try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
  }
}, 180000)
