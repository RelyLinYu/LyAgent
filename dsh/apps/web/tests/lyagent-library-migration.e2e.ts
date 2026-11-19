/** Reopen offline candidates through the real Loader and JSON backend without paid calls. */
import { handledCommand } from './lyagent-command.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-lyagent-knowledge'
import type {} from '@deepseek-ai/dsh-lyagent-workflow-library'
import { launchWebScaffold } from './scaffold.ts'

const repository = fileURLToPath(new URL('../../../', import.meta.url))
const tool = fileURLToPath(new URL('../../../../scripts/migrate-workflow-candidate.mjs', import.meta.url))
const reviewedBundle = fileURLToPath(new URL('../../../../scripts/workflow-replacements-20261116.json', import.meta.url))
const execute = promisify(execFile)
const SECRET = '设备编号必须与资产台账一致'

/** Keep the real route name while owning every request in this isolated composition. */
class FlowAdapter extends LlmAdapter {
  prompts: string[] = []
  bad = false
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.prompts.push(options.messages.flatMap(message => message.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n'))
    const text = this.bad ? 'BAD' : '投影仪 SC-1007 已与台账一致，借用记录已核对。' + '确定性隔离排练输出，不证明真实业务内容正确。'.repeat(4)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

it('reopens seven replacements and enforces grants and verification without changing routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-migration-loader-'))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  const handles: Awaited<ReturnType<NonNullable<typeof scaffold>['ctx']['agents']['create']>>[] = []
  try {
    // Synthetic history makes the test portable and avoids accessing the production home.
    const bundle = JSON.parse(await readFile(reviewedBundle, 'utf8')) as {
      workflows: { sourceVersion: number; sourceSha256: string; plan: { id: string } }[]
    }
    const script = 'return "legacy"'
    const sha256 = createHash('sha256').update(script).digest('hex')
    const definitions = Object.fromEntries(bundle.workflows.map((row) => {
      row.sourceSha256 = sha256
      return [row.plan.id, { editions: Array.from({ length: row.sourceVersion }, (_, index) => ({
        version: index + 1, description: 'Synthetic predecessor', script, sha256, knowledge: [],
      })) }]
    }))
    const source = join(root, 'source')
    await mkdir(join(source, 'storages'), { recursive: true })
    const storage = (name: string, tables: object) => writeFile(join(source, 'storages', `${name}.json`),
      JSON.stringify({ unit: { name, version: 1 }, global: null, tables }))
    await storage('lyagent_workflow_library', { definitions })
    await storage('lyagent_team_library', { definitions: {
      profile: { editions: [{ version: 1, definition: { kind: 'profile', description: 'Reader', instructions: 'Read.',
        provider: 'deepseek-official', model: 'deepseek-flash', enabled: true } }] },
      'definition_e3347ca0-9eec-4913-bd29-00e7954aa0f5': { editions: [1, 2].map(version => ({ version,
        definition: { kind: 'team', description: 'Team', members: [{ role: 'reader1', profile: { id: 'profile', version: 1 } }] } })) },
    } })
    const plans = join(root, 'plans.json')
    await writeFile(plans, JSON.stringify(bundle))
    const candidate = join(root, 'candidate')
    await execute(process.execPath, ['--import', 'tsx/esm', tool, '--source', source, '--plans', plans,
      '--agent', 'offline-placeholder', '--output', candidate], { cwd: repository, maxBuffer: 2 * 1024 * 1024 })
    const reviewedCandidate = process.env.LYAGENT_REVIEW_CANDIDATE
    if (reviewedCandidate) {
      await execute(process.execPath, [join(repository, '..', 'scripts', 'verify-workflow-candidate.mjs'),
        '--candidate', reviewedCandidate], { cwd: repository })
      // Only the test-owned copy is opened for writes by the Loader.
      await cp(reviewedCandidate, candidate, { recursive: true, force: true })
    }
    const overlay = join(root, 'overlay.json')
    await writeFile(overlay, JSON.stringify([{ id: 'llm-pi-ai', disabled: true }, { insert: [
      { id: 'lyagent-knowledge', name: '@deepseek-ai/dsh-lyagent-knowledge', config: {
        maxCollectionBytes: 20000, maxResultBytes: 4000, maxMatches: 4, maxLineChars: 200 } },
      { id: 'lyagent-workflow-library', name: '@deepseek-ai/dsh-lyagent-workflow-library',
        config: { maxDefinitionBytes: 65536, maxEntries: 20, maxParallelNodes: 2 } },
    ] }]))
    const adapter = new FlowAdapter()
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay, storageRoot: join(candidate, 'storages'), modelAdapter: adapter })
    const ctx = scaffold.ctx
    const commands = ctx.get('commands')
    const knowledge = ctx.get('lyagentKnowledge')
    const library = ctx.get('lyagentWorkflowLibrary')
    if (!commands || !knowledge || !library) throw Error('Migration plugins did not load')
    const handle = await ctx.agents.create({ sessionId: SessionId('candidate-owner'), meta: { cwd: scaffold.workspaceCwd },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
      setup: scope => ctx.agentPresets.mount(scope, 'standard').then(() => undefined) })
    handles.push(handle)
    const agent = handle.agent
    ctx.permissionPresets.set(agent.session, 'danger-full-access')
    const saved = (input: string) => handledCommand(commands.execute(agent, `/saved-workflow ${input}`, [], new AbortController().signal))
    const report = JSON.parse(await readFile(join(candidate, 'migration-report.json'), 'utf8')) as {
      grants: { collection: string; version: number }[]
      results: { id: string; edition: { version: number } }[]
    }
    const knowledgeRow = report.results.find(row => row.id === 'knowledge-probe')!
    // Offline identities do not authorize a different runtime Agent id.
    expect((await saved(`read knowledge-probe ${knowledgeRow.edition.version}`)).result.kind).toBe('error')
    await knowledge.grant(agent.id, report.grants)
    for (const row of report.results) {
      expect(library.read(row.id, row.edition.version).sourcePlan).toBeDefined()
      const result = await saved(`run ${row.id} ${row.edition.version}`)
      expect(result.result.kind, `${row.id}: ${result.result.text}`).toBe('success')
    }
    expect(adapter.prompts.some(prompt => prompt.includes(SECRET))).toBe(true)
    adapter.bad = true
    const verify = report.results.find(row => row.id === 'verify-probe')!
    const before = adapter.prompts.length
    expect((await saved(`run verify-probe ${verify.edition.version}`)).result.kind).toBe('error')
    expect(adapter.prompts.length - before).toBe(3)
    await knowledge.grant(agent.id, [])
    const revoked = await saved(`run knowledge-probe ${knowledgeRow.edition.version}`)
    expect(revoked.result.kind).toBe('error')
    expect(revoked.result.text).not.toContain(SECRET)
  } finally {
    for (const handle of handles) await handle.dispose()
    try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
  }
}, 180000)
