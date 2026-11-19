/** Roster projection: batch membership, field-level refresh, and live ages. */
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentsSnapshot } from '../src/client/agents.ts'
import type { SessionsListLike } from '../src/client/agents.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'

interface Child {
  readonly id: string
  readonly createdAt: number
  readonly label?: string
  readonly mode: string
  readonly running: boolean
  readonly title?: string
  readonly prompts?: readonly string[]
  readonly settledMs?: number
}

/** Build the sessions-list surface the roster reads, with mutable child facts. */
function listOf(children: Child[], parent = SessionId('parent')): SessionsListLike & { children: Child[]; listeners: Set<() => void> } {
  const listeners = new Set<() => void>()
  const state = { children }
  const snapshot = (): never => ({ children: state.children }) as never
  void snapshot
  return {
    children: state.children,
    listeners,
    getSnapshot: () => {
      const projectionsBySession: Record<string, unknown> = {}
      const byId: Record<string, unknown> = {}
      for (const child of state.children) {
        projectionsBySession[child.id] = { values: {
          subagentTiming: child.running ? { active: { since: 0 }, settledMs: child.settledMs ?? 0 } : { settledMs: child.settledMs ?? 0 },
          turnOutline: (child.prompts ?? []).map(prompt => ({ prompt })),
        } }
        byId[child.id] = { title: child.title }
      }
      projectionsBySession[parent] = { values: { subagentCatalog: state.children.map(child => ({
        id: child.id, createdAt: child.createdAt, mode: child.mode, ...child.label === undefined ? {} : { label: child.label },
      })) } }
      return { projectionsBySession, byId } as never
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

afterEach(() => { vi.useRealTimers() })

it('keeps a still-running child that is older than the batch window and drops settled strays', () => {
  const now = 1_000_000
  vi.useFakeTimers()
  vi.setSystemTime(now)
  const list = listOf([
    { id: 'old-running', createdAt: now - 600_000, mode: 'spawn', running: true },
    { id: 'old-settled', createdAt: now - 600_000, mode: 'spawn', running: false },
    { id: 'fresh', createdAt: now - 1_000, mode: 'fork', running: false },
  ])
  const roster = createAgentsSnapshot(list, SessionId('parent'))
  expect(roster.getSnapshot().rows.map(row => row.id)).toEqual(['old-running', 'fresh'])
  expect(roster.getSnapshot().total).toBe(3)
})

it('honours an explicit batch window', () => {
  const now = 2_000_000
  vi.useFakeTimers()
  vi.setSystemTime(now)
  const list = listOf([
    { id: 'just-outside', createdAt: now - 5_000, mode: 'spawn', running: false },
    { id: 'newest', createdAt: now, mode: 'spawn', running: false },
  ])
  const roster = createAgentsSnapshot(list, SessionId('parent'), { batchWindowMs: 4_000 })
  expect(roster.getSnapshot().rows.map(row => row.id)).toEqual(['newest'])
})

it('republishes when a rendered field changes without any id or running change', () => {
  const now = 3_000_000
  vi.useFakeTimers()
  vi.setSystemTime(now)
  const child: Child = { id: 'a', createdAt: now, mode: 'spawn', running: false, prompts: ['first'] }
  const list = listOf([child])
  const roster = createAgentsSnapshot(list, SessionId('parent'))
  const first = roster.getSnapshot()
  expect(first.rows[0]?.turns).toBe(1)
  expect(roster.getSnapshot()).toBe(first)
  list.children[0] = { ...child, prompts: ['first', 'second'], title: 'Renamed child' }
  const second = roster.getSnapshot()
  expect(second).not.toBe(first)
  expect(second.rows[0]?.turns).toBe(2)
  expect(second.rows[0]?.title).toBe('Renamed child')
  expect(roster.getSnapshot()).toBe(second)
})

it('advances ages while a child runs and stops the clock once everything settles', () => {
  vi.useFakeTimers()
  vi.setSystemTime(4_000_000)
  const child: Child = { id: 'a', createdAt: 4_000_000, mode: 'spawn', running: true }
  const list = listOf([child])
  const roster = createAgentsSnapshot(list, SessionId('parent'), { clockMs: 1_000 })
  const listener = vi.fn()
  const stop = roster.subscribe(listener)
  expect(roster.getSnapshot().now).toBe(4_000_000)
  vi.advanceTimersByTime(3_000)
  expect(listener).toHaveBeenCalledTimes(3)
  expect(roster.getSnapshot().now).toBe(4_003_000)
  expect(roster.getSnapshot().rows[0]?.createdAt).toBe(4_000_000)

  list.children[0] = { ...child, running: false, settledMs: 2_500 }
  listener.mockClear()
  vi.advanceTimersByTime(5_000)
  expect(listener).not.toHaveBeenCalled()
  stop()
})

it('reads current ages when a consumer subscribes long after the snapshot was built', () => {
  vi.useFakeTimers()
  vi.setSystemTime(5_000_000)
  const list = listOf([{ id: 'a', createdAt: 5_000_000, mode: 'spawn', running: false }])
  const roster = createAgentsSnapshot(list, SessionId('parent'))
  const stale = roster.getSnapshot()
  expect(stale.now).toBe(5_000_000)
  vi.setSystemTime(5_030_000)
  const stop = roster.subscribe(() => {})
  expect(roster.getSnapshot().now).toBe(5_030_000)
  stop()
})
