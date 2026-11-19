/** Host-configured checks that block native delivery declarations on invalid files. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-fs'
import type { FsTarget, FsVersion } from '@deepseek-ai/dsh-fs'
import { runUnittest, validTestConfig } from './unittest.ts'
import type { TestConfig } from './unittest.ts'
import type {} from '@deepseek-ai/dsh-working-directory'
import { RunLedger, runDomain } from './run.ts'
import { TaskRuns } from './run-runtime.ts'
import { registerTaskCommand } from './command.ts'
import type { RepairCandidate } from './worker-selection.ts'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session-persistence'

export const name = 'lyagent-artifact-acceptance'
export const inject = ['tools', 'fs', 'workingDirectory']

/** Trusted deployment-owned checks; model arguments cannot replace these rules. */
export interface Config {
  /** Deployment-owned artifact requirements evaluated before delivery. */
  artifacts: {
    /** Artifact path resolved under native workspace filesystem policy. */
    path: string
    /** Minimum complete artifact byte length. */
    minBytes: number
    /** Maximum complete artifact byte length. */
    maxBytes: number
    /** Required literal text fragments in the decoded artifact. */
    includes: string[]
    /** Optional expected lowercase SHA-256; omission checks size and literals only. */
    sha256?: string | undefined
  }[]
  /** Omission performs file checks only; explicit rules also require independent nonzero tests. */
  tests?: TestConfig | undefined
  /** Explicit host task API; omitted leaves delivery checks independent of business task state. */
  taskRuns?: boolean | undefined
  /** Required for task runs; maximum local repair deliveries after the first check. */
  maxRepairs?: number | undefined
  /** Explicit artifact-to-board mappings; optional worker routes require audited tool names and a child output limit. */
  repairTargets?: {
    /** Artifact path whose failed check opens this repair work order. */
    path: string
    /** Host-owned instruction identifying the required repair. */
    workOrder: string
    /** Ordered authorized routes; omission uses the explicit single worker if present. */
    candidates?: RepairCandidate[] | undefined
    /** Candidate capability labels required for selection; omission requires none. */
    requiredCapabilities?: string[] | undefined
    /** Explicit single repair route; omission requires candidate routes. */
    worker?: {
      /** Registered native model provider identity. */
      provider: string
      /** Model identity resolved by the provider. */
      model: string
      /** Explicit read-only tool allowlist for the repair child. */
      readOnlyTools: string[]
    } | undefined
  }[] | undefined
}
export const Config: z<Config> = z.object({
  taskRuns: z.union([z.const(undefined), z.boolean()]),
  maxRepairs: z.union([z.const(undefined), z.number()]),
  repairTargets: z.union([z.const(undefined), z.array(z.object({
    path: z.string().required(), workOrder: z.string().required(),
    requiredCapabilities: z.union([z.const(undefined), z.array(z.string())]),
    candidates: z.union([z.const(undefined), z.array(z.object({
      id: z.string().required(), enabled: z.boolean().required(), capabilities: z.array(z.string()).required(),
      maxActive: z.union([z.const(undefined), z.number()]),
      provider: z.string().required(), model: z.string().required(), readOnlyTools: z.array(z.string()).required(),
    }))]),
    worker: z.union([z.const(undefined), z.object({ provider: z.string().required(), model: z.string().required(),
      readOnlyTools: z.array(z.string()).required() })]),
  }))]),
  artifacts: z.array(z.object({
    path: z.string().required(), minBytes: z.number().required(), maxBytes: z.number().required(),
    includes: z.array(z.string()).required(), sha256: z.union([z.const(undefined), z.string()]),
  })).required(),
  tests: z.union([z.const(undefined), z.object({
    python: z.string().required(), root: z.string().required(),
    files: z.array(z.object({ path: z.string().required(), sha256: z.string().required() })).required(),
    minTests: z.number().required(), timeoutMs: z.number().required(),
    maxChildResultBytes: z.union([z.const(undefined), z.number()]),
  })]),
})

