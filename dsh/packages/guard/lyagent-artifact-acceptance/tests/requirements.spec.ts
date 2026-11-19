/** Human requirements are bounded data, not evaluator code or permission grants. */
import { expect, it } from 'vitest'
import { requirementsSchema } from '../src/requirements.ts'

it('accepts relative artifact checks and rejects ambiguous paths or executable configuration', () => {
  const rule = { path: 'reports/brief.md', minBytes: 1, maxBytes: 1000, includes: ['Friday'] }
  expect(requirementsSchema.parse([rule])).toEqual([rule])
  for (const path of ['../out.md', '/out.md', 'C:/out.md', 'a\\b.md', 'a//b.md', './out.md']) {
    expect(requirementsSchema.safeParse([{ ...rule, path }]).success).toBe(false)
  }
  expect(requirementsSchema.safeParse([{ ...rule, python: 'evil.py' }]).success).toBe(false)
  expect(requirementsSchema.safeParse([{ ...rule, maxBytes: 0 }]).success).toBe(false)
  expect(requirementsSchema.safeParse([rule, rule]).success).toBe(false)
  expect(requirementsSchema.safeParse([{ ...rule, includes: [''] }]).success).toBe(false)
})
