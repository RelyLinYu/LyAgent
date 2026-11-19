/** Managed publication receipts separate storage commitment from permission to disclose the body. */
import type { z } from 'zod'
import { WorkflowLibraryError } from './store.ts'
import type { WorkflowLibrary, WorkflowEdition, publicationSchema } from './store.ts'

/** Publish a compiled plan with admission inside the serialized write queue.
 * @param library - durable publication owner.
 * @param input - compiled plan and its complete recorded knowledge dependencies.
 * @param authorize - synchronous permission check; a rejection before storage commits no version.
 * @returns full edition, or a body-free committed receipt if permission is lost while storage writes.
 */
export async function publishManagedPlan(library: WorkflowLibrary, input: z.infer<typeof publicationSchema>,
  authorize: () => void): Promise<({ id: string } & WorkflowEdition) | {
    id: string
    version: number
    sha256: string
    publication: { state: 'committed'; body: 'withheld'; reason: 'knowledge-access-changed' }
  }> {
  const edition = await library.publish(input, 'managed', authorize)
  try { authorize() } catch (error: unknown) {
    if (!(error instanceof WorkflowLibraryError)) throw error
    return { id: input.id, version: edition.version, sha256: edition.sha256,
      publication: { state: 'committed', body: 'withheld', reason: 'knowledge-access-changed' } }
  }
  return { id: input.id, ...edition }
}