/** Verify complete text at every present call before native delivery observers run.
 * @param ctx - lifecycle-owned filesystem and tool policy registrations.
 * @param config - immutable host-owned required artifact checks.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (config.tests !== undefined && !validTestConfig(config.tests)) {
    throw new Error('Independent acceptance tests require absolute Python/evaluator paths, pinned test digests and positive limits.')
  }
  if (!config.artifacts.length || config.artifacts.some(rule => !rule.path.trim()
    || !Number.isSafeInteger(rule.minBytes) || !Number.isSafeInteger(rule.maxBytes)
    || rule.minBytes < 1 || rule.maxBytes < rule.minBytes
    || rule.includes.some(text => text.length === 0)
    || (rule.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(rule.sha256)))
    || new Set(config.artifacts.map(rule => rule.path)).size !== config.artifacts.length) {
    throw new Error('Artifact acceptance requires unique paths and explicit positive byte bounds and valid checks.')
  }
  let tasks: TaskRuns | undefined
  if (config.repairTargets !== undefined && (config.taskRuns !== true
    || config.repairTargets.length === 0
    || new Set(config.repairTargets.map(target => target.path)).size !== config.repairTargets.length
    || config.repairTargets.some(target => !target.workOrder.trim()
      || target.requiredCapabilities?.some(capability => !capability.trim())
      || target.candidates !== undefined && (target.worker !== undefined || target.candidates.length === 0
        || config.tests?.maxChildResultBytes === undefined
        || new Set(target.candidates.map(candidate => candidate.id)).size !== target.candidates.length
        || target.candidates.some(candidate => !candidate.id.trim() || !candidate.provider.trim() || !candidate.model.trim()
          || candidate.maxActive !== undefined && (!Number.isSafeInteger(candidate.maxActive) || candidate.maxActive < 1)
          || candidate.readOnlyTools.some(name => !name.trim()) || candidate.capabilities.some(capability => !capability.trim())))
      || target.requiredCapabilities !== undefined && target.candidates === undefined
      || target.worker !== undefined && (!target.worker.provider.trim() || !target.worker.model.trim()
        || target.worker.readOnlyTools.some(name => !name.trim()) || config.tests?.maxChildResultBytes === undefined)
      || !config.artifacts.some(rule => rule.path === target.path)))) {
    throw new Error('Repair targets require task runs, unique configured artifact paths and explicit work-order identities.')
  }
  if (config.taskRuns === true && (!Number.isSafeInteger(config.maxRepairs) || config.maxRepairs === undefined
    || config.maxRepairs < 0 || config.maxRepairs > 2)) {
    throw new Error('Task runs require an explicit maxRepairs between zero and two.')
  }
  if (config.taskRuns === true) {
    const storage = ctx.get('storageDomain')
    if (storage === undefined || ctx.get('agents') === undefined || ctx.get('sessionPersistence') === undefined || config.tests === undefined) {
      throw new Error('Task runs require storageDomain, agents, sessionPersistence and independent tests.')
    }
    const domain = await storage.open(runDomain)
    try {
      const ledger = new RunLedger(domain.table('runs'))
      await ledger.recover()
      const criteriaDigest = createHash('sha256').update(JSON.stringify({ artifacts: config.artifacts,
        tests: config.tests, maxRepairs: config.maxRepairs, repairTargets: config.repairTargets })).digest('hex')
      tasks = new TaskRuns(ctx, ledger, config.tests, config.maxRepairs ?? 0, config.artifacts, criteriaDigest, config.repairTargets)
      ctx.provide('lyagentTaskRuns', tasks)
      registerTaskCommand(ctx, tasks)
      ctx.effect(() => async () => {
        try { await tasks?.close() } finally { await domain.close() }
      })
    } catch (error) { await domain.close(); throw error }
  }
  ctx.on('tools/post-execute', async (exec, result, next) => {
    if (exec.name !== 'present') return next()
    if (exec.agent !== undefined && tasks !== undefined) await tasks.invalidate(exec.agent)
    if (result.isError) return next()
    const deny = (reason: string) => ({ kind: 'block' as const,
      feedback: [{ type: 'text' as const, text: `Artifact acceptance failed: ${reason}` }],
      info: { name: 'LyAgentArtifactAcceptanceError', code: 'LYAGENT_ARTIFACT_REJECTED' },
    })
    if (exec.agent === undefined) return deny('No owning session.')
    const cwd = await ctx.workingDirectory.ensure(exec.agent, exec.signal)
    const value = result.value
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.files)) {
      return deny('Delivery result does not contain file declarations.')
    }
    const paths = new Set(value.files.flatMap(file => file !== null && typeof file === 'object'
      && !Array.isArray(file) && typeof file.path === 'string' ? [file.path] : []))
    const verified: { path: string; sha256: string }[] = []
    const versions: { target: FsTarget; version: FsVersion }[] = []
    const rules = [...config.artifacts, ...(tasks?.requirements(exec.agent) ?? [])]
    const owner = exec.agent
    for (const rule of rules) {
      const rejectArtifact = async (reason: string) => {
        await tasks?.rejected(owner, rule.path, reason)
        return deny(reason)
      }
      const target = await ctx.fs.resolve(rule.path, { cwd, signal: exec.signal })
      const path = ctx.fs.processPath(target)
      if (!paths.has(path)) return rejectArtifact(`Required artifact is not declared: ${path}`)
      const before = await ctx.fs.stat(target, exec.signal)
      if (before?.type !== 'file') return rejectArtifact(`Required regular file is absent: ${path}`)
      if (before.size !== undefined && before.size > rule.maxBytes) return rejectArtifact(`Artifact exceeds byte limit: ${path}`)
      const bytes = await ctx.fs.readBytes(target, exec.signal, rule.maxBytes)
      const after = await ctx.fs.stat(target, exec.signal)
      if (after?.version !== before.version) return deny(`Artifact changed while checking: ${path}`)
      if (bytes.length < rule.minBytes) return rejectArtifact(`Artifact is empty or below its minimum size: ${path}`)
      let text: string
      try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch (error) {
        if (error instanceof TypeError) return deny(`Artifact is not valid UTF-8 text: ${path}`)
        throw error
      }
      if (rule.includes.some(needle => !text.includes(needle))) return rejectArtifact(`Required text is absent: ${path}`)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      if ('sha256' in rule && rule.sha256 !== undefined && rule.sha256 !== sha256) return deny(`Artifact digest differs from the required version: ${path}`)
      if (!verified.some(file => file.path === path)) verified.push({ path, sha256 })
      versions.push({ target, version: before.version })
    }
    const decision = await next()
    let testSummary: string | undefined
    let testsRun = 0
    const children = tasks === undefined ? '[]' : await tasks.measureChildren(exec.agent, true)
    if (children === undefined) return deny('Child results are missing, unsettled or exceed the configured evaluator input limit.')
    if (decision.kind === 'block') return decision
    // Preserve canonical delivery fields; persist the bound mechanical checks in model-visible result text.
    if ('value' in decision) return deny('A later policy replaced the checked delivery result.')
    if (config.tests !== undefined) {
      let failure = 'Independent tests did not complete with the required nonzero count and clean outcome.'
      testSummary = await runUnittest(ctx, exec, config.tests, cwd,
        (reason) => { failure = reason }, (count) => { testsRun = count }, children)
      if (testSummary === undefined) return deny(failure)
    }
    for (const file of versions) {
      if ((await ctx.fs.stat(file.target, exec.signal))?.version !== file.version) {
        return deny(`Artifact changed before delivery settlement: ${file.target.displayPath}`)
      }
    }
    exec.signal.throwIfAborted()
    if (tasks !== undefined && config.tests !== undefined) {
      await tasks.checked(exec.agent, { callId: exec.callId, artifacts: verified,
        evaluators: config.tests.files, tests: testsRun }, children)
    }
    const childSummary = children === '[]' ? ''
      : `\nIndependently tested child measurements SHA-256: ${createHash('sha256').update(children).digest('hex')}`
    return { ...decision, content: [...(decision.content ?? result.content), { type: 'text' as const,
      text: `Mechanical artifact checks passed for these versions only:\n${verified.map(file => `${file.path} SHA-256 ${file.sha256}`).join('\n')}${testSummary === undefined ? '' : `\n${testSummary}`}${childSummary}` }] }
  }, { prepend: true })
}
