/** Publication receipts distinguish rejected writes from committed, protected bodies. */
import { expect, it } from 'vitest'
import { WorkflowLibrary, WorkflowLibraryError } from '../src/store.ts'
import { publishManagedPlan } from '../src/publication.ts'

const input = { id: 'outer', expectedVersion: 0, description: 'Protected', script: 'return "secret"',
  knowledge: [{ collection: 'rules', version: 1 }] }

type RecordValue = { editions: ReturnType<WorkflowLibrary['read']>[] }
function fixture(put: () => Promise<void>) {
  const records = new Map<string, RecordValue>()
  const library = new WorkflowLibrary({
    get: (id: string) => records.get(id), entries: () => records.entries(),
    put: async (id: string, value: RecordValue) => { await put(); records.set(id, value) },
  } as ConstructorParameters<typeof WorkflowLibrary>[0], 65536, 20)
  return library
}

it('rejects a queued publication after a revoke without committing its version', async () => {
  const writing = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const library = fixture(async () => { writing.resolve(undefined); await release.promise })
  const first = library.publish({ id: 'first', expectedVersion: 0, description: 'First', script: 'return 1', knowledge: [] }, 'human')
  await writing.promise
  let allowed = true
  const result = publishManagedPlan(library, input, () => {
    if (!allowed) throw new WorkflowLibraryError('revoked')
  })
  allowed = false
  release.resolve(undefined)
  await first
  await expect(result).rejects.toThrow('revoked')
  expect(library.list().map(entry => entry.id)).toEqual(['first'])
  await library.close()
})

it('acknowledges the committed version without its body after an in-flight revoke', async () => {
  let allowed = true
  const library = fixture(async () => { allowed = false })
  const result = await publishManagedPlan(library, input, () => {
    if (!allowed) throw new WorkflowLibraryError('revoked')
  })
  expect(result).toMatchObject({ id: 'outer', version: 1, publication: { state: 'committed', body: 'withheld' } })
  expect(JSON.stringify(result)).not.toContain('secret')
  expect(JSON.stringify(result)).not.toContain('rules')
  expect(library.list()[0]?.version).toBe(1)
  allowed = true
  expect(library.read('outer', 1).script).toBe(input.script)
  await expect(publishManagedPlan(library, input, () => {})).rejects.toThrow('Definition changed')
  await library.close()
})

it('returns the complete committed edition when access remains valid', async () => {
  const library = fixture(async () => {})
  const result = await publishManagedPlan(library, input, () => {})
  expect(result).toMatchObject({ id: 'outer', version: 1, script: input.script })
  await library.close()
})
