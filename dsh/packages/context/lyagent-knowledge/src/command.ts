/** Human-owned text publication and exact-version authorization; never a model tool. */
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { AttachmentError } from '@deepseek-ai/dsh-attachment'
import { z } from 'zod'
import { KnowledgeError } from './store.ts'
import type { KnowledgeStore } from './store.ts'

const publish = z.object({ collection: z.string(), title: z.string(),
  sources: z.array(z.object({ id: z.string(), title: z.string(), text: z.string() })).min(1) }).strict()
const pins = z.array(z.object({ collection: z.string(), version: z.number().int().positive() }).strict())
const usage = '/knowledge catalog [after] | import <collection> <title> | list | publish <JSON: collection,title,sources> | grant <JSON pins> | revoke | archive <collection>'

/** Register explicit human knowledge controls when a native command registry is mounted.
 * @param ctx - command registration lifecycle owner.
 * @param store - durable immutable editions and per-session grants.
 * @param maxBytes - maximum complete publication command input in UTF-8 bytes.
 */
export function registerKnowledgeCommand(ctx: Context, store: KnowledgeStore, maxBytes: number): void {
  const commands = ctx.get('commands')
  if (commands === undefined) return
  commands.register({ name: 'knowledge', description: 'Publish text editions and manage this conversation\'s knowledge access',
    input: { hint: 'catalog [after] | import <collection> <title> | list | publish <JSON> | grant <JSON pins> | revoke | archive <collection>', attachments: true },
    async handler(invocation: CommandInvocation): Promise<CommandResult> {
      const input = invocation.rawInput.trim()
      invocation.signal.throwIfAborted()
      if (Buffer.byteLength(input, 'utf8') > maxBytes) return { kind: 'error', text: 'Knowledge input exceeds the configured collection byte limit.' }
      try {
        const importing = /^import ([a-zA-Z0-9_-]{1,80}) (.+)$/.exec(input)
        if (invocation.attachments.length > 0 && importing === null) return { kind: 'error', text: 'Attachments require /knowledge import <collection> <title>.' }
        if (importing !== null && importing[1] !== undefined && importing[2] !== undefined) {
          const attachments = ctx.get('attachments')
          if (attachments === undefined) return { kind: 'error', text: 'File attachment storage is unavailable.' }
          if (!invocation.attachments.length || invocation.attachments.some(part => part.type !== 'file')) {
            return { kind: 'error', text: 'Attach UTF-8 text files to import. Images and empty imports are not supported.' }
          }
          const sources: { id: string; title: string; text: string }[] = []
          let total = 0
          for (const part of invocation.attachments) {
            if (part.type !== 'file') continue
            const ref = part.attachment
            if (!/\.(?:txt|md|csv|tsv|json|log)$/i.test(ref.name)) return { kind: 'error', text: 'Import supports txt, md, csv, tsv, json and log text files only.' }
            if (ref.bytes > maxBytes - total) return { kind: 'error', text: 'Attachment text exceeds the configured collection byte limit.' }
            const chunks: Uint8Array[] = []
            let size = 0
            for await (const chunk of attachments.readFileStream(ref, invocation.signal)) {
              size += chunk.byteLength
              if (size > maxBytes - total) return { kind: 'error', text: 'Attachment text exceeds the configured collection byte limit.' }
              chunks.push(chunk)
            }
            total += size
            let text: string
            const data = Buffer.concat(chunks)
            try { text = new TextDecoder('utf-8', { fatal: true }).decode(data) } catch (error) {
              if (error instanceof TypeError) return { kind: 'error', text: 'Every imported file must contain valid UTF-8 text.' }
              throw error
            }
            if (text.includes('\u0000')) return { kind: 'error', text: 'Binary files cannot be imported as text.' }
            const id = createHash('sha256').update(data).digest('hex')
            if (sources.some(source => source.id === id)) continue
            sources.push({ id, title: ref.name, text })
          }
          invocation.signal.throwIfAborted()
          const version = await store.publish(importing[1], importing[2], sources)
          return { kind: 'success', text: `Imported ${sources.length} text sources into ${importing[1]} version ${version}. No conversation access was granted.` }
        }
        if (input === 'list') return { kind: 'success', text: JSON.stringify(store.list(invocation.agent.id)) }
        if (input === 'catalog' || /^catalog [a-zA-Z0-9_-]{1,80}$/.test(input)) {
          return { kind: 'success', text: JSON.stringify(store.catalog(input === 'catalog' ? undefined : input.slice(8))) }
        }
        if (input === 'revoke') {
          await store.grant(invocation.agent.id, [])
          ctx.emit('lyagent-knowledge/grants-changed', invocation.agent.id)
          return { kind: 'success', text: 'All knowledge access revoked for this conversation.' }
        }
        if (input.startsWith('publish ')) {
          const parsed = publish.safeParse(JSON.parse(input.slice(8)))
          if (!parsed.success) return { kind: 'error', text: 'Publication requires collection, title and nonempty sources with id, title and text.' }
          const value = parsed.data
          const version = await store.publish(value.collection, value.title, value.sources)
          return { kind: 'success', text: `Published ${value.collection} version ${version}. No conversation access was granted.` }
        }
        if (input.startsWith('grant ')) {
          const parsed = pins.safeParse(JSON.parse(input.slice(6)))
          if (!parsed.success) return { kind: 'error', text: 'Grants require an array of collection and positive version pairs.' }
          await store.grant(invocation.agent.id, parsed.data)
          ctx.emit('lyagent-knowledge/grants-changed', invocation.agent.id)
          return { kind: 'success', text: `Replaced this conversation's knowledge grants: ${JSON.stringify(parsed.data)}` }
        }
        if (/^archive [a-zA-Z0-9_-]{1,80}$/.test(input)) {
          await store.archive(input.slice(8))
          return { kind: 'success', text: 'Collection archived. Historical grants remain readable until explicitly revoked.' }
        }
        return { kind: 'error', text: usage }
      } catch (error) {
        if (error instanceof AttachmentError) return { kind: 'error', text: 'Attachment reading failed. No knowledge edition was published.' }
        if (error instanceof SyntaxError) return { kind: 'error', text: 'Invalid JSON. No knowledge change was committed.' }
        if (error instanceof z.ZodError) return { kind: 'error', text: 'Knowledge identifiers, titles or source records are invalid.' }
        if (error instanceof KnowledgeError) return { kind: 'error', text: error.message }
        throw error
      }
    },
  })
}
