/** Real JSON storage tests for immutable editions, bounded retrieval and grant isolation. */
import { mkdtemp, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import { KnowledgeStore, knowledgeDomain } from '../src/store.ts'

it('rejects damaged text digests, ambiguous source identities and reordered editions on decode', () => {
  const schema = knowledgeDomain.tables.collections.valueSchema
  const source = { id: 'policy', title: 'Policy', text: 'evidence',
    sha256: createHash('sha256').update('evidence').digest('hex') }
  const valid = { title: 'Manual', archived: false, editions: [{ version: 1, sources: [source] }] }
  expect(schema.safeParse(valid).success).toBe(true)
  expect(schema.safeParse({ ...valid, editions: [{ version: 1, sources: [{ ...source, text: 'changed' }] }] }).success).toBe(false)
  expect(schema.safeParse({ ...valid, editions: [{ version: 1, sources: [source, source] }] }).success).toBe(false)
  expect(schema.safeParse({ ...valid, editions: [{ version: 2, sources: [source] }] }).success).toBe(false)
})

it('pins editions across sessions and restart, retains conflicting evidence and revokes access', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-knowledge-'))
  const ctx = new Context()
  const limits = { maxCollectionBytes: 10000, maxResultBytes: 4000, maxMatches: 10, maxLineChars: 200 }
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(JsonStorage, { root })
    await ctx.plugin(DomainStorage, { backend: 'json' })
    const domain = await ctx.storageDomain.open(knowledgeDomain)
    const store = new KnowledgeStore(domain.table('collections'), domain.table('grants'), limits)
    const sources = [{ id: 'policy', title: 'Policy', text: 'Delivery takes 3 days.\n\u4ea7\u54c1\u4ea4\u4ed8\u9700\u8981\u4e09\u5929\u3002' },
      { id: 'notice', title: 'Notice', text: 'Delivery takes 5 days.' }]
    expect(await store.publish('manual', 'Manual', sources)).toBe(1)
    expect(() => store.search('a', 'manual', 1, 'delivery')).toThrow(expect.objectContaining({ code: 'LYAGENT_KNOWLEDGE_REJECTED' }))
    await store.grant('a', [{ collection: 'manual', version: 1 }])
    await store.grant('b', [{ collection: 'manual', version: 1 }])
    expect(store.list('a')).toEqual({ pins: [{ collection: 'manual', version: 1 }], truncated: false })
    expect(store.list('stranger')).toEqual({ pins: [], truncated: false })
    const detachedPins = store.list('a')
    detachedPins.pins.length = 0
    expect(store.list('a').pins).toHaveLength(1)
    const pinned = store.snapshot('a')
    expect(pinned[0]?.sources).toHaveLength(2)
    expect(store.snapshot('stranger')).toEqual([])
    expect(store.search('a', 'manual', 1, 'delivery').matches.map(match => match.text)).toEqual(['Delivery takes 5 days.', 'Delivery takes 3 days.'])
    expect(store.search('a', 'manual', 1, '\u4ea4\u4ed8\u8981\u591a\u4e45').matches[0]).toMatchObject({ source: 'policy', line: 2 })
    expect(store.search('a', 'manual', 1, 'absent').noMatch).toBe(true)
    expect(store.search('a', 'manual', 1, 'absent').matches).toEqual([])
    await store.publish('manual', 'Manual', [{ id: 'policy', title: 'New policy', text: 'Delivery takes 8 days.' }])
    expect(store.read('a', 'manual', 1, 'policy', 1).text).toBe('Delivery takes 3 days.')
    expect(store.snapshot('a')).toEqual(pinned)
    expect(() => store.read('a', 'manual', 2, 'policy', 1)).toThrow(expect.objectContaining({ code: 'LYAGENT_KNOWLEDGE_REJECTED' }))
    await store.grant('b', [{ collection: 'manual', version: 2 }])
    expect(store.read('b', 'manual', 2, 'policy', 1).text).toBe('Delivery takes 8 days.')
    await store.archive('manual')
    await store.publish('other', 'Other', [{ id: 'extra', title: 'Extra', text: 'Other evidence' }])
    await store.grant('a', [{ collection: 'manual', version: 1 }, { collection: 'other', version: 1 }])
    expect(store.read('a', 'manual', 1, 'policy', 1).text).toBe('Delivery takes 3 days.')
    await expect(store.grant('a', [{ collection: 'manual', version: 2 }])).rejects.toMatchObject({ code: 'LYAGENT_KNOWLEDGE_REJECTED' })
    await expect(store.grant('c', [{ collection: 'manual', version: 2 }])).rejects.toMatchObject({ code: 'LYAGENT_KNOWLEDGE_REJECTED' })
    await expect(store.publish('manual', 'Overwrite', sources)).rejects.toMatchObject({ code: 'LYAGENT_KNOWLEDGE_REJECTED' })
    await domain.close()
    const reopened = await ctx.storageDomain.open(knowledgeDomain)
    try {
      const restored = new KnowledgeStore(reopened.table('collections'), reopened.table('grants'), limits)
      expect(restored.read('a', 'manual', 1, 'policy', 2).text).toBe(sources[0]!.text.split('\n')[1])
      await restored.grant('a', [])
      expect(restored.list('a').pins).toEqual([])
      expect(() => restored.read('a', 'manual', 1, 'policy', 1)).toThrow(expect.objectContaining({ code: 'LYAGENT_KNOWLEDGE_REJECTED' }))
      expect(restored.read('b', 'manual', 2, 'policy', 1).text).toBe('Delivery takes 8 days.')
    } finally { await reopened.close() }
  } finally {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})

