/** Real durable storage checks for pinned scripts and compare-and-set publication. */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import { WorkflowLibrary, workflowLibraryDomain } from '../src/store.ts'

it('retains exact editions across reopen and rejects competing revisions and byte limits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-workflow-library-'))
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(JsonStorage, { root })
    await ctx.plugin(DomainStorage, { backend: 'json' })
    const domain = await ctx.storageDomain.open(workflowLibraryDomain)
    const store = new WorkflowLibrary(domain.table('definitions'), 1000, 1)
    const first = await store.publish({ id: 'review', expectedVersion: 0, description: 'Review', script: 'return 1', knowledge: [] }, 'human')
    const competing = await Promise.allSettled([1, 2].map(value => store.publish({ id: 'review', expectedVersion: 1,
      description: 'Updated', script: `return ${value + 1}`, knowledge: [] }, 'human')))
    expect(competing.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
    expect(store.read('review', 1)).toEqual(first)
    const detached = store.read('review', 1)
    detached.script = 'modified'
    expect(store.read('review', 1)).toEqual(first)
    expect(store.list()).toEqual([{ id: 'review', version: 2, description: 'Updated' }])
    await expect(store.publish({ id: 'other', expectedVersion: 0, description: 'Other', script: 'return 3', knowledge: [] }, 'human'))
      .rejects.toMatchObject({ code: 'LYAGENT_WORKFLOW_LIBRARY_REJECTED' })
    await expect(store.publish({ id: 'review', expectedVersion: 2, description: 'Too large', script: 'x'.repeat(1000), knowledge: [] }, 'human'))
      .rejects.toMatchObject({ code: 'LYAGENT_WORKFLOW_LIBRARY_REJECTED' })
    expect(() => store.read('review', 3)).toThrow(expect.objectContaining({ code: 'LYAGENT_WORKFLOW_LIBRARY_REJECTED' }))
    expect(() => store.read('review', 0)).toThrow(expect.objectContaining({ code: 'LYAGENT_WORKFLOW_LIBRARY_REJECTED' }))
    await store.close()
    await expect(store.publish({ id: 'review', expectedVersion: 2, description: 'Closed', script: 'return 4', knowledge: [] }, 'human'))
      .rejects.toMatchObject({ code: 'LYAGENT_WORKFLOW_LIBRARY_REJECTED' })
    await domain.close()
    const reopened = await ctx.storageDomain.open(workflowLibraryDomain)
    try {
      const restored = new WorkflowLibrary(reopened.table('definitions'), 1000, 1)
      expect(restored.read('review', 1)).toEqual(first)
      expect(restored.read('review', 2).script).toBe('return 2')
    } finally { await reopened.close() }
  } finally {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})

it('records the publication provenance and still decodes legacy editions that carry no marker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-workflow-legacy-'))
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(JsonStorage, { root })
    await ctx.plugin(DomainStorage, { backend: 'json' })
    const domain = await ctx.storageDomain.open(workflowLibraryDomain)
    try {
      const store = new WorkflowLibrary(domain.table('definitions'), 4000, 4)
      const published = await store.publish({ id: 'tracked', expectedVersion: 0, description: 'Tracked', script: 'return 1', knowledge: [] }, 'managed')
      expect(published.knowledgeMode).toBe('managed')
      expect(store.read('tracked', 1).knowledgeMode).toBe('managed')
      expect(await store.publish({ id: 'tracked', expectedVersion: 1, description: 'Human', script: 'return 3', knowledge: [] }, 'human'))
        .toMatchObject({ version: 2, knowledgeMode: 'human' })
      const legacy = { version: 1, description: 'Legacy', script: 'return 2',
        sha256: createHash('sha256').update('return 2').digest('hex'), knowledge: [] }
      expect(workflowLibraryDomain.tables.definitions.valueSchema.safeParse({ editions: [legacy] }).success).toBe(true)
      await store.close()
    } finally { await domain.close() }
  } finally {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})

it('rejects corrupted script digests and noncontiguous versions on decode', () => {
  const schema = workflowLibraryDomain.tables.definitions.valueSchema
  expect(schema.safeParse({ editions: [{ version: 1, description: 'Broken', script: 'return 1', sha256: 'a'.repeat(64), knowledge: [] }] }).success).toBe(false)
})
