/** Candidate filtering never dispatches or retries provider requests. */
import { expect, it } from 'vitest'
import { selectRepairWorker } from '../src/worker-selection.ts'

it('records exclusions and selects the first eligible authorized route', () => {
  const base = { provider: 'registered', model: 'model', readOnlyTools: ['read'], capabilities: ['review'], enabled: true }
  const candidates = [
    { ...base, id: 'disabled', enabled: false },
    { ...base, id: 'wrong-role', capabilities: ['draft'] },
    { ...base, id: 'missing', provider: 'absent' },
    { ...base, id: 'reviewer' },
    { ...base, id: 'spare' },
  ]
  expect(selectRepairWorker(candidates, ['review'], new Set(['registered']))).toMatchInlineSnapshot(`
    {
      "decisions": [
        {
          "id": "disabled",
          "reason": "disabled",
        },
        {
          "id": "wrong-role",
          "reason": "capability-mismatch",
        },
        {
          "id": "missing",
          "reason": "provider-unavailable",
        },
        {
          "id": "reviewer",
          "reason": "selected",
        },
        {
          "id": "spare",
          "reason": "lower-preference",
        },
      ],
      "worker": {
        "capabilities": [
          "review",
        ],
        "enabled": true,
        "id": "reviewer",
        "model": "model",
        "provider": "registered",
        "readOnlyTools": [
          "read",
        ],
      },
    }
  `)
  expect(() => selectRepairWorker(candidates, ['unavailable'], new Set(['registered'])))
    .toThrow('No eligible authorized repair worker')
  const bounded = candidates.map(candidate => ({ ...candidate, maxActive: 1 }))
  const busy = selectRepairWorker(bounded, ['review'], new Set(['registered']), new Map([['reviewer', 1]]))
  expect(busy.worker.id).toBe('spare')
  expect(busy.decisions.find(decision => decision.id === 'reviewer')?.reason).toBe('capacity-full')
  expect(() => selectRepairWorker(bounded, ['review'], new Set(['registered']), new Map([['reviewer', 1], ['spare', 1]])))
    .toThrow('No eligible authorized repair worker')
})
