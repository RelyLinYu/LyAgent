/** Opt-in, durable authorization-batch admission around every native model stream. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { BatchLedger, batchSchema, BudgetError } from './ledger.ts'
import type { RunAllocation } from './ledger.ts'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-subagent'

export const name = 'lyagent-budget'
export const inject = ['llm', 'storageDomain']

/** Explicit batch authorization; configuration never creates additional batches automatically. */
export interface Config {
  /** Durable authorization batch identity; reusing it retains prior charges. */
  batchId: string
  /** Maximum model requests admitted across the batch. */
  maxRequests: number
  /** Maximum accounted tokens admitted across the batch. */
  maxTokens: number
  /** Conservative token reservation charged before each request begins. */
  reservationTokens: number
  /** Maximum simultaneous batch requests, between one and three. */
  maxConcurrent: number
  /** Omission preserves batch-only accounting; explicit limits require live native agent ownership. */
  runLimits?: {
    /** Maximum requests charged to one root turn and its children. */
    maxRequests: number
    /** Maximum tokens charged to one root turn and its children. */
    maxTokens: number
    /** Maximum requests charged to one child activation. */
    childMaxRequests: number
    /** Maximum tokens charged to one child activation. */
    childMaxTokens: number
  } | undefined
}
export const Config: z<Config> = z.object({
  batchId: z.string().required(),
  maxRequests: z.number().min(1).step(1).required(),
  maxTokens: z.number().min(1).step(1).required(),
  reservationTokens: z.number().min(1).step(1).required(),
  maxConcurrent: z.number().min(1).max(3).step(1).required(),
  runLimits: z.union([z.const(undefined), z.object({
    maxRequests: z.number().min(1).step(1).required(),
    maxTokens: z.number().min(1).step(1).required(),
    childMaxRequests: z.number().min(1).step(1).required(),
    childMaxTokens: z.number().min(1).step(1).required(),
  })]),
})

/** Host-owned budget view used by business task settlement; it never dispatches requests. */
export interface LyAgentBudget {
  /** Seal one root turn against further admission.
   * @param run - root Session and original turn-start sequence.
   * @returns charged usage and whether all batch, run and member limits settled cleanly.
   */
  seal(run: string): Promise<{ batch: string; run: string; requests: number; tokens: number; ready: boolean }>
}

declare module '@deepseek-ai/cordis' {
  interface Context { lyagentBudget: LyAgentBudget }
}

const spec = defineDomain({
  name: 'lyagent_budget', version: 1,
  tables: { batches: domainTable(batchSchema) },
})

function reportedTokens(usage: TokenUsage): number | undefined {
  const { inputTokens, outputTokens, totalTokens } = usage
  if (![inputTokens, outputTokens].every(value => Number.isSafeInteger(value) && value >= 0)) return undefined
  const sum = inputTokens + outputTokens
  if (!Number.isSafeInteger(sum)) return undefined
  if (totalTokens === undefined) return sum
  return Number.isSafeInteger(totalTokens) && totalTokens >= sum ? totalTokens : undefined
}

