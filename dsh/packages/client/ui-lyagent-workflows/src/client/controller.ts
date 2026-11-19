/** Session-bound catalog mirror; uncertain writes stop without retry. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { z } from 'zod'

const workflow = z.object({ id: z.string(), version: z.number().int().positive(), description: z.string() })
const team = workflow.extend({ kind: z.enum(['profile', 'team']) })
const member = z.object({ role: z.string(), profile: z.object({ id: z.string(), version: z.number().int().positive() }) })
const description = z.object({ description: z.string() })
const profileDefinition = description.extend({ kind: z.literal('profile'), instructions: z.string(),
  provider: z.string(), model: z.string(), enabled: z.boolean() })
const teamDefinition = description.extend({ kind: z.literal('team'), members: z.array(member) })
const scriptDefinition = description.extend({ script: z.string() })
interface State {
  workflows: z.infer<typeof workflow>[]
  teams: z.infer<typeof team>[]
  busy: boolean
  error: boolean
  loaded: boolean
  saved: boolean
}
/** Narrow management callbacks, bound to the current session by the plugin. */
export interface WorkflowDraft {
  kind: 'profile' | 'team' | 'workflow'
  id: string
  version: number
  latestVersion: number
  name: string
  instructions: string
  provider: string
  model: string
  enabled: boolean
  script: string
  members: { key: string; role: string; profile: { id: string; version: number } }[]
  dirty: boolean
}
/** Session-bound catalog state and explicit management actions exposed to the panel. */
export interface WorkflowFace {
  readDraft: () => WorkflowDraft | undefined
  retainDraft: (draft: WorkflowDraft) => void
  hooks: { catalog: ObservableSnapshot<State> }
  refresh: () => Promise<void>
  ensureLoaded: () => Promise<void>
  save: (kind: 'profile' | 'team' | 'workflow', id: string, expectedVersion: number, definition: Record<string, unknown>) => Promise<boolean>
  run: (id: string, version: number) => Promise<boolean>
  read: (kind: 'profile' | 'team' | 'workflow', id: string, version: number) => Promise<Record<string, unknown> | undefined>
}
/** Own the session's catalog and ignore completions after disposal. */
export class WorkflowController {
  private closed = false
  private draft: WorkflowDraft | undefined
  private isClosed(): boolean { return this.closed }
  private readonly state = createSnapshotStore<State>({ workflows: [], teams: [], busy: false, error: false, loaded: false, saved: false })
  constructor(private readonly command: (input: string) => Promise<string>) {}
  private async load(): Promise<void> {
    const catalog = z.object({ workflows: z.array(workflow), teams: z.array(team) })
      .parse(JSON.parse(await this.command('catalog')))
    if (this.closed) return
    const { workflows, teams } = catalog
    if (!this.isClosed()) this.state.update((state) => { state.workflows = workflows; state.teams = teams; state.loaded = true })
  }
  private async operate(action: () => Promise<void>): Promise<boolean> {
    if (this.closed || this.state.getSnapshot().busy) return false
    this.state.update((state) => { state.busy = true; state.error = false; state.saved = false })
    try { await action(); return !this.closed } catch (_error: unknown) {
      // A command may have committed before transport failure; preserve the mirror and require refresh.
      if (!this.isClosed()) this.state.update((state) => { state.error = true })
      return false
    } finally { if (!this.isClosed()) this.state.update((state) => { state.busy = false }) }
  }
  /** Retire pending mirror completions without replaying commands. */
  dispose(): void { this.closed = true }
  /** Load the catalog once per panel mount; commands can arrive before the conversation binds. */
  async ensureLoaded(): Promise<void> {
    for (const delay of [0, 150, 600, 1500]) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      if (this.closed || this.state.getSnapshot().loaded) return
      await this.operate(() => this.load())
      if (this.state.getSnapshot().loaded) return
    }
  }
  /** Expose reactive catalog and human actions.
   * @returns framework-bound snapshot source and command callbacks.
   */
  face(): WorkflowFace {
    return { readDraft: () => this.draft === undefined ? undefined : structuredClone(this.draft),
      retainDraft: (draft) => { if (!this.isClosed()) this.draft = structuredClone(draft) },
      hooks: { catalog: this.state }, refresh: async () => { await this.operate(() => this.load()) },
      ensureLoaded: () => this.ensureLoaded(),
      save: (kind, id, expectedVersion, definition) => this.operate(async () => {
        const input = kind === 'workflow' ? `publish ${JSON.stringify({ id, expectedVersion, ...definition })}`
          : `publish-team ${JSON.stringify({ id, expectedVersion, definition: { kind, ...definition } })}`
        await this.command(input)
        if (this.closed) return
        // Acknowledged publication must advance the editor even if catalog refresh fails.
        try { await this.load() } catch (_error: unknown) {
          if (!this.isClosed()) this.state.update((state) => { state.error = true })
        }
        if (!this.isClosed()) this.state.update((state) => { state.saved = true })
      }),
      run: (id, version) => this.operate(async () => { await this.command(`run ${id} ${version}`) }),
      read: async (kind, id, version) => {
        let result: Record<string, unknown> | undefined
        await this.operate(async () => {
          const record = z.record(z.string(), z.unknown()).parse(JSON.parse(await this.command(`${kind === 'workflow' ? 'read' : 'read-team'} ${id} ${version}`)))
          const parsed = kind === 'workflow' ? scriptDefinition.parse(record)
            : (kind === 'profile' ? profileDefinition : teamDefinition).parse(record.definition)
          if (!this.isClosed()) result = parsed
        })
        return result
      },
    }
  }
}
