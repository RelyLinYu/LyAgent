/** A legacy edition cannot run, because its inlined excerpts cannot be re-authorised. */
import { expect, it } from 'vitest'
import { assertKnowledgePinned } from '../src/guards.ts'

it('admits both tracked provenances and refuses a legacy edition with a republish instruction', () => {
  expect(() => { assertKnowledgePinned('plan', { version: 2, knowledgeMode: 'managed' }) }).not.toThrow()
  expect(() => { assertKnowledgePinned('plan', { version: 3, knowledgeMode: 'human' }) }).not.toThrow()
  expect(() => { assertKnowledgePinned('plan', { version: 1 }) })
    .toThrow('Saved edition plan v1 predates knowledge tracking, so the dependencies of any excerpts it inlined cannot be re-authorised.')
  expect(() => { assertKnowledgePinned('plan', { version: 1 }) }).toThrow('Publish this definition again to run or read it.')
})
