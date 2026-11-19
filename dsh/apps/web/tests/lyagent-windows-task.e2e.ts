/** Windows acceptance through the shipped Web tools; only model output is scripted. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ReplayOverrideDoc } from '@deepseek-ai/dsh-llm-replay'
import type {} from '@deepseek-ai/dsh-workspace-changes'
import { launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage } from './support.ts'

function call(id: string, name: string, args: Record<string, string>): StreamChunk[] {
  const callId = ToolCallId(id)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: callId, name, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 16, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

const REPLAY: ReplayOverrideDoc = [
  { kind: 'chunks', chunks: call('windows-read', 'read', { file_path: 'intro.md' }) },
  { kind: 'chunks', chunks: call('windows-edit', 'edit', { file_path: 'intro.md', old_string: '# Sample', new_string: '# Updated' }) },
  { kind: 'chunks', chunks: call('windows-write', 'write', { file_path: 'src/util.ts', content: 'export const add = (a: number, b: number) => a + b;\n' }) },
  { kind: 'chunks', chunks: call('windows-pwsh', 'pwsh', { description: 'Append the isolated task marker', command: "[IO.File]::AppendAllText((Join-Path (Get-Location) 'notes.txt'), \"done`n\")" }) },
  { kind: 'chunks', chunks: [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: 'WINDOWS_TASK_FINISHED' },
    { type: 'block-end', index: 0, block: { type: 'text', text: 'WINDOWS_TASK_FINISHED' } },
    { type: 'usage', usage: { inputTokens: 16, outputTokens: 8 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ] },
]

describe.skipIf(process.platform !== 'win32' || webSnapshotMode() === 'record')('LyAgent Windows native task acceptance', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let root: string | undefined
  let cwd: string

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'lyagent-windows-task-'))
    const replayOverride = join(root, 'replay.override.json')
    await writeFile(replayOverride, JSON.stringify(REPLAY))
    // This authored Windows lane does not compare a borrowed Linux Session golden.
    // Replay consumption, real tools, on-disk effects and logged outcomes remain checked.
    scaffold = await launchWebScaffold({ replayFixture: join(root, 'override-only.jsonl'), replayOverride, compareReplaySession: false })
    cwd = join(scaffold.workspaceCwd, 'workspace')
    await mkdir(cwd, { recursive: true })
    await writeFile(join(cwd, 'intro.md'), '# Sample\n\nBody remains.\n')
    await writeFile(join(cwd, 'notes.txt'), 'start\n')
    await writeFile(join(cwd, 'untouched.txt'), 'DO NOT CHANGE\n')
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=acceptance@example.com', '-c', 'user.name=acceptance', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('commit', '-q', '-m', 'seed')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try { await scaffold?.close() } finally {
        if (root !== undefined) await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('edits and creates files, executes real PowerShell, and persists the resulting changes', async () => {
    if (scaffold === undefined) throw new Error('Web scaffold is unavailable')
    const console = watchConsole(page)
    const settled = scaffold.whenTurnSettled()
    const composer = page.locator('[data-composer-input]').last()
    await composer.fill('Update intro.md, create src/util.ts, then append done to notes.txt using PowerShell. Leave untouched.txt unchanged.')
    await composer.press('Enter')
    const sessionId = await settled
    await page.getByText('WINDOWS_TASK_FINISHED', { exact: true }).waitFor()
    expect(await readFile(join(cwd, 'intro.md'), 'utf8')).toBe('# Updated\n\nBody remains.\n')
    expect(await readFile(join(cwd, 'src/util.ts'), 'utf8')).toBe('export const add = (a: number, b: number) => a + b;\n')
    expect(await readFile(join(cwd, 'notes.txt'), 'utf8')).toBe('start\ndone\n')
    expect(await readFile(join(cwd, 'untouched.txt'), 'utf8')).toBe('DO NOT CHANGE\n')
    const session = scaffold.ctx.sessions.get(sessionId)
    if (session === undefined) throw new Error('Task Session is unavailable')
    const events = session.snapshotEvents()
    const results = events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(4)
    for (const result of results) expect(result.data.message.isError).not.toBe(true)
    const announced = events.filter(event => event.type === 'workspace/changes').at(-1)
    if (announced === undefined) throw new Error('Task has no changed-files announcement')
    const summary = scaffold.ctx.workspaceChanges.summary(sessionId, announced.seq)
    expect(summary?.files.map(file => file.display)).toEqual(['intro.md', 'notes.txt', 'src/util.ts'])
    expect(console.pageErrors).toEqual([])
    await page.reload({ waitUntil: 'load' })
    await page.getByText('WINDOWS_TASK_FINISHED', { exact: true }).waitFor()
    expect(console.pageErrors).toEqual([])
  })
})
