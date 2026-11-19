// @vitest-environment jsdom
/** The delegated-agent roster renders live ages, running state, and the batch total. */
import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { AgentsPanel } from '../src/client/AgentsPanel.tsx'
import type { AgentRoster } from '../src/client/agents.ts'
import { en } from '../src/client/locale.ts'

afterEach(cleanup)

function panelOf(roster: AgentRoster, openChild = vi.fn()) {
  const props = {
    t: (key: keyof typeof en): string => en[key],
    openChild,
    useAgents: (selector: (value: AgentRoster) => unknown) => selector(roster),
  } as Parameters<typeof AgentsPanel>[0]
  render(<AgentsPanel {...props} />)
  return openChild
}

it('shows the running count, the live age of a running child and the settled duration', () => {
  panelOf({
    total: 3,
    now: 1_000_000,
    rows: [
      { id: 'run', name: 'Scanner', mode: 'spawn', createdAt: 1_000_000 - 125_000, running: true, settledMs: 0, title: undefined, turns: 1, prompt: 'scan' },
      { id: 'done', name: 'Writer', mode: 'fork', createdAt: 1_000_000 - 400_000, running: false, settledMs: 90_000, title: 'Draft', turns: 2, prompt: 'write' },
    ],
  })
  expect(screen.getByText('1/2 · total 3')).toBeTruthy()
  expect(screen.getByText('2m5s')).toBeTruthy()
  expect(screen.getByText('1m30s')).toBeTruthy()
  expect(screen.getByText('Draft')).toBeTruthy()
})

it('opens the child conversation from its row', () => {
  const openChild = panelOf({
    total: 1, now: 0,
    rows: [{ id: 'child-1', name: 'Scanner', mode: 'spawn', createdAt: 0, running: false, settledMs: 1_000, title: undefined, turns: 1, prompt: 'scan' }],
  })
  fireEvent.click(screen.getByRole('button', { name: /Scanner/ }))
  expect(openChild).toHaveBeenCalledWith('child-1')
})

it('states the empty roster instead of an empty list', () => {
  panelOf({ total: 0, now: 0, rows: [] })
  expect(screen.getByText('No delegated agents in this conversation yet')).toBeTruthy()
})
