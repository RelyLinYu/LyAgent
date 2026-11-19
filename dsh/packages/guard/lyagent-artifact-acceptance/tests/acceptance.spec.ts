/** Native pipeline checks over real temporary files; no model or shell calls. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import * as Policy from '../src/index.ts'

it('rejects repair worker routes without a byte bound or explicit nonblank routing and tool names', async () => {
  const ctx = new Context()
  const config: Policy.Config = { taskRuns: true, maxRepairs: 1,
    artifacts: [{ path: 'result.md', minBytes: 1, maxBytes: 100, includes: [] }],
    repairTargets: [{ path: 'result.md', workOrder: 'task-1',
      worker: { provider: 'scripted', model: 'model', readOnlyTools: ['read'] } }],
  }
  try {
    await expect(Policy.apply(ctx, config)).rejects.toThrow('Repair targets require')
    config.tests = { python: join(tmpdir(), 'python.exe'), root: join(tmpdir(), 'evaluator'),
      files: [{ path: 'test_result.py', sha256: 'a'.repeat(64) }], minTests: 1, timeoutMs: 1000, maxChildResultBytes: 100 }
    for (const worker of [{
      provider: ' ', model: 'model', readOnlyTools: ['read'],
    }, { provider: 'scripted', model: ' ', readOnlyTools: ['read'] },
    { provider: 'scripted', model: 'model', readOnlyTools: [' '] }]) {
      config.repairTargets = [{ path: 'result.md', workOrder: 'task-1', worker }]
      await expect(Policy.apply(ctx, config)).rejects.toThrow('Repair targets require')
    }
    const candidate = { id: 'reviewer', enabled: true, capabilities: ['review'],
      provider: 'scripted', model: 'model', readOnlyTools: ['read'] }
    for (const candidates of [[], [candidate, candidate], [{ ...candidate, id: ' ' }],
      [{ ...candidate, capabilities: [' '] }], [{ ...candidate, provider: ' ' }],
      [{ ...candidate, maxActive: 0 }], [{ ...candidate, maxActive: 1.5 }]]) {
      config.repairTargets = [{ path: 'result.md', workOrder: 'task-1', candidates }]
      await expect(Policy.apply(ctx, config)).rejects.toThrow('Repair targets require')
    }
  } finally { await ctx.fiber.dispose() }
})

it('checks every delivery version, blocks missing text and empty files, and unloads cleanly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-acceptance-'))
  const ctx = new Context()
  try {
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(NativeExecutor)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    const path = join(root, 'result.md')
    ctx.tools.register(defineTool({ name: 'present', description: 'Test delivery declaration', parameters: {},
      output: { schema: { type: 'object', additionalProperties: false, properties: {
        files: { type: 'array', required: true, items: { type: 'object', additionalProperties: false,
          properties: { path: { type: 'string', required: true } } } },
      } }, render: () => [{ type: 'text', text: 'Declared' }] },
      execute: async () => ({ files: [{ path }] }),
    }))
    const policy = await ctx.plugin(Policy, { artifacts: [{ path, minBytes: 1, maxBytes: 100, includes: ['required'] }] })
    const agent = { session: { header: { cwd: root } } }
    const call = () => executeToolFixture(ctx, { agent: agent as never, name: 'present', arguments: {},
      callId: ToolCallId('delivery'), signal: new AbortController().signal })
    await writeFile(path, 'missing')
    expect(await call()).toMatchObject({ isError: true, error: { info: { code: 'LYAGENT_ARTIFACT_REJECTED' } } })
    await writeFile(path, 'required content')
    const accepted = await call()
    expect(accepted.isError).toBe(false)
    expect(accepted.content.some(block => block.type === 'text' && block.text.includes('SHA-256'))).toBe(true)
    const changeAfterCheck = ctx.on('tools/post-execute', async (_exec, _result, next) => {
      await writeFile(path, 'changed by another policy')
      return next()
    })
    try {
      expect(await call()).toMatchObject({ isError: true, error: { info: { code: 'LYAGENT_ARTIFACT_REJECTED' } } })
    } finally { changeAfterCheck() }
    await writeFile(path, '')
    expect((await call()).isError).toBe(true)
    await writeFile(path, new Uint8Array([0xff, 0xfe]))
    expect(await call()).toMatchObject({ isError: true, error: { info: { code: 'LYAGENT_ARTIFACT_REJECTED' } } })
    await writeFile(path, '')
    expect(await readFile(path, 'utf8')).toBe('')
    await policy.dispose()
    const digestPolicy = await ctx.plugin(Policy, { artifacts: [{ path, minBytes: 1, maxBytes: 100, includes: [],
      sha256: createHash('sha256').update('pinned').digest('hex') }] })
    await writeFile(path, 'different')
    expect(await call()).toMatchObject({ isError: true, error: { info: { code: 'LYAGENT_ARTIFACT_REJECTED' } } })
    await writeFile(path, 'pinned')
    expect((await call()).isError).toBe(false)
    await writeFile(path, 'x'.repeat(101))
    expect(await call()).toMatchObject({ isError: true, error: { info: { code: 'LYAGENT_ARTIFACT_REJECTED' } } })
    await digestPolicy.dispose()
    const missingPolicy = await ctx.plugin(Policy, { artifacts: [{
      path: join(root, 'undeclared.md'), minBytes: 1, maxBytes: 100, includes: [],
    }] })
    expect(await call()).toMatchObject({ isError: true, error: { info: { code: 'LYAGENT_ARTIFACT_REJECTED' } } })
    await missingPolicy.dispose()
    expect((await call()).isError).toBe(false)
  } finally {
    try { await ctx.fiber.dispose() } finally { await rm(root, { recursive: true, force: true }) }
  }
})
