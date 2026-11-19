/** Explicit host task API; settlement reads committed native history after the owning turn ends. */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type {} from '@deepseek-ai/dsh-lyagent-knowledge'
import type {} from '@deepseek-ai/dsh-lyagent-budget'
import type { Context } from '@deepseek-ai/cordis'
import { symbols } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { FsError } from '@deepseek-ai/dsh-fs'
import { TOOL_OUTCOME_UNKNOWN } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-present/types'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-agent-team'
import type {} from '@deepseek-ai/dsh-session-projection'
import type { SubagentRunId } from '@deepseek-ai/dsh-subagent'
import { finalAssistantOutput } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { RunOwner, RunEvidence } from './run.ts'
import { RunError, RunLedger } from './run.ts'
import type { TestConfig } from './unittest.ts'
import { requirementsSchema } from './requirements.ts'
import { selectRepairWorker } from './worker-selection.ts'
import type { RepairCandidate } from './worker-selection.ts'
import type { TaskRequirements } from './requirements.ts'

/** Compare actual services rather than Cordis access-site proxies. */
function serviceIdentity(value: object | undefined): unknown {
  return value === undefined ? undefined : Reflect.get(value, symbols.original) ?? value
}

/** Host-owned task registration, explicit execution and durable settlement. */
export class TaskRuns {
  private readonly settling = new Set<string>()
  private readonly owners = new Map<string, { id: string; owner: RunOwner }>()
  private readonly starting = new Set<string>()
  private readonly deliveries = new Map<string, number>()
  private readonly executing = new Set<string>()
  private readonly repairing = new Set<string>()
  private readonly coordinating = new Set<string>()
  private readonly workerLoads = new Map<string, Map<string, number>>()
  private readonly executionWork = new Set<{ agent: Agent; done: Promise<void> }>()
  private closed = false
  private get isClosed(): boolean { return this.closed }
  private readonly budgetOwners = new Map<string, Context['lyagentBudget']>()
  private readonly teamOwners = new Map<string, Context['agentTeams']>()
  private readonly acceptedBoards = new Map<string, { id: string; revision: number }[]>()
  private readonly acceptedChildren = new Map<string, string>()
  private readonly childRuns = new Map<SubagentRunId, string>()
  private readonly childEvidence = new Map<string, { session: SessionId; after: number; local: boolean }[]>()
  private readonly childOwners = new Map<string, { service: Context['subagents'] | undefined; failed: boolean }>()
  constructor(private readonly ctx: Context, private readonly ledger: RunLedger, private readonly tests: TestConfig,
    private readonly maxRepairs: number, private readonly artifacts: readonly { path: string; minBytes: number; maxBytes: number }[],
    private readonly criteriaDigest: string, private readonly repairTargets: readonly {
      path: string
      workOrder: string
      candidates?: RepairCandidate[] | undefined
      requiredCapabilities?: string[] | undefined
      worker?: { provider: string; model: string; readOnlyTools: string[] } | undefined
    }[] = []) {
    ctx.on('subagent/start', (info) => {
      const parent = this.agents.get(info.parentSessionId)
      const service = ctx.get('subagents')
      if (parent !== undefined && service !== undefined) {
        const root = service.rootOf(parent).id
        this.childRuns.set(info.runId, root)
        const children = this.childEvidence.get(root)
        if (children !== undefined) {
          const child = this.agents.get(info.id)
          const open = child === undefined ? null : this.agents.turnBoundaryOf(child.session).openTurnStartSeq
          children.push({ session: info.id, after: open === null ? (child?.session.seq ?? 0) - 1 : open - 1,
            local: info.local })
        }
      }
    })
    ctx.on('subagent/end', (info) => {
      const root = this.childRuns.get(info.runId)
      this.childRuns.delete(info.runId)
      const owner = root === undefined ? undefined : this.childOwners.get(root)
      if (owner !== undefined && info.stopReason !== 'completed') owner.failed = true
    })
  }

  private get agents() {
    const agents = this.ctx.get('agents')
    if (agents === undefined) throw new RunError('Native agents are unavailable.')
    return agents
  }

  /** Read public acceptance requirements without evaluator paths or hidden test source.
   * @returns required artifact names and size bounds, test count and correction limits.
   */
  criteria(): { artifacts: { path: string; minBytes: number; maxBytes: number }[]; minTests: number; maxRepairs: number } {
    return { artifacts: this.artifacts.map(({ path, minBytes, maxBytes }) => ({ path, minBytes, maxBytes })),
      minTests: this.tests.minTests, maxRepairs: this.maxRepairs }
  }

