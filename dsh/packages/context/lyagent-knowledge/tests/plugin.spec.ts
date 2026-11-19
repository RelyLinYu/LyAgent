/** Tool registrations belong to the plugin fiber and cannot outlive its domain. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as DomainStorage from '@deepseek-ai/dsh-storage-domain'
import Tools from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as Knowledge from '../src/index.ts'

it('unregisters both tools and releases the domain before reloading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-knowledge-hmr-'))
  const ctx = new Context()
  try {
    await ctx.plugin(Storage)
    await ctx.plugin(JsonStorage, { root })
    await ctx.plugin(DomainStorage, { backend: 'json' })
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    const config = { maxCollectionBytes: 10000, maxResultBytes: 2000, maxMatches: 4, maxLineChars: 200 }
    const tools = ctx.tools
    const plugin = await ctx.plugin(Knowledge, config)
    expect(tools.get('search_knowledge')).toBeDefined()
    expect(tools.get('list_knowledge')).toBeDefined()
    expect(tools.get('read_source')).toBeDefined()
    await plugin.dispose()
    expect(tools.get('search_knowledge')).toBeUndefined()
    expect(tools.get('list_knowledge')).toBeUndefined()
    expect(tools.get('read_source')).toBeUndefined()
    const reloaded = await ctx.plugin(Knowledge, config)
    expect(tools.get('search_knowledge')).toBeDefined()
    await reloaded.dispose()
  } finally {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})
