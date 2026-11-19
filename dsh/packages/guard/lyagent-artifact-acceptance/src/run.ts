/** Durable task ownership and acceptance; native turn completion alone never completes a task. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { requirementsSchema } from './requirements.ts'
import type { TaskRequirements } from './requirements.ts'

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const fileSchema = z.object({ path: z.string().min(1), sha256: digest })
const knowledgeSchema = z.array(z.object({ collection: z.string().min(1), version: z.number().int().positive(),
  sources: z.array(z.object({ id: z.string().min(1), sha256: digest })).min(1) }))
const evidenceSchema = z.object({
  callId: z.string().min(1), artifacts: z.array(fileSchema).min(1),
  evaluators: z.array(fileSchema).min(1), tests: z.number().int().positive(),
}).refine(value => new Set(value.artifacts.map(file => file.path)).size === value.artifacts.length
  && new Set(value.evaluators.map(file => file.path)).size === value.evaluators.length,
'Duplicate evidence paths are ambiguous')
const ownerSchema = z.object({ session: z.string().min(1), turn: z.number().int().nonnegative(), lease: z.uuid() })
const activeSchema = z.object({ state: z.literal('running'), owner: ownerSchema })
const checkingSchema = z.object({ state: z.literal('checking'), owner: ownerSchema, evidence: evidenceSchema })
/** Stored task schema: all nonterminal process-owned states require recovery after restart. */
export const runSchema = z.object({
  objective: z.string().min(1), session: z.string().min(1),
  criteriaDigest: digest.optional(),
  requirements: requirementsSchema.optional(),
  rejection: z.object({ path: z.string().min(1), reason: z.string().min(1), turn: z.number().int().nonnegative(),
    repairable: z.boolean().optional() }).optional(),
  knowledge: knowledgeSchema.optional(),
  workOrders: z.array(z.string().min(1)).optional(),
  repairs: z.array(z.object({ target: z.string().min(1), affected: z.array(z.string().min(1)).min(1),
    preserved: z.array(z.object({ id: z.string().min(1), revision: z.number().int().nonnegative() })).optional() })).optional(),
  revision: z.number().int().nonnegative(),
  outcome: z.discriminatedUnion('state', [
    z.object({ state: z.literal('queued') }), activeSchema, checkingSchema,
    z.object({ state: z.literal('needs_attention'), reason: z.string().min(1) }),
    z.object({ state: z.literal('cancelled'), reason: z.string().min(1) }),
    z.object({ state: z.literal('completed'), owner: ownerSchema, evidence: evidenceSchema }),
  ]),
})
/** Host-owned domain, separate from session transcripts and budget authorization. */
export const runDomain = defineDomain({ name: 'lyagent_task_runs', version: 1, tables: { runs: domainTable(runSchema) } })
type Run = z.infer<typeof runSchema>
/** One attempt's unforgeable process ownership, invalidated on restart and cancellation. */
export type RunOwner = z.infer<typeof ownerSchema>
/** Artifact and evaluator inputs from successful independent acceptance in this attempt. */
export type RunEvidence = z.infer<typeof evidenceSchema>

/** Stable refusal; no rejected transition publishes a replacement task record. */
export class RunError extends HarnessError {
  constructor(message: string) { super(message, 'LYAGENT_RUN_REJECTED'); this.name = 'RunError' }
}

function owns(run: Run, owner: RunOwner): boolean {
  const outcome = run.outcome
  return (outcome.state === 'running' || outcome.state === 'checking')
    && run.session === owner.session && outcome.owner.session === owner.session
    && outcome.owner.turn === owner.turn && outcome.owner.lease === owner.lease
}

/** Host controller; completion requires a committed native delivery and fresh final version checks. */
export class RunLedger {
  private registration: Promise<void> = Promise.resolve()
  constructor(private readonly table: KvTable<string, Run>) {}