  /** Read additional immutable human checks for the current task attempt.
   * @param agent - native delivery owner.
   * @returns additional rules, or none outside an owned task.
   */
  requirements(agent: Agent): TaskRequirements {
    const binding = this.owners.get(agent.id)
    return binding === undefined ? [] : this.ledger.read(binding.id)?.requirements ?? []
  }

  /** Record a host-detected artifact failure for the current owning attempt.
   * @param agent - native delivery owner.
   * @param path - configured artifact path.
   * @param reason - host-generated diagnostic, never model-selected work identity.
   */
  async rejected(agent: Agent, path: string, reason: string): Promise<void> {
    const binding = this.owners.get(agent.id)
    if (binding !== undefined) await this.ledger.reject(binding.id, binding.owner, path, reason)
  }

  /** Register a task before dispatch; does not bind an unrelated ordinary chat.
   * @param id - new host-owned task identity.
   * @param agent - native session that owns the task.
   * @param objective - explicit user-approved objective.
   * @param requirements - additional human artifact checks; omission retains deployment checks only.
   */
  async register(id: string, agent: Agent, objective: string, requirements?: TaskRequirements): Promise<void> {
    const checked = requirements === undefined ? undefined : requirementsSchema.parse(requirements)
    if (checked?.some(rule => rule.maxBytes > Math.max(...this.artifacts.map(file => file.maxBytes)))) {
      throw new RunError('Additional artifacts cannot exceed the deployment byte limit.')
    }
    const knowledge = this.ctx.get('lyagentKnowledge')
    const team = this.ctx.get('agentTeams')
    const board = this.ctx.get('sessionProjections')?.snapshot(agent.session, ['agentTeam']).values.agentTeam
    if (team !== undefined && (board === undefined || board.failure !== undefined)) {
      throw new RunError('Task registration requires a readable native task board.')
    }
    await this.ledger.create(id, agent.id, objective, knowledge?.snapshot(agent.id),
      team === undefined ? undefined : board?.tasks.map(task => task.id), this.criteriaDigest, checked)
  }

  /** Bind the task from an owning pre-step while a native turn is open.
   * Additional rules are available only for this owning task attempt.
   * @param id - registered task identity.
   * @param agent - live native owner.
   */
  async begin(id: string, agent: Agent): Promise<void> {
    if (this.owners.has(agent.id) || this.starting.has(agent.id)) throw new RunError('A task attempt already owns this session.')
    const turn = this.agents.turnBoundaryOf(agent.session).openTurnStartSeq
    if (turn === null) throw new RunError('Task attempts require an open native turn.')
    const run = this.ledger.read(id)
    const knowledge = this.ctx.get('lyagentKnowledge')
    if (run?.criteriaDigest !== undefined && run.criteriaDigest !== this.criteriaDigest) {
      throw new RunError('Acceptance criteria changed. Register a new task with the intended requirements.')
    }
    if (run?.knowledge !== undefined && (knowledge === undefined || !isDeepStrictEqual(run.knowledge, knowledge.snapshot(agent.id)))) {
      throw new RunError('Task source authorization changed. Register a new task with the intended sources.')
    }
    this.starting.add(agent.id)
    const budget = this.ctx.get('lyagentBudget')
    const team = this.ctx.get('agentTeams')
    try {
      if (run?.workOrders !== undefined && team === undefined) {
        throw new RunError('The task requires its registered native task board.')
      }
      const owner = await this.ledger.begin(id, agent.id, turn)
      this.owners.set(agent.id, { id, owner })
      this.deliveries.set(agent.id, 0)
      this.childOwners.set(agent.id, { service: this.ctx.get('subagents'), failed: false })
      this.childEvidence.set(agent.id, [])
      if (budget !== undefined) this.budgetOwners.set(agent.id, budget)
      if (team !== undefined) this.teamOwners.set(agent.id, team)
    } finally { this.starting.delete(agent.id) }
  }

  /** Bind only acceptance produced in this open attempt; missing tasks do not affect plain delivery.
   * @param agent - native owner starting another delivery attempt.
   */
  async invalidate(agent: Agent): Promise<void> {
    const binding = this.owners.get(agent.id)
    if (binding === undefined) return
    if (this.agents.turnBoundaryOf(agent.session).openTurnStartSeq !== binding.owner.turn) {
      throw new RunError('Delivery attempt belongs to another native turn.')
    }
    await this.ledger.invalidate(binding.id, binding.owner)
    this.acceptedBoards.delete(agent.id)
    this.acceptedChildren.delete(agent.id)
    const attempts = this.deliveries.get(agent.id) ?? 0
    if (attempts >= this.maxRepairs + 1) {
      agent.cancel({ kind: 'user' })
      throw new RunError('The task exhausted its configured local repair checks. Review the failed evidence before explicitly restarting.')
    }
    this.deliveries.set(agent.id, attempts + 1)
  }

