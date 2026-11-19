/** Complete-text digest acquisition through the configured filesystem provider. */
import type { Context } from '@deepseek-ai/cordis'
import { FsError } from '@deepseek-ai/dsh-fs'
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools'
import { resolveRegularReadTarget } from './read-target.ts'
import { textDigest } from './text-digest.ts'

/** Register a streaming SHA-256 reader without returning file contents.
 * @param ctx - lifecycle owner with tools, filesystem, and working-directory services.
 */
export function applyReadDigestTool(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'read_digest',
    description: 'Compute the SHA-256 of complete provider-decoded UTF-8 text before newline normalization. Use it as edit.expected_sha256; read the file separately to review its content. Rejects a file changed during acquisition.',
    parameters: { file_path: { type: 'string', required: true } },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        path: { type: 'string', required: true },
        sha256: { type: 'string', required: true },
      } },
      render: (_args, value) => [{ type: 'text', text: `${value.path}\nSHA-256: ${value.sha256}` }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (!args.file_path.trim()) throw new ToolArgsError(['file_path must be non-empty'])
      const { target, info } = await resolveRegularReadTarget(ctx, exec, args.file_path)
      const chunks = await ctx.fs.streamText(target, exec.signal)
      const sha256 = await textDigest(chunks, exec.signal)
      const after = await ctx.fs.stat(target, exec.signal)
      if (after?.version !== info.version) throw new FsError('File changed while computing its digest. Read it again.', 'FS_STALE_VERSION')
      exec.signal.throwIfAborted()
      return { path: ctx.fs.processPath(target), sha256 }
    },
  }))
}