  /** Register an immutable task before dispatch; existing tasks cannot be replaced.
   * @param id - trusted host task identity.
   * @param session - owning session identity.
   * @param objective - user-approved task objective.
   * @param knowledge - exact authorized source manifest; omission preserves tasks without knowledge.
   * @param workOrders - required native board identities; omission preserves tasks without a board.
   * @param criteriaDigest - trusted deployment criteria digest; omission retains legacy unpinned tasks.
   * @param requirements - additional immutable human checks; omitted adds no checks.
   */
  async create(id: string, session: string, objective: string, knowledge?: z.infer<typeof knowledgeSchema>,
    workOrders?: readonly string[], criteriaDigest?: string, requirements?: TaskRequirements): Promise<void> {
    const operation = this.registration.then(async () => {
      if (!id.trim() || !session.trim() || !objective.trim() || this.table.get(id) !== undefined) {
        throw new RunError('Task registration requires a new identity, owning session and objective.')
      }
      const pins = knowledge === undefined ? undefined : knowledgeSchema.parse(knowledge)
      await this.table.put(id, { objective, session, ...(pins === undefined ? {} : { knowledge: pins }),
        ...(criteriaDigest === undefined ? {} : { criteriaDigest: digest.parse(criteriaDigest) }),
        ...(requirements === undefined ? {} : { requirements: requirementsSchema.parse(requirements) }),
        ...(workOrders === undefined ? {} : { workOrders: z.array(z.string().min(1)).parse(workOrders) }),
        revision: 0, outcome: { state: 'queued' } })
    })
    this.registration = operation.then(() => {}, () => {})
    await operation
  }

  /** Return the current durable task without exposing a mutable storage record.
   * @param id - registered task identity.
   * @returns a detached task record, or undefined when absent.
   */
  read(id: string): Run | undefined {
    const run = this.table.get(id)
    return run === undefined ? undefined : structuredClone(run)
  }

  /** List only one session's task summaries without exposing acceptance paths or other owners.
   * @param session - owning session selected by the host.
   * @param after - exclusive task identity cursor; absent starts the first page.
   * @returns at most fifty summaries with clipped objectives and an optional continuation cursor.
   */
  list(session: string, after?: string): {
    tasks: { id: string; objective: string; state: Run['outcome']['state']; reason?: string }[]
    next?: string
  } {
    const candidates = [...this.table.entries()].filter(([id, run]) => run.session === session && (after === undefined || id > after))
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    const tasks = candidates.slice(0, 50).map(([id, run]) => ({ id, objective: run.objective.slice(0, 240), state: run.outcome.state,
      ...('reason' in run.outcome ? { reason: run.outcome.reason.slice(0, 2000) } : {}),
    }))
    const last = tasks.at(-1)
    return { tasks, ...(candidates.length > tasks.length && last !== undefined ? { next: last.id } : {}) }
  }

  /** Invalidate interrupted attempts before mounting execution listeners; never replays effects. */
  async recover(): Promise<void> {
    for (const [id, run] of this.table.entries()) {
      if (run.outcome.state !== 'running' && run.outcome.state !== 'checking') continue
      await this.table.update(id, current => ({ ...current, revision: current.revision + 1,
        outcome: { state: 'needs_attention', reason: 'The host stopped before task settlement. Review prior effects before starting a new attempt.' } }))
    }
  }

  /** Acquire one attempt; explicit host resume is allowed only from queued or needs_attention.
   * @param id - registered task identity.
   * @param session - current native session.
   * @param turn - current native turn start sequence, not a guessed idle interval.
   * @returns new attempt ownership, persisted before dispatch.
   */
  async begin(id: string, session: string, turn: number): Promise<RunOwner> {
    const owner = ownerSchema.parse({ session, turn, lease: randomUUID() })
    await this.table.update(id, (run) => {
      if (run.session !== session || !['queued', 'needs_attention'].includes(run.outcome.state)) {
        throw new RunError('This task cannot start in the supplied session or state.')
      }
      const { rejection: _previousRejection, ...current } = run
      return { ...current, revision: run.revision + 1, outcome: { state: 'running', owner } }
    })
    return owner
  }

  /** Bind independent acceptance to this attempt, not to an earlier delivery.
   * A subsequent delivery attempt must invalidate this candidate first.
   * @param id - registered task identity.
   * @param owner - live attempt ownership.
   */
  async invalidate(id: string, owner: RunOwner): Promise<void> {
    await this.table.update(id, (run) => {
      if (!owns(run, owner)) throw new RunError('This delivery attempt does not own the task.')
      const { rejection: _previousRejection, ...current } = run
      return { ...current, revision: run.revision + 1, outcome: { state: 'running', owner } }
    })
  }

  /** Bind independent acceptance to this attempt, not to an earlier delivery.
   * A subsequent delivery attempt must invalidate this candidate first.
   * @param id - registered task identity.
   * @param owner - live attempt ownership.
   * @param evidence - independently measured artifact/evaluator versions and test count.
   */
  async checked(id: string, owner: RunOwner, evidence: RunEvidence): Promise<void> {
    const verified = evidenceSchema.parse(evidence)
    await this.table.update(id, (run) => {
      if (!owns(run, owner) || run.outcome.state !== 'running') throw new RunError('Acceptance does not own this running attempt.')
      const { rejection: _previousRejection, ...current } = run
      return { ...current, revision: run.revision + 1, outcome: { state: 'checking', owner, evidence: verified } }
    })
  }