  /** Bind only acceptance produced in this open attempt; missing tasks do not affect plain delivery.
   * @param agent - delivering native owner.
   * @param evidence - independent acceptance measurements.
   * @param children - exact serialized child outputs supplied to trusted tests.
   */
  async checked(agent: Agent, evidence: RunEvidence, children: string): Promise<void> {
    const binding = this.owners.get(agent.id)
    if (binding === undefined) return
    if (this.agents.turnBoundaryOf(agent.session).openTurnStartSeq !== binding.owner.turn) {
      throw new RunError('Delivery acceptance belongs to another native turn.')
    }
    const board = this.ctx.get('sessionProjections')?.snapshot(agent.session, ['agentTeam']).values.agentTeam
    if (board !== undefined && board.failure === undefined) {
      this.acceptedBoards.set(agent.id, board.tasks.map(task => ({ id: task.id, revision: task.revision })))
    } else this.acceptedBoards.delete(agent.id)
    await this.ledger.checked(binding.id, binding.owner, evidence)
    this.acceptedChildren.set(agent.id, children)
  }

  /** Read durable state; does not infer completion from agent status.
   *
   * @param id - registered task identity.
   * @returns detached durable task record, or undefined.
   */
  read(id: string): ReturnType<RunLedger['read']> { return this.ledger.read(id) }

  /** Browse task summaries for one native conversation without starting work.
   * @param agent - owning native session.
   * @param after - exclusive task cursor; absent starts the first page.
   * @returns bounded summaries and optional continuation identity.
   */
  list(agent: Agent, after?: string): ReturnType<RunLedger['list']> { return this.ledger.list(agent.id, after) }

  /** Execute an explicitly registered task through one native turn and await settlement.
   * Cancellation requests native stop and waits for root and child work; no retry is scheduled.
   * @param id - registered task identity owned by this session.
   * @param agent - exact idle native owner with no queued input.
   * @param signal - user-command cancellation, retained until settlement.
   */
  async execute(id: string, agent: Agent, signal: AbortSignal): Promise<void> {
    if (this.coordinating.has(agent.id)) throw new RunError('A coordinated task already owns this conversation.')
    if (this.closed) throw new RunError('The task runtime is closing.')
    const completion = Promise.withResolvers<undefined>()
    const operation = { agent, done: completion.promise }
    this.executionWork.add(operation)
    try { await this.executeOwned(id, agent, signal) } finally {
      this.executionWork.delete(operation)
      completion.resolve(undefined)
    }
  }

  /** Reopen only a failed completed work order and its dependency descendants; never dispatch models.
   * @param id - attention-required task identity.
   * @param agent - idle root owner.
   * @param target - native board work order selected for correction.
   * @param signal - optional cancellation before each durable board mutation; omission permits the full repair.
   * @returns identities conservatively invalidated by this explicit repair.
   */
  async repair(id: string, agent: Agent, target: string, signal?: AbortSignal): Promise<string[]> {
    if (this.coordinating.has(agent.id)) throw new RunError('A coordinated task already owns this conversation.')
    return this.repairOwned(id, agent, target, signal)
  }

  private async repairOwned(id: string, agent: Agent, target: string, signal?: AbortSignal): Promise<string[]> {
    signal?.throwIfAborted()
    if (this.closed || agent.status !== 'idle' || this.executing.has(agent.id) || this.repairing.has(agent.id)
      || this.owners.has(agent.id)
      || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) throw new RunError('Wait for idle before repairing work.')
    const team = this.ctx.get('agentTeams')
    if (team === undefined || !team.isEnabled(agent)) throw new RunError('Enable the native task board before repair.')
    this.repairing.add(agent.id)
    const completion = Promise.withResolvers<undefined>()
    const operation = { agent, done: completion.promise }
    this.executionWork.add(operation)
    try {
      const board = team.listTasks(agent)
      if (!board.some(task => task.id === target && task.status === 'completed')) {
        throw new RunError('Choose a completed work order whose result needs correction.')
      }
      const affected = new Set([target])
      let changed = true
      while (changed) {
        changed = false
        for (const task of board) if (!affected.has(task.id) && task.blockedBy.some(id => affected.has(id))) {
          affected.add(task.id); changed = true
        }
      }
      if (board.some(task => affected.has(task.id) && task.status === 'in_progress')) {
        throw new RunError('Stop affected work before local repair.')
      }
      const preserved = board.filter(task => !affected.has(task.id) && task.status === 'completed')
        .map(task => ({ id: task.id, revision: task.revision }))
      signal?.throwIfAborted()
      await this.ledger.reserveRepair(id, agent.id, target, [...affected], this.maxRepairs, preserved)
      for (const task of board) if (affected.has(task.id) && task.status === 'completed') {
        signal?.throwIfAborted()
        await team.updateTask(agent, { taskId: task.id, expectedRevision: task.revision, action: 'reopen' }, signal)
      }
      return [...affected]
    } finally {
      this.repairing.delete(agent.id)
      this.executionWork.delete(operation)
      completion.resolve(undefined)
    }
  }

