/** Durable batch accounting; each update atomically replaces the complete batch record. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

const requestSchema = z.object({
  id: z.string(), state: z.enum(['pending', 'settled', 'unknown']),
  tokens: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  allocation: z.object({
    run: z.string().min(1), member: z.string().min(1),
    maxRequests: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    memberMaxRequests: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    memberMaxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }).optional(),
})

/** Immutable parent-run and member limits charged with the batch in one durable update. */
export type RunAllocation = NonNullable<z.infer<typeof requestSchema>['allocation']>
/** Validated durable batch record; malformed stored accounting prevents activation. */
export const batchSchema = z.object({
  maxRequests: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requests: z.array(requestSchema),
  sealedRuns: z.array(z.string().min(1)).optional(),
}).refine(batch => new Set(batch.requests.map(request => request.id)).size === batch.requests.length,
  'Duplicate request identities make stored accounting ambiguous')
  .refine(batch => Number.isSafeInteger(batch.requests.reduce((total, request) => total + request.tokens, 0)),
    'Stored token total exceeds exact accounting precision')
type Batch = z.infer<typeof batchSchema>

/** Stable denial reported without dispatching another provider request. */
export class BudgetError extends HarnessError {
  constructor(message: string) { super(message, 'LYAGENT_BUDGET_STOPPED'); this.name = 'BudgetError' }
}

/** One host-owned batch. Pending records after restart remain charged and block new calls. */
export class BatchLedger {
  constructor(private readonly table: KvTable<string, Batch>, private readonly batch: string) {}

  /** Initialize or verify immutable authorization.
   * @param maxRequests - authorized request count.
   * @param maxTokens - authorized reported token total.
   */
  async initialize(maxRequests: number, maxTokens: number): Promise<void> {
    const existing = this.table.get(this.batch)
    if (existing === undefined) {
      await this.table.put(this.batch, { maxRequests, maxTokens, requests: [] })
    } else if (existing.maxRequests !== maxRequests || existing.maxTokens !== maxTokens) {
      throw new BudgetError('Batch limits changed. Keep the existing authorization unchanged.')
    }
  }

  /** Persist reservation before dispatch.
   * A sealed root turn cannot admit additional root or child requests.
   * Reservations and reported overages remain visible to task settlement.
   * @param tokens - conservative per-request reservation.
   * @param active - ids owned by the live host, including in-flight admission.
   * @param concurrency - simultaneous provider request ceiling.
   * @param allocation - explicit parent-run and member ceiling; omitted charges only the batch.
   * @returns the durable reservation id.
   */
  async reserve(tokens: number, active: Set<string>, concurrency: number, allocation?: RunAllocation): Promise<string> {
    const id = randomUUID()
    active.add(id)
    try { await this.table.update(this.batch, (batch) => {
      if (batch.requests.some(request => request.state === 'unknown' || (request.state === 'pending' && !active.has(request.id)))) {
        throw new BudgetError('Usage is unknown after an interrupted request. Review the batch before further calls.')
      }
      if (batch.requests.filter(request => request.state === 'pending').length >= concurrency) {
        throw new BudgetError('The model request concurrency limit has been reached.')
      }
      const charged = batch.requests.reduce((total, request) => total + request.tokens, 0)
      if (allocation !== undefined) {
        if (batch.sealedRuns?.includes(allocation.run)) throw new BudgetError('This parent run is sealed against further requests.')
        const run = batch.requests.filter(request => request.allocation?.run === allocation.run)
        if (run.some(request => request.allocation?.maxRequests !== allocation.maxRequests
          || request.allocation.maxTokens !== allocation.maxTokens)) {
          throw new BudgetError('Parent run limits changed after admission.')
        }
        const member = run.filter(request => request.allocation?.member === allocation.member)
        if (member.some(request => request.allocation?.memberMaxRequests !== allocation.memberMaxRequests
          || request.allocation.memberMaxTokens !== allocation.memberMaxTokens)) {
          throw new BudgetError('Member limits changed after admission.')
        }
        if (run.length >= allocation.maxRequests
          || run.reduce((sum, request) => sum + request.tokens, 0) + tokens > allocation.maxTokens
          || member.length >= allocation.memberMaxRequests
          || member.reduce((sum, request) => sum + request.tokens, 0) + tokens > allocation.memberMaxTokens) {
          throw new BudgetError('The parent run or member allocation is exhausted.')
        }
      }
      if (batch.requests.length >= batch.maxRequests || charged + tokens > batch.maxTokens) {
        throw new BudgetError('The authorized request or token budget is exhausted.')
      }
      return { ...batch, requests: [...batch.requests, { id, state: 'pending', tokens,
        ...(allocation === undefined ? {} : { allocation: { ...allocation } }),
      }] }
    }) } catch (error) { active.delete(id); throw error }
    return id
  }

  /** Seal admission for a root turn and inspect authoritative batch, run and member usage.
   * @param run - root Session and original turn-start sequence.
   * @returns charged usage and whether all accounting is settled within its limits.
   */
  async seal(run: string): Promise<{ batch: string; run: string; requests: number; tokens: number; ready: boolean }> {
    if (!run.trim()) throw new BudgetError('Sealing requires an explicit parent run identity.')
    const batch = await this.table.update(this.batch, batch => batch.sealedRuns?.includes(run) ? batch : ({ ...batch,
      sealedRuns: [...(batch.sealedRuns ?? []), run] }))
    const requests = batch.requests.filter(request => request.allocation?.run === run)
    const tokens = requests.reduce((sum, request) => sum + request.tokens, 0)
    const ready = requests.length > 0 && batch.requests.every(request => request.state === 'settled')
      && batch.requests.length <= batch.maxRequests
      && batch.requests.reduce((sum, request) => sum + request.tokens, 0) <= batch.maxTokens
      && requests.every((request) => {
        const allocation = request.allocation
        if (allocation === undefined) return false
        const member = requests.filter(item => item.allocation?.member === allocation.member)
        return requests.length <= allocation.maxRequests && tokens <= allocation.maxTokens
          && member.length <= allocation.memberMaxRequests
          && member.reduce((sum, item) => sum + item.tokens, 0) <= allocation.memberMaxTokens
      })
    return { batch: this.batch, run, requests: requests.length, tokens, ready }
  }

  /** Settle once; absent authoritative usage remains unknown.
   * Sealing prevents admission, not authoritative late usage settlement.
   * @param id - durable reservation id.
   * @param tokens - authoritative usage, or undefined when uncertain.
   */
  async settle(id: string, tokens: number | undefined): Promise<void> {
    await this.table.update(this.batch, (batch) => {
      if (!batch.requests.some(request => request.id === id)) throw new BudgetError('The request reservation is missing.')
      return { ...batch, requests: batch.requests.map((request) => {
        if (request.id !== id) return request
        if (request.state !== 'pending') throw new BudgetError('A request cannot be settled twice.')
        return tokens === undefined ? { ...request, state: 'unknown' } : { ...request, state: 'settled', tokens }
      }) }
    })
  }
}