  /** Persist a mechanical rejection only for its live task attempt.
   * @param id - registered task identity.
   * @param owner - exact live attempt ownership.
   * @param path - configured artifact path that failed.
   * @param reason - host-generated mechanical diagnostic.
   */
  async reject(id: string, owner: RunOwner, path: string, reason: string): Promise<void> {
    if (!path.trim() || !reason.trim()) throw new RunError('Artifact rejection requires a path and reason.')
    await this.table.update(id, (run) => {
      if (!owns(run, owner) || run.outcome.state !== 'running') throw new RunError('Rejection does not own this attempt.')
      return { ...run, revision: run.revision + 1, rejection: { path, reason, turn: owner.turn } }
    })
  }

  /** Settle only after native turn/end and host revalidation; incomplete evidence stays incomplete.
   * The caller also owns required work, permission and unknown-effect checks.
   * @param id - registered task identity.
   * @param owner - live attempt ownership.
   * @param settlement - actual native outcome, persisted delivery call and final version comparison.
   * Nonempty failureReasons are host diagnostics; omission retains the generic attention reason.
   */
  async settle(id: string, owner: RunOwner, settlement: {
    end: 'completed' | 'aborted' | 'other'
    deliveredCallId: string | undefined
    versionsMatch: boolean
    expectedRevision?: number | undefined
    repairable?: boolean | undefined
    failureReasons?: readonly string[] | undefined
  }): Promise<void> {
    await this.table.update(id, (run) => {
      if (!owns(run, owner)) throw new RunError('Late or foreign task settlement was rejected.')
      if (settlement.expectedRevision !== undefined && run.revision !== settlement.expectedRevision) {
        throw new RunError('Task evidence changed during settlement.')
      }
      const outcome = run.outcome
      if (settlement.end === 'aborted') return { ...run, revision: run.revision + 1,
        outcome: { state: 'cancelled', reason: 'The owning native turn was cancelled.' } }
      if (settlement.end === 'completed' && outcome.state === 'checking'
        && settlement.deliveredCallId === outcome.evidence.callId && settlement.versionsMatch) {
        return { ...run, revision: run.revision + 1, outcome: { ...outcome, state: 'completed' } }
      }
      return { ...run, revision: run.revision + 1,
        ...(run.rejection === undefined ? {} : { rejection: { ...run.rejection, repairable: settlement.repairable === true } }),
        outcome: { state: 'needs_attention',
          reason: settlement.failureReasons?.length
            ? `Task acceptance requires attention: ${settlement.failureReasons.join('; ')}. Review the recorded evidence before restarting.`
            : 'The turn ended without a matching committed delivery and fresh independent acceptance.' } }
    })
  }

  /** Reserve an explicit local repair before any native board mutation.
   * @param id - registered task identity.
   * @param session - owning session.
   * @param target - explicitly failed work order.
   * @param affected - dependency descendants selected from the current board.
   * @param limit - host-configured maximum repairs for this task.
   * @param preserved - completed independent board versions; omitted retains historical repair semantics.
   */
  async reserveRepair(id: string, session: string, target: string, affected: string[], limit: number,
    preserved?: { id: string; revision: number }[]): Promise<void> {
    await this.table.update(id, (run) => {
      if (run.session !== session || run.outcome.state !== 'needs_attention' || (run.repairs?.length ?? 0) >= limit) {
        throw new RunError('Local repair requires an attention-required task with remaining repair allowance.')
      }
      return { ...run, revision: run.revision + 1, repairs: [...(run.repairs ?? []), { target, affected,
        ...(preserved === undefined ? {} : { preserved: structuredClone(preserved) }) }] }
    })
  }

  /** Cancel atomically; late validation and completion cannot resurrect the task.
   * @param id - registered task identity.
   * @param session - owning session.
   * @param reason - explicit host cancellation reason.
   */
  async cancel(id: string, session: string, reason: string): Promise<void> {
    if (!reason.trim()) throw new RunError('Cancellation needs an explicit reason.')
    await this.table.update(id, (run) => {
      if (run.session !== session || run.outcome.state === 'completed' || run.outcome.state === 'cancelled') {
        throw new RunError('Cancellation cannot change this task or its owner.')
      }
      return { ...run, revision: run.revision + 1, outcome: { state: 'cancelled', reason } }
    })
  }
}