  /** Execute bounded corrections selected only by trusted artifact-to-work-order mappings.
   * @param id - registered task identity.
   * @param agent - idle owning conversation.
   * @param signal - cancellation for the complete operation.
   */
  async coordinate(id: string, agent: Agent, signal: AbortSignal): Promise<void> {
    if (this.closed || this.coordinating.has(agent.id) || this.repairTargets.length === 0) {
      throw new RunError('Coordinated execution requires explicit host repair targets and an available conversation.')
    }
    this.coordinating.add(agent.id)
    const completion = Promise.withResolvers<undefined>()
    const operation = { agent, done: completion.promise }
    this.executionWork.add(operation)
    try {
      for (let attempt = 0; attempt <= this.maxRepairs; attempt++) {
        signal.throwIfAborted()
        if (this.isClosed) throw new RunError('The task runtime is closing.')
        await this.executeOwned(id, agent, signal)
        const run = this.ledger.read(id)
        if (run?.outcome.state !== 'needs_attention' || run.rejection?.repairable !== true
          || attempt === this.maxRepairs || (run.repairs?.length ?? 0) >= this.maxRepairs) return
        const target = this.repairTargets.find(target => target.path === run.rejection?.path)
        if (target === undefined) return
        signal.throwIfAborted()
        await this.repairOwned(id, agent, target.workOrder, signal)
      }
    } finally {
      this.coordinating.delete(agent.id)
      this.executionWork.delete(operation)
      completion.resolve(undefined)
    }
  }

  /** Stop admitted execution and await cleanup before its storage owner closes. */
  async close(): Promise<void> {
    this.closed = true
    const pending = [...this.executionWork]
    for (const operation of pending) operation.agent.cancel({ kind: 'user' })
    try { await this.ctx.get('subagents')?.drainDescendants(pending.map(operation => operation.agent)) } finally {
      await Promise.all(pending.map(operation => operation.done))
    }
  }

