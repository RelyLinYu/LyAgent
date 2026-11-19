/** Immutable text editions and host-only grants; model tools cannot grant themselves access. */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'

const key = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/)
const sourceSchema = z.object({ id: key, title: z.string().min(1).max(240), text: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .refine(source => createHash('sha256').update(source.text, 'utf8').digest('hex') === source.sha256, 'Source text does not match its stored digest')
const editionSchema = z.object({ version: z.number().int().positive(), sources: z.array(sourceSchema).min(1) })
  .refine(edition => new Set(edition.sources.map(source => source.id)).size === edition.sources.length, 'Duplicate source identities')
const collectionSchema = z.object({ title: z.string().min(1).max(240), archived: z.boolean(), editions: z.array(editionSchema).min(1) })
  .refine(collection => collection.editions.every((edition, index) => edition.version === index + 1), 'Collection editions must be contiguous and ordered')
const grantSchema = z.object({ pins: z.array(z.object({ collection: key, version: z.number().int().positive() })) })
  .refine(grant => new Set(grant.pins.map(pin => pin.collection)).size === grant.pins.length, 'Duplicate granted collections')
/** Domain records retain removed editions so prior pinned citations stay readable. */
export const knowledgeDomain = defineDomain({ name: 'lyagent_knowledge', version: 1,
  tables: { collections: domainTable(collectionSchema), grants: domainTable(grantSchema) } })
type Collection = z.infer<typeof collectionSchema>
type Grant = z.infer<typeof grantSchema>
/** Trusted text import; callers acquire text under their own native file/attachment permissions. */
export type SourceInput = { id: string; title: string; text: string }
/** Explicit storage and complete tool-output limits, chosen by the host. */
export interface Limits {
  /** Maximum UTF-8 bytes in one complete collection publication. */
  maxCollectionBytes: number
  /** Maximum serialized bytes in a complete tool response, including metadata. */
  maxResultBytes: number
  /** Maximum matching source lines returned by one lexical search. */
  maxMatches: number
  /** Maximum query characters and excerpt characters per source line. */
  maxLineChars: number
}
/** One stable source location; text may be clipped under the host's character bound. */
export interface SourceLine { source: string; title: string; sha256: string; line: number; text: string }
/** One bounded line read, with explicit remaining-source indication. */
export interface SourceRead extends SourceLine { collection: string; version: number; truncated: boolean; totalLines: number }
/** Lexical evidence only; omitted matches never mean no matching evidence exists. */
export interface SearchResult {
  collection: string
  version: number
  basis: string
  noMatch: boolean
  truncated: boolean
  totalMatches: number
  matches: (SourceLine & { textTruncated: boolean; matched: string[] })[]
}
/** Complete host-only source manifest; no source body enters task metadata. */
export interface KnowledgePin { collection: string; version: number; sources: { id: string; sha256: string }[] }
/** Human catalog metadata; does not expose sources or authorize model reads. */
export interface CollectionSummary { collection: string; title: string; archived: boolean; versions: number[] }
/** Stable access refusal; missing grants never silently return an empty search. */
export class KnowledgeError extends HarnessError {
  constructor(message: string) { super(message, 'LYAGENT_KNOWLEDGE_REJECTED'); this.name = 'KnowledgeError' }
}
function bytes(value: object): number { return Buffer.byteLength(JSON.stringify(value), 'utf8') }
function terms(text: string): string[] {
  const normalized = text.normalize('NFKC').toLowerCase()
  const words = normalized.match(/[\p{L}\p{N}_]+/gu) ?? []
  return [...new Set(words.flatMap(word => /^[\p{Script=Han}]+$/u.test(word) && word.length > 1
    ? Array.from({ length: word.length - 1 }, (_, index) => word.slice(index, index + 2)) : [word]))]
}
/** Durable collection owner; serializes host writes and enforces pinned access inside every read. */
export class KnowledgeStore {
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly collections: KvTable<string, Collection>, private readonly grants: KvTable<string, Grant>,
    private readonly limits: Limits) {}

  private async write<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.writes.then(operation)
    this.writes = pending.then(() => {}, () => {})
    return pending
  }

  /** Add an edition without replacing prior text; archived identities cannot be reused.
   * @param id - host collection identity.
   * @param title - user-visible collection title.
   * @param sources - complete new edition, acquired by a trusted importer.
   * @returns committed positive edition number.
   */
  async publish(id: string, title: string, sources: SourceInput[]): Promise<number> {
    return this.write(async () => {
      key.parse(id)
      const previous = this.collections.get(id)
      if (previous?.archived) throw new KnowledgeError('Archived collection identities cannot be replaced.')
      const version = (previous?.editions.at(-1)?.version ?? 0) + 1
      if (new Set(sources.map(source => source.id)).size !== sources.length) {
        throw new KnowledgeError('Source identities must be unique within an edition.')
      }
      const edition = editionSchema.parse({ version, sources: sources.map(source => ({ ...source,
        sha256: createHash('sha256').update(source.text, 'utf8').digest('hex') })) })
      const record = collectionSchema.parse({ title, archived: false, editions: [...(previous?.editions ?? []), edition] })
      if (bytes(record) > this.limits.maxCollectionBytes) throw new KnowledgeError('Collection history exceeds the configured byte limit.')
      await this.collections.put(id, record)
      return version
    })
  }

  /** Hide a collection from future grants without erasing previously pinned evidence.
   * @param id - existing collection identity.
   */
  async archive(id: string): Promise<void> {
    await this.write(async () => {
      key.parse(id)
      if (this.collections.get(id) === undefined) throw new KnowledgeError('Collection is unavailable.')
      await this.collections.update(id, record => ({ ...record, archived: true }))
    })
  }

  /** Replace a session's grants atomically; an empty list explicitly revokes all access.
   * @param session - host-selected owning session, never a model argument.
   * @param pins - exact collection versions, not a moving latest alias.
   */
  async grant(session: string, pins: Grant['pins']): Promise<void> {
    await this.write(async () => {
      const record = grantSchema.parse({ pins })
      if (!session.trim() || new Set(record.pins.map(pin => pin.collection)).size !== record.pins.length) {
        throw new KnowledgeError('Grants require a session and unique collection identities.')
      }
      for (const pin of record.pins) {
        const collection = this.collections.get(pin.collection)
        const retained = this.grants.get(session)?.pins.some(previous => previous.collection === pin.collection
          && previous.version === pin.version) === true
        if (collection === undefined || (collection.archived && !retained)
          || !collection.editions.some(edition => edition.version === pin.version)) {
          throw new KnowledgeError('A grant references an unavailable collection edition.')
        }
      }
      await this.grants.put(session, record)
    })
  }

  /** List only exact editions already granted to the authenticated session.
   * @param session - authenticated calling session.
   * @returns bounded granted identities; an empty list means no grants.
   */
  list(session: string): { pins: { collection: string; version: number }[]; truncated: boolean } {
    const pins = structuredClone(this.grants.get(session)?.pins ?? [])
    const result = { pins: pins.slice(0, this.limits.maxMatches), truncated: pins.length > this.limits.maxMatches }
    while (bytes(result) > this.limits.maxResultBytes && result.pins.length) { result.pins.pop(); result.truncated = true }
    if (bytes(result) > this.limits.maxResultBytes) throw new KnowledgeError('Grant metadata exceeds the configured output limit.')
    return result
  }

  /** Browse host collection metadata without granting access or returning source bodies.
   * @param after - exclusive collection identity cursor; absent starts at the first identity.
   * @returns byte- and item-bounded metadata page; next is absent when no items remain.
   */
  catalog(after?: string): { collections: CollectionSummary[]; next?: string } {
    if (after !== undefined) key.parse(after)
    const candidates = [...this.collections.entries()].filter(([id]) => after === undefined || id > after)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    const result: { collections: CollectionSummary[]; next?: string } = { collections: [] }
    for (const [id, record] of candidates) {
      const summary = { collection: id, title: record.title, archived: record.archived,
        versions: record.editions.map(edition => edition.version) }
      result.collections.push(summary)
      result.next = id
      if (result.collections.length > this.limits.maxMatches || bytes(result) > this.limits.maxResultBytes) {
        result.collections.pop()
        const previous = result.collections.at(-1)
        if (previous === undefined) throw new KnowledgeError('Collection metadata exceeds the configured output limit.')
        result.next = previous.collection
        return result
      }
    }
    delete result.next
    return result
  }

  /** Capture the complete authorized source manifest without tool-result truncation.
   * @param session - owning task session.
   * @returns detached immutable-edition references and text digests.
   */
  snapshot(session: string): KnowledgePin[] {
    return (this.grants.get(session)?.pins ?? []).map(pin => ({
      ...pin, sources: this.edition(session, pin.collection, pin.version).sources.map(source => ({
        id: source.id, sha256: source.sha256,
      })),
    }))
  }

  private edition(session: string, collection: string, version: number) {
    if (!this.grants.get(session)?.pins.some(pin => pin.collection === collection && pin.version === version)) {
      throw new KnowledgeError('This session has no grant for that collection version.')
    }
    const edition = this.collections.get(collection)?.editions.find(value => value.version === version)
    if (edition === undefined) throw new KnowledgeError('The pinned collection version is unavailable.')
    return edition
  }

  /** Read one bounded source window from the session's exact authorized edition.
   * @param session - authenticated calling session.
   * @param collection - collection identity.
   * @param version - pinned edition number.
   * @param source - source identity from search results.
   * @param line - positive first line.
   * @returns bounded text and stable source/hash/line location; truncation is explicit.
   */
  read(session: string, collection: string, version: number, source: string, line: number): SourceRead {
    const edition = this.edition(session, collection, version)
    const item = edition.sources.find(value => value.id === source)
    if (item === undefined || !Number.isSafeInteger(line) || line < 1) throw new KnowledgeError('Source and positive line are required.')
    const lines = item.text.split(/\r\n|\n|\r/)
    const text = lines[line - 1]
    if (text === undefined) throw new KnowledgeError('The requested line is outside this source.')
    const result = { collection, version, source, title: item.title, sha256: item.sha256,
      line, text: text.slice(0, this.limits.maxLineChars), truncated: false, totalLines: lines.length }
    result.truncated = result.text.length < text.length || line < lines.length
    if (bytes(result) > this.limits.maxResultBytes) throw new KnowledgeError('Source metadata exceeds the configured output limit.')
    return result
  }

  /** Lexical retrieval; Han bigrams support partial wording, not semantic entailment.
   * @param session - authenticated calling session.
   * @param collection - collection identity.
   * @param version - exact pinned edition number.
   * @param query - nonempty query text.
   * @returns ranked bounded matches with explicit basis and no-match/truncation fields.
   */
  /** Report whether one session may still read an exact collection edition.
   * @param session - authenticated calling session.
   * @param collection - collection identity.
   * @param version - exact pinned edition number.
   * @returns true when the grant covers this edition now.
   */
  authorized(session: string, collection: string, version: number): boolean {
    try {
      this.edition(session, collection, version)
      return true
    } catch (_error: unknown) {
      // Missing grants and missing editions are both "not authorized" for callers.
      return false
    }
  }

  /** Search one currently authorized edition with NFKC lexical terms and Han bigrams.
   * @param session - exact native Agent identity carrying the grant.
   * @param collection - granted collection identity.
   * @param version - exact granted edition.
   * @param query - nonempty lexical query within the configured character limit.
   * @returns bounded matches and explicit omission indicators; rejects denied access or oversized metadata.
   */
  search(session: string, collection: string, version: number, query: string): SearchResult {
    const edition = this.edition(session, collection, version)
    const tokens = terms(query)
    if (!tokens.length || query.length > this.limits.maxLineChars) throw new KnowledgeError('Query is empty or exceeds the configured character limit.')
    const candidates = edition.sources.flatMap(source => source.text.split(/\r\n|\n|\r/).flatMap((text, index) => {
      const normalized = text.normalize('NFKC').toLowerCase()
      const matched = tokens.filter(token => normalized.includes(token))
      return matched.length ? [{ source: source.id, title: source.title, sha256: source.sha256, line: index + 1,
        text: text.slice(0, this.limits.maxLineChars), textTruncated: text.length > this.limits.maxLineChars, matched }] : []
    })).sort((a, b) => b.matched.length - a.matched.length || a.source.localeCompare(b.source) || a.line - b.line)
    const result = { collection, version, basis: 'lexical_nfkc_han_bigrams', noMatch: candidates.length === 0,
      truncated: false, totalMatches: candidates.length, matches: candidates.slice(0, this.limits.maxMatches) }
    result.truncated = result.matches.length < candidates.length
    while (bytes(result) > this.limits.maxResultBytes && result.matches.length) { result.matches.pop(); result.truncated = true }
    if (bytes(result) > this.limits.maxResultBytes) throw new KnowledgeError('Search metadata exceeds the configured output limit.')
    return result
  }
}
