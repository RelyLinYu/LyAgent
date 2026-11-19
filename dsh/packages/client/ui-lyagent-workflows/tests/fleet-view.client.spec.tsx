// @vitest-environment jsdom
/** Fleet grouping keeps one run on one row and lands on the header. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FleetView } from '../src/client/FleetView.tsx'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

beforeEach(() => {
  // jsdom ships no scrollIntoView; the view calls it once per mount.
  Element.prototype.scrollIntoView = vi.fn()
})

const translate = (key: keyof typeof en, params?: Record<string, string>): string =>
  String(en[key] ?? key).replace(/\{(\w+)\}/g, (_match, name: string) => params?.[name] ?? `{${name}}`)

function fleetProps(catalog: readonly { id: string, createdAt: number, mode: string, label?: string }[],
  tasks: readonly { id: string, subject: string, status: 'pending' | 'in_progress' | 'completed' | 'deleted' }[] = []) {
  const projections: Record<string, unknown> = {
    subagentCatalog: catalog,
    agentTeam: { enabled: true, tasks },
  }
  const timings: Record<string, unknown> = Object.fromEntries(catalog.map(entry => [entry.id, {
    values: { subagentTiming: { settledMs: 2000 } },
  }]))
  return {
    t: translate,
    useProjection: (name: string) => projections[name],
    useSessions: (selector: (state: { projectionsBySession: typeof timings }) => unknown) =>
      selector({ projectionsBySession: timings }),
  } as unknown as Parameters<typeof FleetView>[0]
}

it('collapses one run into one row and expands it on demand', () => {
  const catalog = [
    { id: 'a1', createdAt: 1, mode: 'continuable', label: 'demo-schedule child 1' },
    { id: 'a2', createdAt: 2, mode: 'continuable', label: 'demo-schedule child 2' },
    { id: 'b1', createdAt: 3, mode: 'continuable', label: 'demo-verify child 1' },
  ]
  render(<FleetView {...fleetProps(catalog)} />)
  const toggles = screen.getAllByRole('button', { name: /demo-schedule|demo-verify/ })
  expect(toggles).toHaveLength(2)
  expect(screen.queryAllByRole('link')).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: /demo-schedule/ }))
  expect(screen.getAllByRole('link')).toHaveLength(2)
  fireEvent.click(screen.getByRole('button', { name: /demo-schedule/ }))
  expect(screen.queryAllByRole('link')).toHaveLength(0)
})

it('renders the graph with one node per run instead of one per member', () => {
  const catalog = [
    { id: 'a1', createdAt: 1, mode: 'continuable', label: 'demo-team child 1' },
    { id: 'a2', createdAt: 2, mode: 'continuable', label: 'demo-team child 2' },
    { id: 'a3', createdAt: 3, mode: 'continuable', label: 'demo-team child 3' },
  ]
  render(<FleetView {...fleetProps(catalog)} />)
  const nodes = document.querySelectorAll('[data-fleet-node]')
  expect(nodes).toHaveLength(1)
  expect(nodes[0]?.getAttribute('data-fleet-node')).toBe('demo-team')
  // The count appears once in the graph chip and once on the group row.
  expect(screen.getAllByText('×3')).toHaveLength(2)
})

it('scrolls the view into place when the seat opens', () => {
  const catalog = [{ id: 'a1', createdAt: 1, mode: 'continuable', label: 'demo-team child 1' }]
  render(<FleetView {...fleetProps(catalog)} />)
  expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'start' })
})

it('shows the empty-task copy when the board is off', () => {
  const view = fleetProps([], [])
  const props = { ...view, useProjection: (name: string) => name === 'agentTeam' ? { enabled: false, tasks: [] } : [] }
  render(<FleetView {...(props as Parameters<typeof FleetView>[0])} />)
  expect(screen.getByText(en.fleetTasksOff)).toBeTruthy()
})
