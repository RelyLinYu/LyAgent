/** Portable candidate rehearsal: immutable history, explicit plans, and safe reruns. */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { expect, it } from 'vitest'
import { compilePlan } from '../src/plan.ts'
import type { WorkflowEdition } from '../src/store.ts'

type Report = { state: string; results: { state: string }[] }
type Candidate = { tables: { definitions: { retry: { editions: WorkflowEdition[] } } } }

const execute = promisify(execFile)
const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const tool = fileURLToPath(new URL('../../../../../scripts/migrate-workflow-candidate.mjs', import.meta.url))

it('builds a complete candidate without changing the source and verifies exact replacements on rerun', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-candidate-'))
  try {
    const source = join(root, 'source')
    await mkdir(join(source, 'storages'), { recursive: true })
    const script = 'return await agent("legacy")'
    const sha256 = createHash('sha256').update(script).digest('hex')
    const historical = { version: 1, description: 'Legacy', script, sha256, knowledge: [] }
    const filename = join(source, 'storages', 'lyagent_workflow_library.json')
    const original = JSON.stringify({ unit: { name: 'lyagent_workflow_library', version: 1 }, global: null,
      tables: { definitions: { retry: { editions: [historical] } } } })
    await writeFile(filename, original)
    const oldText = 'Existing knowledge'
    const knowledgeFile = join(source, 'storages', 'lyagent_knowledge.json')
    await writeFile(knowledgeFile, JSON.stringify({ unit: { name: 'lyagent_knowledge', version: 1 }, global: null,
      tables: { collections: { prior: { title: 'Prior', archived: false, editions: [{ version: 1, sources: [
        { id: 'old', title: 'Old', text: oldText, sha256: createHash('sha256').update(oldText).digest('hex') },
      ] }] } }, grants: { 'actual-owner': { pins: [{ collection: 'prior', version: 1 }] } } } }))
    const plans = join(root, 'plans.json')
    const bundle = { format: 1, maxParallelNodes: 2, collections: [
      { id: 'rules', title: 'Rules', version: 1, sources: [{ id: 'rule', title: 'Rule', text: 'Reviewed rule' }] },
    ], workflows: [{ sourceVersion: 1, sourceSha256: sha256,
      plan: { id: 'retry', expectedVersion: 1, description: 'Reviewed replacement', nodes: [
        { id: 'call', kind: 'agent', dependsOn: [], prompt: 'Read', provider: 'deepseek-official', model: 'deepseek-flash', retry: 3,
          knowledge: { collection: 'rules', version: 1, query: 'Reviewed' } },
      ] } }], limits: { maxDefinitionBytes: 65536, maxEntries: 20, maxCollectionBytes: 20000,
      maxResultBytes: 4000, maxMatches: 4, maxLineChars: 200 } }
    await writeFile(plans, JSON.stringify(bundle))
    const run = (home: string, output?: string) => execute(process.execPath,
      ['--import', 'tsx/esm', tool, '--source', home, '--plans', plans, '--agent', 'actual-owner',
        ...(output ? ['--output', output] : [])], { cwd: repository, maxBuffer: 1024 * 1024 })
    const dry = JSON.parse((await run(source)).stdout) as Report
    const verify = (home: string) => execute(process.execPath,
      [join(repository, '..', 'scripts', 'verify-workflow-candidate.mjs'), '--candidate', home], { cwd: repository })
    expect(dry.state).toBe('dry-run')
    expect(dry.results[0]?.state).toBe('proposed')
    expect(await readFile(filename, 'utf8')).toBe(original)
    const output = join(root, 'candidate')
    await run(source, output)
    expect((JSON.parse((await verify(output)).stdout) as { state: string }).state).toBe('verified')
    const candidateFile = join(output, 'storages', 'lyagent_workflow_library.json')
    const candidate = JSON.parse(await readFile(candidateFile, 'utf8')) as Candidate
    const edition = candidate.tables.definitions.retry.editions[1]!
    expect(candidate.tables.definitions.retry.editions[0]).toEqual(historical)
    expect(edition).toMatchObject({ version: 2, knowledgeMode: 'managed', sourcePlan: bundle.workflows[0]!.plan })
    expect(edition.script).toContain('deepseek-official')
    expect(edition.script).toContain('Reviewed rule')
    const knowledge = JSON.parse(await readFile(join(output, 'storages', 'lyagent_knowledge.json'), 'utf8')) as {
      tables: { grants: Record<string, { pins: { collection: string; version: number }[] }> }
    }
    expect(knowledge.tables.grants['actual-owner']?.pins).toEqual([
      { collection: 'prior', version: 1 }, { collection: 'rules', version: 1 },
    ])
    const report = await readFile(join(output, 'migration-report.json'))
    expect((JSON.parse(await readFile(join(output, 'READY.json'), 'utf8')) as { reportSha256: string }).reportSha256)
      .toBe(createHash('sha256').update(report).digest('hex'))
    expect((JSON.parse((await run(output)).stdout) as Report).results[0]?.state).toBe('existing')
    await expect(run(source, output)).rejects.toThrow('Output already exists')
    await expect(run(source, join(source, 'nested'))).rejects.toThrow('outside the source')
    // A missing successful child result cannot turn into success by retrying either compiler layer.
    const outer = compilePlan({ id: 'outer', expectedVersion: 0, description: 'Outer', nodes: [
      { id: 'nested', kind: 'saved', dependsOn: [], retry: 3, workflow: { id: 'retry', version: 2 } },
    ] }, () => edition, () => { throw Error('No team expected') }, 2)
    let calls = 0
    const result: unknown = vm.runInNewContext(`(async () => {${outer.script}\n})()`, {
      phase: () => {}, log: () => {},
      agent: async () => { calls += 1; return calls === 1 ? null : 'GOOD' },
    })
    await expect(result).rejects.toThrow()
    expect(calls).toBe(1)
    edition.description = 'Unreviewed change'
    await writeFile(candidateFile, JSON.stringify(candidate))
    await expect(verify(output)).rejects.toThrow('Candidate hash differs')
    await expect(run(output)).rejects.toThrow('differs from the reviewed replacement')
    // A failed multi-item preparation must not create a partial candidate directory.
    bundle.workflows.push({ ...bundle.workflows[0]!, plan: { ...bundle.workflows[0]!.plan, id: 'missing' } })
    await writeFile(plans, JSON.stringify(bundle))
    const failed = join(root, 'failed')
    await expect(run(source, failed)).rejects.toThrow('unavailable')
    await expect(readFile(join(failed, 'READY.json'))).rejects.toThrow()
    const interrupted = join(root, 'interrupted')
    await mkdir(interrupted)
    await expect(verify(interrupted)).rejects.toThrow('READY.json')
    await expect(run(source, interrupted)).rejects.toThrow('Output already exists')
    expect(await readFile(filename, 'utf8')).toBe(original)
  } finally { await rm(root, { recursive: true, force: true }) }
}, 30000)