  private async executeOwned(id: string, agent: Agent, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    const run = this.ledger.read(id)
    if (run === undefined || run.session !== agent.id || !['queued', 'needs_attention'].includes(run.outcome.state)) {
      throw new RunError('Choose a queued task or explicitly resume a task that needs attention in its owning conversation.')
    }
    if (run.criteriaDigest !== undefined && run.criteriaDigest !== this.criteriaDigest) {
      throw new RunError('Acceptance criteria changed. Register a new task with the intended requirements.')
    }
    if (this.executing.has(agent.id) || this.repairing.has(agent.id) || this.owners.has(agent.id) || agent.status !== 'idle'
      || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0) {
      throw new RunError('Wait for the conversation and its queued input to settle before starting a task.')
    }
    if (this.ctx.get('lyagentBudget') === undefined) throw new RunError('Task execution requires explicit run budget accounting.')
    this.executing.add(agent.id)
    let begun = false
    const stop = agent.ctx.on('agent/pre-step', async ({ signal: stepSignal }, next) => {
      if (!begun) {
        await this.begin(id, agent)
        begun = true
        const decision = await next()
        const repair = run.repairs?.at(-1)
        const targets = repair === undefined ? [] : this.repairTargets.filter(target => target.workOrder === repair.target
          && (run.rejection === undefined || target.path === run.rejection.path))
        if (targets.length > 1) throw new RunError('Repair routing is ambiguous without a matching artifact rejection.')
        const target = targets[0]
        if (decision.kind === 'reject' || target === undefined || repair === undefined) return decision
        const llm = this.ctx.get('llm')
        let loads = this.workerLoads.get(target.path)
        if (loads === undefined) { loads = new Map(); this.workerLoads.set(target.path, loads) }
        if (target.candidates !== undefined && llm === undefined) throw new RunError('Repair candidate selection requires native LLM providers.')
        const selection = target.candidates === undefined ? undefined : selectRepairWorker(target.candidates,
          target.requiredCapabilities ?? [], new Set(llm?.listProviders().map(provider => provider.id) ?? []), loads)
        const worker = selection?.worker ?? target.worker
        if (worker === undefined) return decision
        const selectionText = selection === undefined ? ''
          : `Repair worker selection: ${JSON.stringify({ selected: selection.worker.id, decisions: selection.decisions })}\n`
        const subagents = this.ctx.get('subagents')
        if (subagents === undefined) throw new RunError('Configured repair worker requires native subagents.')
        const limit = this.tests.maxChildResultBytes
        if (limit === undefined) throw new RunError('Repair workers require an explicit child result byte limit.')
        const allowed = new Set(worker.readOnlyTools)
        const candidateId = selection?.worker.id
        const releaseGuard = this.ctx.tools.guard((execution) => {
          const child = execution.agent
          if (child === undefined || child.id === agent.id || subagents.rootOf(child).id !== agent.id
            || allowed.has(execution.name)) return undefined
          return { reason: 'Repair workers may only use configured read-only tools; return proposals to the parent.',
            info: { name: 'LyAgentRepairWorkerError', code: 'LYAGENT_REPAIR_READ_ONLY' } }
        })
        if (candidateId !== undefined) loads.set(candidateId, (loads.get(candidateId) ?? 0) + 1)
        const cleanup = { failed: false }
        try {
          const activation = await subagents.startActivation({ parent: agent, provider: 'spawn', delivery: 'caller',
            label: `Repair ${repair.target}`, signal: stepSignal,
            agentOptions: { provider: worker.provider, model: worker.model },
            prompt: [{ type: 'text', text: `${selectionText}${run.objective}\nReview only reopened work: ${repair.affected.join(', ')}. `
            + `Return a proposed correction for ${target.path}; do not modify workspace files. `
            + `Host rejection: ${JSON.stringify(run.rejection === undefined ? null
              : { path: run.rejection.path, reason: run.rejection.reason })}` }],
          })
          const interrupted = Promise.withResolvers<never>()
          const interrupt = (): void => { interrupted.reject(stepSignal.reason) }
          stepSignal.addEventListener('abort', interrupt, { once: true })
          try {
            stepSignal.throwIfAborted()
            const result = await Promise.race([activation.result, interrupted.promise])
            stepSignal.throwIfAborted()
            if (result.stopReason !== 'completed') throw new RunError('Repair worker did not complete; review its recorded results.')
            const proposal = JSON.stringify({ childId: activation.childId, output: result.output })
            if (Buffer.byteLength(proposal, 'utf8') > limit) {
              throw new RunError('Repair worker proposal exceeds the configured child result byte limit.')
            }
            return { ...decision, messages: [...decision.messages, createUserMessage({ source: { kind: 'user' },
              content: [{ type: 'text', text: `${selectionText}Repair worker ${activation.childId} proposed the following unverified correction. `
              + `Review it, update only reopened work and submit a fresh independently tested delivery:\n${proposal}` }],
            })] }
          } finally {
            stepSignal.removeEventListener('abort', interrupt)
            try { await activation.dispose() } catch (error) {
              cleanup.failed = true
              throw error
            }
          }
        } finally {
          if (!cleanup.failed) releaseGuard()
          if (!cleanup.failed && candidateId !== undefined) {
            const remaining = (loads.get(candidateId) ?? 1) - 1
            if (remaining === 0) loads.delete(candidateId)
            else loads.set(candidateId, remaining)
          }
        }
      }
      return next()
    })
    const cancel = (): void => { agent.cancel({ kind: 'user' }) }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      signal.throwIfAborted()
      const repair = run.repairs?.at(-1)
      const instruction = repair === undefined ? run.objective : `${run.objective}\n\nLocal repair scope: ${repair.affected.join(', ')}. `
        + `Correct work order ${repair.target} and its reopened dependents. Preserve unrelated completed work and artifacts. `
        + 'Read the current task board, complete only reopened work, and submit a fresh independently tested delivery.'
      const requirements = run.requirements?.length ? `\n\nAdditional required artifacts: ${JSON.stringify(run.requirements)}` : ''
      const rejection = repair !== undefined && run.rejection !== undefined
        ? `\n\nHost artifact rejection: ${JSON.stringify({ path: run.rejection.path, reason: run.rejection.reason })}` : ''
      agent.followup(createUserMessage({ content: [{ type: 'text', text: instruction + requirements + rejection }],
        source: { kind: 'user' } }))
      await agent.whenIdle()
      const subagents = this.ctx.get('subagents')
      while (subagents !== undefined && await subagents.waitForTreeWork(agent)) await agent.whenIdle()
      if (this.owners.get(agent.id)?.id !== id) {
        if (this.ledger.read(id)?.outcome.state === 'cancelled') return
        throw new RunError('The task did not acquire an owning native turn. Review the conversation before restarting.')
      }
      await this.settle(id, agent)
    } finally {
      signal.removeEventListener('abort', cancel)
      stop()
      this.executing.delete(agent.id)
    }
  }

  /** Finalize after the caller has awaited the owned turn, with fresh hashes and flushed native evidence.
   * @param id - registered task identity.
   * @param agent - same native session used at begin.
   */
  async settle(id: string, agent: Agent): Promise<void> {
    if (this.settling.has(agent.id)) throw new RunError('Task settlement is already in progress.')
    const binding = this.owners.get(agent.id)
    if (binding === undefined || binding.id !== id) throw new RunError('No live task attempt belongs to this session.')
    if (this.agents.turnBoundaryOf(agent.session).openTurnStartSeq !== null) throw new RunError('The native turn has not settled.')
    this.settling.add(agent.id)
    try { await this.settleOwned(id, agent, binding) } finally { this.settling.delete(agent.id) }
  }

  private async settleOwned(id: string, agent: Agent, binding: { id: string; owner: RunOwner }): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) throw new RunError('Native session persistence is unavailable.')
    await persistence.flush()
    const handle = await persistence.open(agent.id, 'read')
    try {
      const stored = await handle.read()
      const events = stored.events.filter(event => event.seq > binding.owner.turn)
      const end = events.find(event => event.type === 'turn/end')
      if (end?.type !== 'turn/end' || events.some(event => event.type === 'turn/start')) {
        throw new RunError('The owned turn ending is absent or later work has already started.')
      }
      const run = this.ledger.read(id)
      const pendingApprovals = new Set<string>()
      const pendingTools = new Set<string>()
      let toolsMatch = true
      let approvalsMatch = true
      for (const event of events) {
        if (event.seq >= end.seq) break
        if (event.type === 'tool/call') {
          if (pendingTools.has(event.data.callId)) toolsMatch = false
          pendingTools.add(event.data.callId)
        } else if (event.type === 'tool/result') {
          if (!pendingTools.delete(event.data.message.toolCallId) || event.data.error?.code === TOOL_OUTCOME_UNKNOWN) toolsMatch = false
        }
        if (event.type === 'approval/asked') {
          if (pendingApprovals.has(event.data.id)) approvalsMatch = false
          pendingApprovals.add(event.data.id)
        } else if (event.type === 'approval/decided' && !pendingApprovals.delete(event.data.id)) approvalsMatch = false
      }
      approvalsMatch &&= pendingApprovals.size === 0
      toolsMatch &&= pendingTools.size === 0
      const budget = this.budgetOwners.get(agent.id)
      const currentBudget = this.ctx.get('lyagentBudget')
      const budgetReady = budget === undefined ? currentBudget === undefined
        : serviceIdentity(currentBudget) === serviceIdentity(budget) && (await budget.seal(`${agent.id}:${binding.owner.turn}`)).ready
      let versionsMatch = false
      let deliveredCallId: string | undefined
      if (run?.outcome.state === 'checking') {
        const evidence = run.outcome.evidence
        const delivery = events.find(event => event.type === 'deliverables/presented'
          && event.data.callId === evidence.callId && event.data.turn === end.data.turn)
        const lastCall = events.filter(event => event.type === 'tool/call').at(-1)
        const result = events.find(event => event.type === 'tool/result'
          && event.data.message.toolCallId === evidence.callId && event.data.turn === end.data.turn)
        if (delivery?.type === 'deliverables/presented' && lastCall?.type === 'tool/call'
          && lastCall.data.name === 'present' && lastCall.data.callId === evidence.callId
          && result?.type === 'tool/result' && result.data.message.isError === false) deliveredCallId = evidence.callId
        const cwd = await this.ctx.workingDirectory.ensure(agent)
        versionsMatch = true
        const maxBytes = Math.max(...this.artifacts.map(file => file.maxBytes),
          ...(run.requirements ?? []).map(file => file.maxBytes))
        try {
          for (const file of evidence.artifacts) {
            const target = await this.ctx.fs.resolve(file.path, { cwd })
            const before = await this.ctx.fs.stat(target)
            if (before?.type !== 'file') { versionsMatch = false; break }
            if (before.size === undefined || !Number.isSafeInteger(before.size) || before.size < 0) { versionsMatch = false; break }
            if (before.size > maxBytes) { versionsMatch = false; break }
            const bytes = await this.ctx.fs.readBytes(target, undefined, before.size)
            const after = await this.ctx.fs.stat(target)
            if (before.version !== after?.version || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
              versionsMatch = false; break
            }
          }
          for (const file of evidence.evaluators) {
            const target = await this.ctx.fs.resolve(file.path, { cwd: this.tests.root })
            const before = await this.ctx.fs.stat(target)
            if (before?.type !== 'file' || before.size === undefined || !Number.isSafeInteger(before.size) || before.size < 0) {
              versionsMatch = false; break
            }
            const bytes = await this.ctx.fs.readBytes(target, undefined, before.size)
            if ((await this.ctx.fs.stat(target))?.version !== before.version) { versionsMatch = false; break }
            if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) { versionsMatch = false; break }
          }
        } catch (error) {
          if (!(error instanceof FsError)) throw error
          versionsMatch = false
        }
      }
      const knowledge = this.ctx.get('lyagentKnowledge')
      const team = this.teamOwners.get(agent.id)
      const currentTeam = this.ctx.get('agentTeams')
      let repairBoardReady = run?.workOrders === undefined && team === undefined && currentTeam === undefined
      let teamReady = run?.workOrders === undefined && team === undefined && currentTeam === undefined
      if (team !== undefined && serviceIdentity(currentTeam) === serviceIdentity(team)) {
        const projections = this.ctx.get('sessionProjections')
        if (projections !== undefined) {
          const board = projections.snapshot(agent.session, ['agentTeam']).values.agentTeam
          repairBoardReady = board !== undefined && board.failure === undefined
            && (run?.workOrders ?? []).every(id => board.tasks.some(task => task.id === id))
            && (run?.repairs?.at(-1)?.preserved ?? []).every(pin =>
              board.tasks.some(task => task.id === pin.id && task.revision === pin.revision && task.status === 'completed'))
            && !events.some(event => event.type === 'team/task' && event.data.task.status === 'deleted')
          teamReady = board !== undefined && board.failure === undefined && board.tasks.every(task => task.status === 'completed')
            && isDeepStrictEqual(this.acceptedBoards.get(agent.id), board.tasks.map(task => ({ id: task.id, revision: task.revision })))
            && (run?.workOrders ?? []).every(id => board.tasks.some(task => task.id === id && task.status === 'completed'))
            && (run?.repairs?.at(-1)?.preserved ?? []).every(pin =>
              board.tasks.some(task => task.id === pin.id && task.revision === pin.revision && task.status === 'completed'))
            && !events.some(event => event.type === 'team/task' && event.data.task.status === 'deleted')
        }
      }
      const sourcesMatch = run?.knowledge === undefined
        || (knowledge !== undefined && isDeepStrictEqual(run.knowledge, knowledge.snapshot(agent.id)))
      const children = this.childOwners.get(agent.id)
      const childMeasurement = await this.measureChildren(agent, false)
      const childrenReady = children !== undefined && !children.failed
        && childMeasurement !== undefined && this.acceptedChildren.get(agent.id) === childMeasurement
        && ![...this.childRuns.values()].includes(agent.id)
        && serviceIdentity(children.service) === serviceIdentity(this.ctx.get('subagents'))
      const failureReasons: string[] = []
      if (end.data.reason.kind !== 'completed') failureReasons.push('the native turn did not complete')
      if (deliveredCallId === undefined) failureReasons.push('no final committed independently accepted delivery')
      if (!versionsMatch) failureReasons.push('artifact or evaluator versions are unverified or changed')
      if (!sourcesMatch) failureReasons.push('knowledge authorization or source versions changed')
      if (!budgetReady || serviceIdentity(this.ctx.get('lyagentBudget')) !== serviceIdentity(currentBudget)) {
        failureReasons.push('budget usage is unsettled, over limit or its service changed')
      }
      if (!approvalsMatch) failureReasons.push('approval records are incomplete or inconsistent')
      if (!toolsMatch) failureReasons.push('tool results are missing, inconsistent or unknown')
      if (!teamReady) failureReasons.push('required work orders are incomplete, changed or unavailable')
      if (!childrenReady) failureReasons.push('child work is active, failed or lacks matching persisted acceptance')
      if (this.agents.turnBoundaryOf(agent.session).lastTurn !== end.data.turn) {
        failureReasons.push('newer conversation work invalidated this attempt')
      }
      await this.ledger.settle(id, binding.owner, { end: end.data.reason.kind === 'completed' ? 'completed'
        : end.data.reason.kind === 'aborted' ? 'aborted' : 'other', deliveredCallId,
      failureReasons,
      versionsMatch: versionsMatch && sourcesMatch && budgetReady && approvalsMatch && toolsMatch && teamReady && childrenReady
        && serviceIdentity(this.ctx.get('lyagentBudget')) === serviceIdentity(currentBudget)
        && this.agents.turnBoundaryOf(agent.session).lastTurn === end.data.turn,
      expectedRevision: run?.revision,
      repairable: end.data.reason.kind === 'completed' && budgetReady && approvalsMatch && toolsMatch && sourcesMatch
        && repairBoardReady
        && childMeasurement !== undefined && children !== undefined && !children.failed
        && ![...this.childRuns.values()].includes(agent.id)
        && serviceIdentity(children.service) === serviceIdentity(this.ctx.get('subagents'))
        && serviceIdentity(this.ctx.get('lyagentBudget')) === serviceIdentity(currentBudget)
        && this.agents.turnBoundaryOf(agent.session).lastTurn === end.data.turn })
      this.owners.delete(agent.id)
      this.budgetOwners.delete(agent.id)
      this.teamOwners.delete(agent.id)
      this.acceptedBoards.delete(agent.id)
      this.acceptedChildren.delete(agent.id)
      this.childOwners.delete(agent.id)
      this.childEvidence.delete(agent.id)
      this.deliveries.delete(agent.id)
    } finally { await handle.close() }
  }

  /** Read exact local child outputs for independent evaluation and final comparison.
   * @param agent - root task owner.
   * @param flush - flush native persistence before reading; settlement already flushed it.
   * @returns serialized measurements, or undefined for incomplete or unbounded child evidence.
   */
  async measureChildren(agent: Agent, flush: boolean): Promise<string | undefined> {
    if (flush) await this.ctx.get('sessionPersistence')?.flush()
    return this.readChildren(agent.id)
  }

  private async readChildren(root: string): Promise<string | undefined> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined || [...this.childRuns.values()].includes(root)) return undefined
    const measurements: { session: string; output: readonly import('@deepseek-ai/dsh-llm').ContentBlock[]; sha256: string }[] = []
    for (const child of this.childEvidence.get(root) ?? []) {
      if (!child.local || this.tests.maxChildResultBytes === undefined) return undefined
      const handle = await persistence.open(child.session, 'read')
      try {
        const events = (await handle.read()).events.filter(event => event.seq > child.after)
        const tools = new Set<string>()
        const approvals = new Set<string>()
        let turns = 0
        let ended = false
        for (const event of events) {
          if (event.type === 'turn/start') { turns++; ended = false }
          if (event.type === 'turn/end') {
            if (turns < 1 || event.data.reason.kind !== 'completed') return undefined
            turns--; ended = true
          }
          if (event.type === 'tool/call') {
            if (tools.has(event.data.callId)) return undefined
            tools.add(event.data.callId)
          }
          if (event.type === 'tool/result' && (!tools.delete(event.data.message.toolCallId)
            || event.data.error?.code === TOOL_OUTCOME_UNKNOWN)) return undefined
          if (event.type === 'approval/asked') {
            if (approvals.has(event.data.id)) return undefined
            approvals.add(event.data.id)
          }
          if (event.type === 'approval/decided' && !approvals.delete(event.data.id)) return undefined
        }
        if (!ended || turns !== 0 || tools.size > 0 || approvals.size > 0) return undefined
        const output = finalAssistantOutput(events)
        if (output === undefined) return undefined
        measurements.push({ session: child.session, output, sha256: createHash('sha256').update(JSON.stringify(output)).digest('hex') })
        if (Buffer.byteLength(JSON.stringify(measurements), 'utf8') > this.tests.maxChildResultBytes) return undefined
      } finally { await handle.close() }
    }
    return JSON.stringify(measurements)
  }

  /** Cancel state before the host requests native cancellation; pending checks cannot complete it.
   * @param id - registered task identity.
   * @param agent - owning session.
   * @param reason - explicit cancellation explanation.
   */
  async cancel(id: string, agent: Agent, reason: string): Promise<void> {
    await this.ledger.cancel(id, agent.id, reason)
    if (this.owners.get(agent.id)?.id === id) {
      this.owners.delete(agent.id)
      this.budgetOwners.delete(agent.id)
      this.teamOwners.delete(agent.id)
      this.acceptedBoards.delete(agent.id)
      this.acceptedChildren.delete(agent.id)
      this.childOwners.delete(agent.id)
      this.childEvidence.delete(agent.id)
      this.deliveries.delete(agent.id)
    }
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { lyagentTaskRuns: TaskRuns }
}
