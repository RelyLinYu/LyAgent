/** Delegated-agent roster derived from the parent session's child catalog. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-session-turn-outline/types'

/** Snapshot of the newest delegation batch plus the session-wide total. */
export interface AgentRoster {
  readonly rows: readonly AgentRow[]
  readonly total: number
  /**
   * The clock reading every row age is measured against. It advances on the
   * roster's own cadence while a child is running, so ages stay live without
   * rebuilding rows or rescanning the catalog.
   */
  readonly now: number
}

/** One delegated child with host timing and latest prompt metadata. */
export interface AgentRow {
  readonly id: string
  readonly name: string
  readonly mode: string
  /** Creation time on the host clock; the roster's `now` turns it into an age. */
  readonly createdAt: number
  /** Whether the child's own turn is open right now. */
  readonly running: boolean
  /** Milliseconds accumulated by finished turns, open turn excluded. */
  readonly settledMs: number
  /** The child conversation's title, when the host published one. */
  readonly title: string | undefined
  /** Completed plus open turns, and the newest prompt preview. */
  readonly turns: number
  readonly prompt: string
}

/** Sessions-list surface this projection needs. */
export interface SessionsListLike {
  readonly getSnapshot: () => SessionListState
  readonly subscribe: (listener: () => void) => () => void
}

/** Roster presentation tunables owned by the plugin's Config. */
export interface AgentsSnapshotOptions {
  /**
   * How far back from the newest child a settled child still counts as part of
   * the current batch. A child that is still running is always listed, however
   * old its batch is.
   */
  readonly batchWindowMs?: number
  /** How often the roster clock advances while a child is running. */
  readonly clockMs?: number
}

/**
 * Build the roster snapshot for one parent session.
 * @param list - live sessions list.
 * @param sessionId - the conversation whose children are listed.
 * @param options - batch window and clock cadence, both resolved by the caller's Config.
 * @returns a snapshot whose value only changes when the catalog, a row field, or its clock moves.
 */
export function createAgentsSnapshot(
  list: SessionsListLike,
  sessionId: SessionId,
  options: AgentsSnapshotOptions = {},
): ObservableSnapshot<AgentRoster> {
  const batchWindowMs = options.batchWindowMs ?? 90_000
  const clockMs = options.clockMs ?? 1_000
  let stamp = Date.now()
  let cached: AgentRoster = { rows: [], total: 0, now: stamp }
  let signature: string | undefined

  /** Every field a row renders, so a change to any of them republishes the roster. */
  const signatureOf = (rows: readonly AgentRow[], total: number): string => JSON.stringify([total, rows])

  const read = (): AgentRoster => {
    const state = list.getSnapshot()
    const catalog = state.projectionsBySession[sessionId]?.values.subagentCatalog ?? []
    // A child is running while its own turn is open; a closed turn carries no `active`.
    const runningOf = (id: string): boolean =>
      state.projectionsBySession[id as SessionId]?.values.subagentTiming?.active !== undefined
    const newest = catalog.reduce((max, entry) => Math.max(max, entry.createdAt), 0)
    const batch = catalog.filter(entry => runningOf(entry.id) || newest - entry.createdAt <= batchWindowMs)
    const rows = batch.map((entry): AgentRow => ({
      id: entry.id,
      name: entry.label ?? ('name' in entry ? entry.name : undefined) ?? entry.id.slice(0, 8),
      mode: entry.mode,
      createdAt: entry.createdAt,
      running: runningOf(entry.id),
      settledMs: state.projectionsBySession[entry.id]?.values.subagentTiming?.settledMs ?? 0,
      title: state.byId[entry.id]?.title,
      turns: state.projectionsBySession[entry.id]?.values.turnOutline?.length ?? 0,
      prompt: state.projectionsBySession[entry.id]?.values.turnOutline?.at(-1)?.prompt ?? '',
    }))
    const next = signatureOf(rows, catalog.length)
    if (next === signature && cached.now === stamp) return cached
    signature = next
    cached = { rows, total: catalog.length, now: stamp }
    return cached
  }

  return {
    getSnapshot: read,
    subscribe: (listener) => {
      // A consumer that mounts later than the snapshot was created still reads current ages.
      stamp = Date.now()
      const off = list.subscribe(listener)
      const timer = setInterval(() => {
        if (!read().rows.some(row => row.running)) return
        stamp = Date.now()
        listener()
      }, clockMs)
      return () => {
        off()
        clearInterval(timer)
      }
    },
  }
}