/** Mount admission after durable state is ready and drain streams before closing it.
 * @param ctx - plugin lifecycle owner.
 * @param config - one immutable authorization batch and conservative reservation size.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const limits = [config.maxRequests, config.maxTokens, config.reservationTokens, config.maxConcurrent]
  if (!config.batchId.trim() || !limits.every(value => Number.isSafeInteger(value) && value > 0)
    || config.maxConcurrent > 3 || config.reservationTokens > config.maxTokens) {
    throw new Error('Invalid LyAgent authorization batch configuration')
  }
  const domain = await ctx.storageDomain.open(spec)
  const runLimits = config.runLimits
  const agents = ctx.get('agents')
  const subagents = ctx.get('subagents')
  if (runLimits !== undefined && (agents === undefined || subagents === undefined
    || !Object.values(runLimits).every(value => Number.isSafeInteger(value) && value > 0)
    || runLimits.childMaxRequests > runLimits.maxRequests || runLimits.childMaxTokens > runLimits.maxTokens
    || config.reservationTokens > runLimits.childMaxTokens)) {
    await domain.close()
    throw new BudgetError('Run allocations require native agents, subagents and valid explicit limits.')
  }
  const childRuns = new Map<string, string>()
  if (runLimits !== undefined && agents !== undefined && subagents !== undefined) {
    ctx.on('subagent/start', (info) => {
      const parent = agents.get(info.parentSessionId)
      if (parent === undefined) return
      const root = subagents.rootOf(parent)
      const inherited = childRuns.get(parent.id)
      const turn = agents.turnBoundaryOf(root.session)
      if (inherited !== undefined) childRuns.set(info.id, inherited)
      else if (turn.openTurnStartSeq !== null) childRuns.set(info.id, `${root.id}:${turn.openTurnStartSeq}`)
    })
    ctx.on('subagent/end', (info) => { childRuns.delete(info.id) })
    ctx.effect(() => () => { childRuns.clear() })
  }
  const ledger = new BatchLedger(domain.table('batches'), config.batchId)
  try { await ledger.initialize(config.maxRequests, config.maxTokens) } catch (error) {
    await domain.close()
    throw error
  }
  const active = new Set<string>()
  const budget: LyAgentBudget = { seal: run => ledger.seal(run) }
  ctx.provide('lyagentBudget', budget)
  const lifetime = { closed: false }
  const isClosed = () => lifetime.closed
  const running = new Set<Promise<void>>()
  ctx.effect(() => async () => {
    lifetime.closed = true
    await Promise.allSettled([...running])
    await domain.close()
  })
  ctx.on('llm/stream', async function* (options, next) {
    if (options.signal?.aborted || isClosed()) return
    const completion = Promise.withResolvers<void>()
    running.add(completion.promise)
    let id: string | undefined
    let usage: number | undefined
    let finished = false
    let settled = false
    try {
      let allocation: RunAllocation | undefined
      if (runLimits !== undefined && options.sessionId === undefined) {
        throw new BudgetError('Run accounting requires an explicit owning session for every request.')
      }
      if (runLimits !== undefined && options.sessionId !== undefined && agents !== undefined && subagents !== undefined) {
        const agent = agents.get(options.sessionId)
        if (agent === undefined) throw new BudgetError('Run accounting requires a live owning agent.')
        const root = subagents.rootOf(agent)
        const child = root !== agent
        const turn = agents.turnBoundaryOf(root.session)
        const run = child ? childRuns.get(agent.id)
          : turn.openTurnStartSeq === null ? undefined : `${root.id}:${turn.openTurnStartSeq}`
        if (run === undefined) throw new BudgetError('No parent run allocation is bound to this agent.')
        allocation = { run, member: agent.id, maxRequests: runLimits.maxRequests, maxTokens: runLimits.maxTokens,
          memberMaxRequests: child ? runLimits.childMaxRequests : runLimits.maxRequests,
          memberMaxTokens: child ? runLimits.childMaxTokens : runLimits.maxTokens }
      }
      id = await ledger.reserve(config.reservationTokens, active, config.maxConcurrent, allocation)
      if (isClosed() || options.signal?.aborted) return
      for await (const chunk of next()) {
        if (chunk.type === 'usage') usage = reportedTokens(chunk.usage)
        if (chunk.type === 'finish') {
          finished = chunk.reason.kind === 'stop' || chunk.reason.kind === 'tool-calls'
          if (finished && usage === undefined) {
            finished = false
            await ledger.settle(id, undefined)
            settled = true
            yield { type: 'finish', reason: { kind: 'error', failure: {
              code: 'LYAGENT_USAGE_UNKNOWN', message: 'Request usage is unknown. Further model requests are stopped pending budget review.',
            } } }
            return
          }
          await ledger.settle(id, finished ? usage : undefined)
          settled = true
        }
        yield chunk
      }
    } finally {
      try { if (id !== undefined && !settled) await ledger.settle(id, undefined) } finally {
        if (id !== undefined) active.delete(id)
        running.delete(completion.promise)
        completion.resolve()
      }
    }
  }, { prepend: true })
}
