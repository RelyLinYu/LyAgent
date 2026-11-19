/** Session-owned command adapter; ambiguous mutations are never retried automatically. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { z } from 'zod'

const pageSchema = z.object({ collections: z.array(z.object({ collection: z.string(), title: z.string(),
  archived: z.boolean(), versions: z.array(z.number().int().positive()) })), next: z.string().optional() })
const grantSchema = z.object({
  pins: z.array(z.object({ collection: z.string(), version: z.number().int().positive() })), truncated: z.boolean(),
})
type Page = z.infer<typeof pageSchema>
type Grants = z.infer<typeof grantSchema>
interface State { page: Page; grants: Grants; loaded: boolean; busy: boolean; error: boolean; saved: boolean }
/** Plain adapter callbacks; commands return text only after native lifecycle settlement. */
export interface KnowledgeTransport {
  command: (input: string, files?: readonly File[]) => Promise<string>
}
/** Render inputs and event actions for one session; model and transport objects never reach React. */
export interface KnowledgeFace {
  hooks: { knowledge: ObservableSnapshot<State> }
  refresh: (after?: string) => Promise<void>
  ensureLoaded: () => Promise<void>
  importFiles: (collection: string, title: string, files: readonly File[]) => Promise<void>
  grant: (collection: string, version: number) => Promise<void>
  revoke: () => Promise<void>
  archive: (collection: string) => Promise<void>
}
/** Create the one session's knowledge mirror and retire its pending completions on disposal. */
export class KnowledgeController {
  private readonly state = createSnapshotStore<State>({ page: { collections: [] }, grants: { pins: [], truncated: false },
    loaded: false, busy: false, error: false, saved: false })
  private closed = false
  constructor(private readonly transport: KnowledgeTransport) {}
  private isOpen(): boolean { return !this.closed }
  private async operate(operation: () => Promise<void>): Promise<void> {
    if (this.closed || this.state.getSnapshot().busy) return
    this.state.update((state) => { state.busy = true; state.error = false; state.saved = false })
    try { await operation() } catch (_error: unknown) {
      // The visible failure keeps the previous mirror; mutations may already have committed.
      if (this.isOpen()) this.state.update((state) => { state.error = true })
    } finally { if (this.isOpen()) this.state.update((state) => { state.busy = false }) }
  }
  private async load(after?: string): Promise<void> {
    if (!this.isOpen()) return
    const page = pageSchema.parse(JSON.parse(await this.transport.command(after === undefined ? 'catalog' : `catalog ${after}`)))
    if (!this.isOpen()) return
    const grants = grantSchema.parse(JSON.parse(await this.transport.command('list')))
    if (!this.closed) this.state.update((state) => { state.page = page; state.grants = grants; state.loaded = true })
  }
  /** Retire the mirror without retrying or inferring rollback of pending operations. */
  dispose(): void { this.closed = true }
  /** Expose the session mirror and human management actions.
   * @returns observable state and session-bound event actions.
   */
  /** Load this panel's mirror once per mount; commands can arrive before the conversation binds. */
  async ensureLoaded(): Promise<void> {
    for (const delay of [0, 150, 600, 1500]) {
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay))
      if (this.closed || this.state.getSnapshot().loaded) return
      await this.operate(() => this.load())
      if (this.state.getSnapshot().loaded) return
    }
  }
  face(): KnowledgeFace {
    return { hooks: { knowledge: this.state },
      refresh: after => this.operate(() => this.load(after)),
      ensureLoaded: () => this.ensureLoaded(),
      importFiles: (collection, title, files) => this.operate(async () => {
        await this.transport.command(`import ${collection} ${title}`, files)
        await this.load()
        if (!this.closed) this.state.update((state) => { state.saved = true })
      }),
      grant: (collection, version) => this.operate(async () => {
        const current = grantSchema.parse(JSON.parse(await this.transport.command('list')))
        if (!this.isOpen()) return
        if (current.truncated) throw new Error('Grant list is incomplete')
        const pins = [...current.pins.filter(pin => pin.collection !== collection), { collection, version }]
        await this.transport.command(`grant ${JSON.stringify(pins)}`)
        await this.load()
      }),
      revoke: () => this.operate(async () => { await this.transport.command('revoke'); await this.load() }),
      archive: collection => this.operate(async () => { await this.transport.command(`archive ${collection}`); await this.load() }),
    }
  }
}
