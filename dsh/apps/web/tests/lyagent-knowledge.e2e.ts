/** Keyless real Loader test: only the external model is scripted; grants and history are native. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-lyagent-knowledge'
import { launchWebScaffold } from './scaffold.ts'

it('logs exact authorized source versions and refuses another session through native tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-knowledge-loader-'))
  const overlay = join(root, 'knowledge.yml')
  await writeFile(overlay, JSON.stringify([{ insert: [{ id: 'lyagent-knowledge',
    name: '@deepseek-ai/dsh-lyagent-knowledge', config: {
      maxCollectionBytes: 10000, maxResultBytes: 2000, maxMatches: 4, maxLineChars: 200,
    } }] }]))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  const handles: Awaited<ReturnType<NonNullable<typeof scaffold>['ctx']['agents']['create']>>[] = []
  try {
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    const ctx = scaffold.ctx
    const knowledge = ctx.get('lyagentKnowledge')
    if (knowledge === undefined) throw new Error('Knowledge plugin did not load')
    await knowledge.publish('manual', 'Manual', [{ id: 'policy', title: 'Policy', text: 'Delivery takes 3 days.' }])
    await knowledge.grant('knowledge-owner', [{ collection: 'manual', version: 1 }])
    await knowledge.publish('manual', 'Manual', [{ id: 'policy', title: 'Policy', text: 'Delivery takes 8 days.' }])
    class KnowledgeAdapter extends LlmAdapter {
      private step = 0
      override async *stream(): AsyncIterable<StreamChunk> {
        if (this.step++ % 4 === 3) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
        const list = this.step % 4 === 1
        const search = this.step % 4 === 2
        const id = ToolCallId(`knowledge-${this.step}`)
        const name = list ? 'list_knowledge' : search ? 'search_knowledge' : 'read_source'
        const args = JSON.stringify(list ? {} : search ? { collection: 'manual', version: 1, query: 'delivery' }
          : { collection: 'manual', version: 1, source: 'policy', line: 1 })
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id, name, arguments: args } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
      }
    }
    ctx.llm.registerAdapter(['knowledge-fixture'], new KnowledgeAdapter())
    const commandOwner = await ctx.agents.create({ sessionId: SessionId('knowledge-command-owner'), meta: { cwd: scaffold.workspaceCwd } })
    handles.push(commandOwner)
    const commands = ctx.get('commands')
    if (commands === undefined) throw new Error('Native commands are unavailable')
    const command = (input: string) => commands.execute(commandOwner.agent, `/knowledge ${input}`, [], new AbortController().signal)
    const publication = JSON.stringify({ collection: 'user_manual', title: 'User manual',
      sources: [{ id: 'intro', title: 'Introduction', text: 'User-published reference text.' }] })
    expect((await command(`publish ${publication}`))?.result.kind).toBe('success')
    const catalog = await command('catalog')
    expect(catalog?.result.kind).toBe('success')
    expect(catalog?.result.text).toContain('user_manual')
    expect(catalog?.result.text).not.toContain('User-published reference text.')
    expect((await command('archive missing_collection'))?.result.kind).toBe('error')
    expect(knowledge.snapshot(commandOwner.agent.id)).toEqual([])
    expect((await command('grant [{"collection":"user_manual","version":1}]'))?.result.kind).toBe('success')
    expect(knowledge.read(commandOwner.agent.id, 'user_manual', 1, 'intro', 1).text).toBe('User-published reference text.')
    expect((await command('list'))?.result.text).toContain('user_manual')
    expect((await command('publish {broken'))?.result.kind).toBe('error')
    expect((await command('archive user_manual'))?.result.kind).toBe('success')
    expect(knowledge.read(commandOwner.agent.id, 'user_manual', 1, 'intro', 1).text).toBe('User-published reference text.')
    await knowledge.publish('additional', 'Additional', [{ id: 'note', title: 'Note', text: 'Separate reference.' }])
    expect((await command('grant [{"collection":"user_manual","version":1},{"collection":"additional","version":1}]'))?.result.kind).toBe('success')
    expect(knowledge.snapshot(commandOwner.agent.id).map(pin => pin.collection)).toEqual(['user_manual', 'additional'])
    expect((await command('revoke'))?.result.kind).toBe('success')
    expect(knowledge.snapshot(commandOwner.agent.id)).toEqual([])
    expect((await command('grant [{"collection":"user_manual","version":1}]'))?.result.kind).toBe('error')
    expect(commandOwner.agent.session.snapshotEvents().filter(event => event.type === 'request/header')).toHaveLength(0)
    const uploads = ctx.get('fileUploads')
    if (uploads === undefined) throw new Error('Native file uploads are unavailable')
    const uploaded = await uploads.upload(commandOwner.agent, { name: 'reference.md',
      data: Buffer.from('Uploaded UTF-8 evidence.').toString('base64') }, new AbortController().signal)
    const imported = await commands.execute(commandOwner.agent, '/knowledge import uploaded_refs Uploaded references',
      [{ type: 'file', receiptId: uploaded.receiptId }], new AbortController().signal)
    expect(imported?.result.kind, imported?.result.text).toBe('success')
    expect(knowledge.snapshot(commandOwner.agent.id)).toEqual([])
    expect((await command('grant [{"collection":"uploaded_refs","version":1}]'))?.result.kind).toBe('success')
    const importedSource = createHash('sha256').update('Uploaded UTF-8 evidence.').digest('hex')
    expect(knowledge.read(commandOwner.agent.id, 'uploaded_refs', 1, importedSource, 1).text).toBe('Uploaded UTF-8 evidence.')
    const invalidFile = await uploads.upload(commandOwner.agent, { name: 'invalid.txt',
      data: Buffer.from([0xff, 0xfe]).toString('base64') }, new AbortController().signal)
    const invalidImport = await commands.execute(commandOwner.agent, '/knowledge import invalid_text Invalid',
      [{ type: 'file', receiptId: invalidFile.receiptId }], new AbortController().signal)
    expect(invalidImport?.result.kind).toBe('error')
    const oversized = await uploads.upload(commandOwner.agent, { name: 'oversized.txt',
      data: Buffer.from('x'.repeat(10001)).toString('base64') }, new AbortController().signal)
    const oversizedImport = await commands.execute(commandOwner.agent, '/knowledge import oversized_text Oversized',
      [{ type: 'file', receiptId: oversized.receiptId }], new AbortController().signal)
    expect(oversizedImport?.result.kind).toBe('error')
    const forgedImport = await commands.execute(commandOwner.agent, '/knowledge import forged_text Forged',
      [{ type: 'file', receiptId: 'not-a-staged-receipt' }], new AbortController().signal)
    expect(forgedImport?.result.kind).toBe('error')
    await expect(knowledge.grant(commandOwner.agent.id, [{ collection: 'invalid_text', version: 1 }])).rejects.toMatchObject({ code: 'LYAGENT_KNOWLEDGE_REJECTED' })
    expect(commandOwner.agent.session.snapshotEvents().filter(event => event.type === 'request/header')).toHaveLength(0)
    for (const session of ['knowledge-owner', 'knowledge-stranger']) {
      const handle = await ctx.agents.create({ sessionId: SessionId(session), meta: { cwd: scaffold.workspaceCwd },
        agentOptions: { provider: 'knowledge-fixture', model: 'fixture' },
        setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'standard').then(() => undefined) })
      handles.push(handle)
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Find the delivery policy.' }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
      await ctx.sessionPersistence.flush()
      const persisted = await ctx.sessionPersistence.open(handle.agent.id, 'read')
      try {
        const history = await persisted.read()
        const results = history.events.filter(event => event.type === 'tool/result')
        expect(results).toHaveLength(3)
        if (session === 'knowledge-owner') {
          expect(results.every(event => event.data.message.isError === false)).toBe(true)
          expect(JSON.stringify(results)).toContain('Delivery takes 3 days.')
          expect(JSON.stringify(results)).not.toContain('Delivery takes 8 days.')
          expect(JSON.stringify(results)).toContain('lexical_nfkc_han_bigrams')
        } else {
          expect(results[0]?.data.message.isError).toBe(false)
          expect(results[0]?.data.message.content).toContainEqual({ type: 'text', text: '{"pins":[],"truncated":false}' })
          expect(results.slice(1).every(event => event.data.message.isError === true)).toBe(true)
          expect(results.slice(1).map(event => event.data.error?.code)).toEqual(['LYAGENT_KNOWLEDGE_REJECTED', 'LYAGENT_KNOWLEDGE_REJECTED'])
          expect(JSON.stringify(results)).not.toContain('Delivery takes')
        }
      } finally { await persisted.close() }
    }
    const plugin = [...ctx.loader.entries()].find(value => value.options.id === 'lyagent-knowledge')
    if (plugin?.fiber === undefined) throw new Error('Knowledge plugin fiber is unavailable')
    expect(commands.find(commandOwner.agent, 'knowledge')).toBeDefined()
    await plugin.fiber.dispose()
    expect(ctx.get('lyagentKnowledge')).toBeUndefined()
    expect(commands.find(commandOwner.agent, 'knowledge')).toBeUndefined()
    expect(() => knowledge.catalog()).toThrow('closed')
  } finally {
    for (const handle of handles) await handle.dispose()
    try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
  }
})
