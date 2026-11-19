/** Strict result interpretation through the native executor and real tool registry. */
import { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { runUnittest, validTestConfig } from '../src/unittest.ts'

it('rejects zero tests, failure flags, skips, incomplete output, interruption and background outcomes', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await ctx.plugin(NativeExecutor)
    type Json = string | number | boolean | null | Json[] | { [key: string]: Json }
    let outcome: Record<string, Json> = {}
    let command = ''
    ctx.tools.register(defineTool({ name: 'pwsh', description: 'Evaluator process fixture',
      parameters: { command: { type: 'string', required: true } },
      output: { schema: { type: 'object', additionalProperties: true, properties: {} }, render: () => [] },
      execute: async (args) => { command = args.command; return outcome },
    }))
    const { exec } = await new ToolExecutionPipeline(ctx).prepare({ name: 'present', arguments: {},
      callId: ToolCallId('verify'), signal: new AbortController().signal })
    const workspace = join(tmpdir(), 'lyagent-unit-workspace')
    const config = { python: join(tmpdir(), 'trusted-python'), root: join(tmpdir(), 'lyagent-unit-evaluator'),
      files: [{ path: 'test_result.py', sha256: 'a'.repeat(64) }], minTests: 1, timeoutMs: 1000 }
    expect(validTestConfig(config)).toBe(true)
    expect(validTestConfig({ ...config, minTests: 0 })).toBe(false)
    expect(validTestConfig({ ...config, files: [{ path: '../test.py', sha256: 'a'.repeat(64) }] })).toBe(false)
    const report = { tests: 1, failures: 0, errors: 0, skipped: 0, successful: true }
    const base = { kind: 'foreground', exitCode: 0, signal: null, timedOut: false, aborted: false,
      stdout: { text: JSON.stringify(report), truncated: false } }
    outcome = base
    expect(await runUnittest(ctx, exec, config, workspace)).toContain('1 tests, exit 0')
    expect(command).toContain(' -I -c ')
    for (const changes of [{ tests: 0 }, { failures: 1 }, { errors: 1 }, { skipped: 1 }, { successful: false }]) {
      outcome = { ...base, stdout: { text: JSON.stringify({ ...report, ...changes }), truncated: false } }
      expect(await runUnittest(ctx, exec, config, workspace)).toBeUndefined()
    }
    for (const changes of [{ kind: 'background' }, { kind: 'promoted' }, { exitCode: 1 }, { timedOut: true },
      { aborted: true }, { signal: 'SIGTERM' }, { stopped: 'user' },
      { stdout: { text: JSON.stringify(report), truncated: true } }, { stdout: { text: 'not json', truncated: false } },
      { sandbox: { denied: true } }, { sandbox: { denied: false, runnerFailed: true } }]) {
      outcome = { ...base, ...changes }
      expect(await runUnittest(ctx, exec, config, workspace)).toBeUndefined()
    }
    outcome = base
    expect(await runUnittest(ctx, exec, { ...config, root: join(workspace, 'tests') }, workspace)).toBeUndefined()
    for (const [changes, expected] of [
      [{ timedOut: true }, 'deadline'],
      [{ kind: 'background' }, 'foreground'],
      [{ exitCode: 1 }, 'unsuccessfully'],
      [{ stdout: { text: 'invalid', truncated: false } }, 'JSON'],
    ] as const) {
      outcome = { ...base, ...changes }
      let reason = ''
      expect(await runUnittest(ctx, exec, config, workspace, (message) => { reason = message })).toBeUndefined()
      expect(reason).toContain(expected)
    }
  } finally { await ctx.fiber.dispose() }
})
