/** Conversation-owned task command mirror; uncertain mutations are never retried. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { z } from 'zod'

const pageSchema = z.object({ tasks: z.array(z.object({ id: z.string().min(1), objective: z.string(),
  state: z.enum(['queued', 'running', 'checking', 'needs_attention', 'cancelled', 'completed']),
  reason: z.string().max(2000).optional() })), next: z.string().optional() })
const criteriaSchema = z.object({ artifacts: z.array(z.object({ path: z.string(), minBytes: z.number(), maxBytes: z.number() })),
  minTests: z.number(), maxRepairs: z.number() })
interface State {
  page: z.infer<typeof pageSchema>
  criteria: z.infer<typeof criteriaSchema> | undefined
  loaded: boolean
  busy: boolean
  running: string | undefined
  cancelling: boolean
  error: boolean
  message: '' | 'registered' | 'settled' | 'cancelledAction'
}
/** Plain command transport bound to one native conversation. */
export interface TaskTransport { command: (input: string) => Promise<string> }
/** Narrow presentation data and explicit human actions. */
export interface TaskFace {
  hooks: { tasks: ObservableSnapshot<State> }
  refresh: (after?: string) => Promise<void>
  ensureLoaded: () => Promise<void>
  register: (objective: string, requirement?: { path: string; includes: string }) => Promise<boolean>
  run: (id: string) => Promise<void>
  cancel: (id: string) => Promise<void>
}
/** Own one task mirror and ignore completions after the panel plugin retires. */
export class TaskController {
  private readonly state = createSnapshotStore<State>({ page: { tasks: [] }, criteria: undefined,
    loaded: false, busy: false, running: undefined, cancelling: false, error: false, message: '' })
  private closed = false
  private get active(): boolean { return !this.closed }
  constructor(private readonly transport: TaskTransport) {}
  private async load(after?: string): Promise<void> {
    const page = pageSchema.parse(JSON.parse(await this.transport.command(after === undefined ? 'list' : `list ${after}`)))
    if (this.closed) return
    const criteria = criteriaSchema.parse(JSON.parse(await this.transport.command('criteria')))
    if (this.active) this.state.update((state) => { state.page = page; state.criteria = criteria; state.loaded = true })
  }
  private async operate(action: () => Promise<void>): Promise<boolean> {
    if (this.closed || this.state.getSnapshot().busy) return false
    this.state.update((state) => { state.busy = true; state.error = false; state.message = '' })
    try { await action(); return !this.closed } catch (_error: unknown) {
      // No rollback is inferred from a command or transport failure.
      if (this.active) this.state.update((state) => { state.error = true })
      return false
    } finally { if (this.active) this.state.update((state) => { state.busy = false; state.running = undefined }) }
  }
  /** Load this panel's mirror once per mount; commands can arrive before the conversation binds. */
  async ensureLoaded(): Promise<void> {
    for (const delay of [0, 150, 600, 1500]) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      if (this.closed || this.state.getSnapshot().loaded) return
      await this.operate(() => this.load())
      if (this.state.getSnapshot().loaded) return
    }
  }
  /** Retire local reads without cancelling or replaying host execution. */
  dispose(): void { this.closed = true }
  /** Expose this conversation's state and explicit actions without automatic mutation retry.
   * @returns conversation-bound state and zero-retry action callbacks.
   */
  face(): TaskFace {
    return { hooks: { tasks: this.state }, refresh: async (after) => { await this.operate(() => this.load(after)) },
      ensureLoaded: () => this.ensureLoaded(),
      register: (objective, requirement) => this.operate(async () => {
        if (!objective.trim()) throw new Error('A task objective is required')
        if (requirement !== undefined && requirement.includes.trim() && !requirement.path.trim()) {
          throw new Error('Literal checks require an artifact path')
        }
        if (requirement === undefined || !requirement.path.trim()) await this.transport.command(`new ${objective.trim()}`)
        else {
          const criteria = this.state.getSnapshot().criteria
          if (criteria === undefined || criteria.artifacts.length === 0) throw new Error('Load acceptance requirements first')
          await this.transport.command(`define ${JSON.stringify({ objective: objective.trim(), requirements: [{
            path: requirement.path.trim(), minBytes: 1, maxBytes: Math.max(...criteria.artifacts.map(file => file.maxBytes)),
            includes: requirement.includes.trim() ? requirement.includes.split('\n').filter(line => line.trim()) : [],
          }] })}`)
        }
        if (this.closed) return
        this.state.update((state) => { state.message = 'registered' })
        await this.load()
      }),
      run: async (id) => { await this.operate(async () => {
        this.state.update((state) => { state.running = id })
        await this.transport.command(`run ${id}`)
        if (this.closed) return
        this.state.update((state) => { state.message = 'settled' })
        await this.load()
      }) },
      cancel: async (id) => {
        if (this.closed || this.state.getSnapshot().cancelling) return
        this.state.update((state) => { state.cancelling = true; state.error = false })
        try {
          await this.transport.command(`cancel ${id}`)
          if (this.active) {
            this.state.update((state) => { state.message = 'cancelledAction' })
            if (!this.state.getSnapshot().busy) await this.load()
          }
        } catch (_error: unknown) {
          if (this.active) this.state.update((state) => { state.error = true })
        } finally { if (this.active) this.state.update((state) => { state.cancelling = false }) }
      },
    }
  }
}
