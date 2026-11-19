/** Versioned human-owned role routes and team membership, independent of native live task boards. */
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { WorkflowLibraryError } from './store.ts'

const identity = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
const pin = z.object({ id: identity, version: z.number().int().positive() }).strict()
const profile = z.object({ kind: z.literal('profile'), description: z.string().trim().min(1).max(1000),
  instructions: z.string().trim().min(1).max(16000), provider: z.string().trim().min(1).max(200),
  model: z.string().trim().min(1).max(200), enabled: z.boolean() }).strict()
const team = z.object({ kind: z.literal('team'), description: z.string().trim().min(1).max(1000),
  members: z.array(z.object({ role: identity, profile: pin }).strict()).min(1).max(32) }).strict()
const definition = z.discriminatedUnion('kind', [profile, team])
/** Human CAS publication; creation uses expectedVersion zero. */
export const teamPublicationSchema = z.object({ id: identity, expectedVersion: z.number().int().nonnegative(), definition }).strict()
const edition = z.object({ version: z.number().int().positive(), definition }).strict()
const history = z.object({ editions: z.array(edition).min(1) }).strict()
  .refine(value => value.editions.every((entry, index) => entry.version === index + 1), 'Versions must be contiguous')
/** Separate metadata storage; no Session persistence format changes. */
export const teamLibraryDomain = defineDomain({ name: 'lyagent_team_library', version: 1,
  tables: { definitions: domainTable(history) } })
/** Immutable retained team or role definition. */
export type TeamEdition = z.infer<typeof edition>
/** Serial version owner; references must exist before a team can be committed. */
export class TeamLibrary {
  private writes: Promise<void> = Promise.resolve()
  private closed = false
  constructor(private readonly table: KvTable<string, z.infer<typeof history>>, private readonly maxBytes: number,
    private readonly maxEntries: number) {}

  /** Read one exact retained definition.
   * @param id - identity shared by all editions of the same kind.
   * @param version - exact positive version; no latest fallback.
   * @returns detached role or team definition.
   */
  read(id: string, version: number): TeamEdition {
    if (!identity.safeParse(id).success || !Number.isSafeInteger(version) || version < 1) {
      throw new WorkflowLibraryError('Team reads require an identity and an exact positive version.')
    }
    const found = this.table.get(id)?.editions.find(entry => entry.version === version)
    if (found === undefined) throw new WorkflowLibraryError('The requested team or profile version is unavailable.')
    return structuredClone(found)
  }

  /** Save a new immutable edition after checking every pinned role reference.
   * @param input - validated human definition and expected latest version.
   * @returns committed edition.
   */
  publish(input: z.infer<typeof teamPublicationSchema>): Promise<TeamEdition> {
    const value = teamPublicationSchema.parse(input)
    if (this.closed) return Promise.reject(new WorkflowLibraryError('The team library is closing.'))
    const pending = this.writes.then(async () => {
      const previous = this.table.get(value.id)
      if ((previous?.editions.length ?? 0) !== value.expectedVersion) throw new WorkflowLibraryError('Team definition changed. Read its current version before saving again.')
      if (previous !== undefined && previous.editions[0]?.definition.kind !== value.definition.kind) {
        throw new WorkflowLibraryError('An identity cannot change between profile and team.')
      }
      if (previous === undefined && [...this.table.entries()].length >= this.maxEntries) throw new WorkflowLibraryError('Team catalog reached the configured entry limit.')
      if (value.definition.kind === 'team') {
        if (new Set(value.definition.members.map(member => member.role)).size !== value.definition.members.length) {
          throw new WorkflowLibraryError('Team role names must be unique.')
        }
        for (const member of value.definition.members) {
          if (this.read(member.profile.id, member.profile.version).definition.kind !== 'profile') {
            throw new WorkflowLibraryError('A team member must reference an exact profile version.')
          }
        }
      }
      const next = { version: value.expectedVersion + 1, definition: value.definition }
      const saved = { editions: [...(previous?.editions ?? []), next] }
      if (Buffer.byteLength(JSON.stringify(saved), 'utf8') > this.maxBytes) throw new WorkflowLibraryError('Team history exceeds the configured byte limit.')
      await this.table.put(value.id, saved)
      return structuredClone(next)
    })
    this.writes = pending.then(() => {}, () => {})
    return pending
  }

  /** Browse metadata only; instructions and routes remain available through exact reads.
   * @returns stable identities and latest revisions.
   */
  list(): { id: string; version: number; kind: 'profile' | 'team'; description: string }[] {
    return [...this.table.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, value]) => {
      const latest = value.editions.at(-1)
      if (latest === undefined) throw new WorkflowLibraryError('Team history is empty.')
      return { id, version: latest.version, kind: latest.definition.kind, description: latest.definition.description }
    })
  }

  /** Reject new publications and drain admitted writes. */
  async close(): Promise<void> { this.closed = true; await this.writes }
}
