/** Immutable saved scripts; publication does not execute code or grant tool access. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
const knowledgeDependency = z.object({ collection: z.string().trim().min(1).max(80), version: z.number().int().positive() }).strict()
/** Human publication input; expectedVersion zero creates a new identity. */
export const publicationSchema = z.object({ id: identity, expectedVersion: z.number().int().nonnegative(),
  description: z.string().trim().min(1).max(1000), script: z.string().min(1),
  knowledge: z.array(knowledgeDependency).max(32).default([]),
  sourcePlan: z.record(z.string(), z.unknown()).optional() }).strict()
const edition = z.object({ version: z.number().int().positive(), description: z.string().min(1).max(1000),
  script: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  knowledge: z.array(knowledgeDependency).max(32).default([]),
  /**
   * Provenance of the recorded `knowledge` array. `managed` means the compiler derived it from
   * plan nodes and nested editions; `human` means a human published the script directly and
   * declared no managed dependency; absent means the edition predates tracking.
   */
  knowledgeMode: z.enum(['human', 'managed']).optional(),
  sourcePlan: z.record(z.string(), z.unknown()).optional() })
  .refine(value => createHash('sha256').update(value.script, 'utf8').digest('hex') === value.sha256, 'Script digest differs')
const record = z.object({ editions: z.array(edition).min(1) })
  .refine(value => value.editions.every((entry, index) => entry.version === index + 1), 'Versions must be contiguous')
/** Saved definitions use their own storage domain, separate from execution records. */
export const workflowLibraryDomain = defineDomain({ name: 'lyagent_workflow_library', version: 1,
  tables: { definitions: domainTable(record) } })
/** An explicit saved version; consumers cannot resolve a moving latest during execution. */
export type WorkflowEdition = z.infer<typeof edition>
/** Stable publication or lookup refusal. */
export class WorkflowLibraryError extends HarnessError {
  constructor(message: string) { super(message, 'LYAGENT_WORKFLOW_LIBRARY_REJECTED'); this.name = 'WorkflowLibraryError' }
}
/** Serial publication owner with compare-and-set revisions and a complete-history byte ceiling. */
export class WorkflowLibrary {
  private writes: Promise<void> = Promise.resolve()
  private closed = false
  constructor(private readonly definitions: KvTable<string, z.infer<typeof record>>, private readonly maxBytes: number,
    private readonly maxEntries: number) {}

  /** Publish the next immutable version without executing or parsing the script.
   * @param input - validated human definition and expected latest version.
   * @param knowledgeMode - compiler-derived dependencies or a trusted human script declaration.
   * @param beforeCommit - optional synchronous admission check run after queued writes, before storage starts.
   * @returns committed immutable edition; a failure of beforeCommit leaves storage unchanged.
   */
  async publish(input: z.infer<typeof publicationSchema>, knowledgeMode: 'human' | 'managed',
    beforeCommit?: () => void): Promise<WorkflowEdition> {
    const value = publicationSchema.parse(input)
    if (this.closed) throw new WorkflowLibraryError('The workflow library is closing.')
    const pending = this.writes.then(async () => {
      const previous = this.definitions.get(value.id)
      const latest = previous?.editions.at(-1)?.version ?? 0
      if (latest !== value.expectedVersion) throw new WorkflowLibraryError('Definition changed. Read its current version before saving again.')
      if (previous === undefined && [...this.definitions.entries()].length >= this.maxEntries) {
        throw new WorkflowLibraryError('Saved definition count reached the configured limit.')
      }
      const next = { version: latest + 1, description: value.description, script: value.script,
        sha256: createHash('sha256').update(value.script, 'utf8').digest('hex'), knowledge: value.knowledge,
        knowledgeMode, ...value.sourcePlan === undefined ? {} : { sourcePlan: value.sourcePlan } }
      const saved = { editions: [...(previous?.editions ?? []), next] }
      if (Buffer.byteLength(JSON.stringify(saved), 'utf8') > this.maxBytes) {
        throw new WorkflowLibraryError('Definition history exceeds the configured byte limit.')
      }
      beforeCommit?.()
      await this.definitions.put(value.id, saved)
      return structuredClone(next)
    })
    this.writes = pending.then(() => {}, () => {})
    return pending
  }

  /** Read exactly one retained version; absence never falls back to latest.
   * @param id - saved identity.
   * @param version - positive explicit version.
   * @returns detached immutable definition.
   */
  read(id: string, version: number): WorkflowEdition {
    if (!identity.safeParse(id).success || !Number.isSafeInteger(version) || version < 1) {
      throw new WorkflowLibraryError('Saved workflow reads require an identity and a positive exact version.')
    }
    const found = this.definitions.get(id)?.editions.find(entry => entry.version === version)
    if (found === undefined) throw new WorkflowLibraryError('The requested saved workflow version is unavailable.')
    return structuredClone(found)
  }

  /** Browse bounded metadata without returning executable scripts.
   * @returns identities, latest versions and descriptions in stable identity order.
   */
  list(): { id: string; version: number; description: string }[] {
    return [...this.definitions.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, value]) => {
      const latest = value.editions.at(-1)
      if (latest === undefined) throw new WorkflowLibraryError('Saved workflow history is empty.')
      return { id, version: latest.version, description: latest.description }
    })
  }

  /** Reject new publications and await already admitted durable writes. */
  async close(): Promise<void> {
    this.closed = true
    await this.writes
  }
}
