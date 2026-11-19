/** Reviewed replacement plans append through normal publication; legacy scripts are never upgraded by relabeling. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { compilePlan, planPublicationSchema } from './plan.ts'
import { WorkflowLibrary, WorkflowLibraryError } from './store.ts'
import type { WorkflowEdition } from './store.ts'

/** A source digest pins the reviewed predecessor; the plan explicitly replaces rather than restores it. */
export const migrationSchema = z.object({
  sourceVersion: z.number().int().positive(), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  plan: planPublicationSchema,
}).strict()

/** Compile and append one reviewed replacement, or verify that an identical replacement already exists.
 * @param library - publication owner, including immutable predecessor history.
 * @param input - exact predecessor and replacement plan; expectedVersion must equal sourceVersion.
 * @param readTeam - fixed team/profile lookup used by role nodes.
 * @param maxParallel - configured node concurrency.
 * @param search - caller-authorized knowledge retrieval.
 * @param authorize - permission check repeated inside the serialized commit.
 * @param dryRun - compile and validate without writing when true.
 * @returns complete candidate edition and whether it already exists, was committed, or is only proposed.
 */
export async function migratePlan(library: WorkflowLibrary, input: z.infer<typeof migrationSchema>,
  readTeam: Parameters<typeof compilePlan>[2], maxParallel: number,
  search: Parameters<typeof compilePlan>[4], authorize: (edition: Pick<WorkflowEdition, 'knowledge'>) => void,
  dryRun: boolean): Promise<{ state: 'proposed' | 'committed' | 'existing'; id: string; edition: WorkflowEdition }> {
  const request = migrationSchema.parse(input)
  if (request.plan.expectedVersion !== request.sourceVersion) throw new WorkflowLibraryError('Migration expectedVersion must match its reviewed sourceVersion.')
  const source = library.read(request.plan.id, request.sourceVersion)
  if (source.sha256 !== request.sourceSha256) throw new WorkflowLibraryError('Migration source digest changed; review the predecessor again.')
  const compiled = compilePlan(request.plan, (id, version) => {
    const nested = library.read(id, version)
    authorize(nested)
    return nested
  }, readTeam, maxParallel, search)
  authorize(compiled)
  const sha256 = createHash('sha256').update(compiled.script).digest('hex')
  const candidate: WorkflowEdition = { version: source.version + 1, description: compiled.description,
    script: compiled.script, sha256, knowledge: compiled.knowledge, knowledgeMode: 'managed', sourcePlan: compiled.sourcePlan }
  const latest = library.list().find(entry => entry.id === request.plan.id)
  if (latest?.version !== source.version) {
    if (latest?.version === candidate.version) {
      const stored = library.read(request.plan.id, latest.version)
      if (JSON.stringify(stored) === JSON.stringify(candidate)) {
        authorize(stored)
        return { state: 'existing', id: request.plan.id, edition: stored }
      }
    }
    throw new WorkflowLibraryError('Migration target changed or differs from the reviewed replacement; no version was appended.')
  }
  if (dryRun) return { state: 'proposed', id: request.plan.id, edition: candidate }
  const edition = await library.publish(compiled, 'managed', () => { authorize(compiled) })
  // Callers redact a committed edition if authority changed while the durable write was in flight.
  return { state: 'committed', id: request.plan.id, edition }
}