it('serializes concurrent publications and bounds complete multibyte JSON output', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-knowledge-limits-'))
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(JsonStorage, { root })
    await ctx.plugin(DomainStorage, { backend: 'json' })
    const domain = await ctx.storageDomain.open(knowledgeDomain)
    try {
      const store = new KnowledgeStore(domain.table('collections'), domain.table('grants'),
        { maxCollectionBytes: 10000, maxResultBytes: 500, maxMatches: 1, maxLineChars: 100 })
      const source = [{ id: 'one', title: 'Title', text: ('\u4ea4\u4ed8'.repeat(80) + '\n').repeat(3) }]
      expect(await Promise.all([store.publish('c', 'C', source), store.publish('c', 'C', source)])).toEqual([1, 2])
      await store.grant('s', [{ collection: 'c', version: 1 }])
      await store.publish('a', 'First collection', source)
      await store.archive('a')
      expect(store.catalog()).toEqual({ collections: [{ collection: 'a', title: 'First collection', archived: true, versions: [1] }], next: 'a' })
      const page = store.catalog('a')
      expect(page).toEqual({ collections: [{ collection: 'c', title: 'C', archived: false, versions: [1, 2] }] })
      page.collections[0]!.versions.length = 0
      expect(store.catalog('a').collections[0]?.versions).toEqual([1, 2])
      expect(store.catalog('c')).toEqual({ collections: [] })
      expect(JSON.stringify(store.catalog())).not.toContain(source[0]!.text)
      await expect(store.archive('missing')).rejects.toMatchObject({ code: 'LYAGENT_KNOWLEDGE_REJECTED' })
      const result = store.search('s', 'c', 1, '\u4ea4\u4ed8')
      expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(500)
      expect(result).toMatchObject({ noMatch: false, truncated: true, totalMatches: 3 })
      expect(() => store.read('s', 'c', 1, 'one', 0)).toThrow(expect.objectContaining({ code: 'LYAGENT_KNOWLEDGE_REJECTED' }))
      await expect(store.publish('duplicate', 'D', [source[0]!, source[0]!])).rejects.toMatchObject({ code: 'LYAGENT_KNOWLEDGE_REJECTED' })
      const tiny = new KnowledgeStore(domain.table('collections'), domain.table('grants'),
        { maxCollectionBytes: 1, maxResultBytes: 1, maxMatches: 1, maxLineChars: 1 })
      await expect(tiny.publish('new', 'N', source)).rejects.toMatchObject({ code: 'LYAGENT_KNOWLEDGE_REJECTED' })
      expect(() => tiny.catalog()).toThrow(expect.objectContaining({ code: 'LYAGENT_KNOWLEDGE_REJECTED' }))
      expect(() => tiny.search('s', 'c', 1, 'x')).toThrow(expect.objectContaining({ code: 'LYAGENT_KNOWLEDGE_REJECTED' }))
    } finally { await domain.close() }
  } finally {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})

it('reports authorization for an exact edition and drops it after revocation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-knowledge-auth-'))
  const ctx = new Context()
  const limits = { maxCollectionBytes: 10000, maxResultBytes: 4000, maxMatches: 10, maxLineChars: 200 }
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(JsonStorage, { root })
    await ctx.plugin(DomainStorage, { backend: 'json' })
    const domain = await ctx.storageDomain.open(knowledgeDomain)
    const store = new KnowledgeStore(domain.table('collections'), domain.table('grants'), limits)
    await store.publish('manual', 'Manual', [{ id: 's1', title: 'Rule', text: '编号必须与台账一致' }])
    expect(store.authorized('reader', 'manual', 1)).toBe(false)
    await store.grant('reader', [{ collection: 'manual', version: 1 }])
    expect(store.authorized('reader', 'manual', 1)).toBe(true)
    await store.grant('reader', [])
    expect(store.authorized('reader', 'manual', 1)).toBe(false)
    expect(store.authorized('reader', 'manual', 9)).toBe(false)
  } finally {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})
