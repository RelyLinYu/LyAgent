/** Refusals that keep one saved edition's inlined content inside the current grants. */
import { WorkflowLibraryError } from './store.ts'

/** The part of a saved edition the provenance rule reads. */
export interface PinnedEdition {
  readonly version: number
  /** Provenance of the recorded knowledge array; absent on editions that predate tracking. */
  readonly knowledgeMode?: 'human' | 'managed' | undefined
}

/**
 * Refuse an edition whose knowledge provenance is unknown. Such an edition
 * compiled its excerpts into the script without recording the dependencies, so
 * a revoked grant cannot be re-checked and the text would still reach the model.
 * `human` editions are admitted: a human published that script directly and
 * declared no managed dependency, which is the documented trust boundary.
 * @param id - saved workflow identity, for the report.
 * @param edition - exact saved edition about to run or read.
 */
export function assertKnowledgePinned(id: string, edition: PinnedEdition): void {
  if (edition.knowledgeMode !== undefined) return
  throw new WorkflowLibraryError(`Saved edition ${id} v${edition.version} predates knowledge tracking, so the dependencies of any excerpts it inlined cannot be re-authorised. Publish this definition again to run or read it.`)
}
