/** Keyless acceptance: the reviewed migration command appends a replacement plan and is idempotent. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-lyagent-knowledge'
import type {} from '@deepseek-ai/dsh-lyagent-workflow-library'
import { launchWebScaffold } from './scaffold.ts'

it('proposes, commits and then recognises an identical reviewed replacement', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-migrate-cmd-'))
  const overlay = join(root, 'migrate.json')
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
    const owner = await ctx.agents.create({ sessionId: SessionId('migrate-owner'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'migrate-fixture', model: 'fixture' },
      setup: scope => scaffold?.ctx.agentPresets.mount(scope, 'standard').then(() => undefined) })
    created.push(owner)
    ctx.permissionPresets.set(owner.agent.session, 'danger-full-access')
    const agent = owner.agent
    const saved = (input: string) => commands.execute(agent, `/saved-workflow ${input}`, [], new AbortController().signal)
    const baseline = { id: 'reviewed', expectedVersion: 0, description: 'Old', script: 'return { legacy: true }' }
    expect((await saved(`publish ${JSON.stringify(baseline)}`)).result.kind).toBe('success')
    const source = JSON.parse((await saved('read reviewed 1')).result.text) as { sha256: string }
    const replacement = { sourceVersion: 1, sourceSha256: source.sha256, plan: {
      id: 'reviewed', expectedVersion: 1, description: 'Reviewed replacement', nodes: [
        { id: 'only', kind: 'agent', provider: 'migrate-fixture', model: 'fixture', prompt: 'reviewed work', dependsOn: [], retry: 1 },
      ] } }

    const proposal = JSON.parse((await saved(`review-migration ${JSON.stringify(replacement)}`)).result.text) as { state: string, version: number }
    expect(proposal).toMatchObject({ state: 'proposed', version: 2 })
    expect(library.list().find(entry => entry.id === 'reviewed')?.version).toBe(1)

    const committed = JSON.parse((await saved(`migrate-plan ${JSON.stringify(replacement)}`)).result.text) as { state: string, version: number }
    expect(committed).toMatchObject({ state: 'committed', version: 2 })
    const stored = library.read('reviewed', 2)
    expect(stored.knowledgeMode).toBe('managed')
    expect(stored.sourcePlan).toMatchObject({ id: 'reviewed', description: 'Reviewed replacement' })

    const again = JSON.parse((await saved(`migrate-plan ${JSON.stringify(replacement)}`)).result.text) as { state: string, version: number }
    expect(again).toMatchObject({ state: 'existing', version: 2 })
    expect(library.list().find(entry => entry.id === 'reviewed')?.version).toBe(2)

    // A replacement that no longer matches the reviewed predecessor is refused.
    const stale = { ...replacement, sourceSha256: 'a'.repeat(64) }
    const refused = await saved(`migrate-plan ${JSON.stringify(stale)}`)
    expect(refused.result.kind).toBe('error')
    expect(refused.result.text).toContain('source digest changed')
  } finally {
    for (const handle of created) await handle.dispose()
    try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
  }
}, 180000)
