/** Keyless native task sidebar over real Loader, commands and durable task records. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-lyagent-artifact-acceptance'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh } from './support.ts'

it('registers, cancels and executes independently checked tasks through the native sidebar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-task-panel-'))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const evaluator = "import pathlib, unittest\nclass Delivery(unittest.TestCase):\n def test_required(self):\n  self.assertEqual(pathlib.Path('report.md').read_text(encoding='utf-8'), 'Synthetic verified delivery\\n')\n"
    await writeFile(join(root, 'test_delivery.py'), evaluator)
    const python = execFileSync('python', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
    const overlay = join(root, 'tasks.yml')
    await writeFile(overlay, JSON.stringify([{ insert: [
      { id: 'ui-lyagent-tasks', name: '@deepseek-ai/dsh-client-ui-lyagent-tasks' },
      { id: 'lyagent-budget', name: '@deepseek-ai/dsh-lyagent-budget', config: {
        batchId: 'keyless-task-panel', maxRequests: 6, maxTokens: 100, reservationTokens: 10, maxConcurrent: 1,
        runLimits: { maxRequests: 3, maxTokens: 50, childMaxRequests: 1, childMaxTokens: 10 },
      } },
      { id: 'lyagent-artifact-check', name: '@deepseek-ai/dsh-lyagent-artifact-acceptance', config: {
        taskRuns: true, maxRepairs: 1, artifacts: [{ path: 'report.md', minBytes: 1, maxBytes: 4096, includes: [] }],
        tests: { python, root, files: [{ path: 'test_delivery.py', sha256: createHash('sha256').update(evaluator).digest('hex') }],
          minTests: 1, timeoutMs: 15000 },
      } },
    ] }]))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    browser = await chromium.launch({ channel: 'msedge' })
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    const console = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: '打开右侧边栏', exact: true }).click()
    await page.getByRole('button', { name: '任务', exact: true }).click()
    await page.getByRole('button', { name: '加载任务', exact: true }).click()
    await page.getByText('暂无已登记任务', { exact: true }).waitFor()
    expect(await page.getByText('report.md', { exact: true }).count()).toBe(1)
    const objective = 'Synthetic sidebar acceptance: independently audited delivery ' + '长任务目标'.repeat(20)
    await page.getByLabel('任务目标', { exact: true }).fill(objective)
    await page.getByRole('button', { name: '登记任务', exact: true }).click()
    const row = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: objective, exact: true }) })
    await row.getByText('未开始', { exact: true }).waitFor()
    const out = resolve('../artifacts/dsh-native', `task-panel-${Date.now()}`)
    await mkdir(out, { recursive: true })
    await page.screenshot({ path: join(out, 'desktop.png'), fullPage: true })
    await row.getByRole('button', { name: '取消', exact: true }).click()
    await row.getByText('已取消', { exact: true }).waitFor()
    const close = page.getByRole('button', { name: '收起侧边栏', exact: true })
    if (await close.isVisible()) await close.click()
    await page.setViewportSize({ width: 390, height: 960 })
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.screenshot({ path: join(out, 'mobile.png'), fullPage: true })
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    const agent = scaffold.ctx.agents.list()[0]
    if (agent === undefined) throw new Error('Missing task owner')
    const tasks = scaffold.ctx.get('lyagentTaskRuns')
    expect(tasks?.list(agent).tasks).toMatchObject([{ objective: objective.slice(0, 240), state: 'cancelled' }])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'request/header')).toHaveLength(0)
    class DeliveryAdapter extends LlmAdapter {
      constructor(private readonly taskCwd: string, private readonly prefix: string) { super() }
      private step = 0
      override async *stream(): AsyncIterable<StreamChunk> {
        const index = this.step++
        const step = index % 3
        const output = join(this.taskCwd, 'report.md')
        if (step < 2) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' }
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`${this.prefix}-${index}`),
            name: step === 0 ? 'write' : 'present', arguments: JSON.stringify(step === 0
              ? { file_path: output, content: 'Synthetic verified delivery\n' } : { files: [{ path: output }] }) } }
        }
        yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 2 } }
        yield { type: 'finish', reason: { kind: step < 2 ? 'tool-calls' : 'stop' } }
      }
    }
    const taskCwd = await scaffold.ctx.workingDirectory.ensure(agent)
    scaffold.ctx.llm.registerAdapter(['keyless-task-panel'], new DeliveryAdapter(taskCwd, 'positive'))
    agent.model.select({ provider: 'keyless-task-panel', model: 'scripted' })
    scaffold.ctx.permissionPresets.set(agent.session, 'danger-full-access')
    await page.getByLabel('任务目标', { exact: true }).fill('Synthetic independently tested report')
    await page.getByText('附加交付要求', { exact: true }).click()
    await page.getByLabel('必需产物路径（相对于工作区）', { exact: true }).fill('report.md')
    await page.getByLabel('必含内容', { exact: true }).fill('Synthetic verified delivery')
    await page.getByRole('button', { name: '登记任务', exact: true }).click()
    const executable = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Synthetic independently tested report', exact: true }) })
    await executable.getByRole('button', { name: '运行', exact: true }).click()
    try { await executable.getByText('已完成', { exact: true }).waitFor({ timeout: 30000 }) } catch (error) {
      await page.screenshot({ path: join(out, 'execution-failed.png'), fullPage: true })
      await writeFile(join(out, 'execution-failed.json'), JSON.stringify({ tasks: tasks?.list(agent),
        records: tasks?.list(agent).tasks.map((task: { id: string }) => tasks.read(task.id)),
        events: agent.session.snapshotEvents() }, null, 2))
      throw error
    }
    expect(tasks?.list(agent).tasks.some((task: { state: string }) => task.state === 'completed')).toBe(true)
    const completed = tasks?.list(agent).tasks.find((task: { state: string }) => task.state === 'completed')
    expect(completed && tasks?.read(completed.id)?.requirements).toEqual([{
      path: 'report.md', minBytes: 1, maxBytes: 4096, includes: ['Synthetic verified delivery'],
    }])
    expect(agent.session.snapshotEvents().filter(event => event.type === 'request/header')).toHaveLength(1)
    await page.screenshot({ path: join(out, 'mobile-completed.png'), fullPage: true })
    await page.getByLabel('任务目标', { exact: true }).fill('Synthetic rejection of missing required content')
    await page.getByLabel('必需产物路径（相对于工作区）', { exact: true }).fill('report.md')
    await page.getByLabel('必含内容', { exact: true }).fill('Absent required marker')
    await page.getByRole('button', { name: '登记任务', exact: true }).click()
    const rejected = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: 'Synthetic rejection of missing required content', exact: true }) })
    await rejected.getByRole('button', { name: '运行', exact: true }).click()
    await rejected.getByText('需处理', { exact: true }).waitFor({ timeout: 30000 })
    await rejected.getByText(/Task acceptance requires attention:/).waitFor()
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 960 })
      await page.emulateMedia({ colorScheme: width === 390 ? 'dark' : 'light' })
      await page.screenshot({ path: join(out, `attention-${width}.png`), fullPage: true })
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
      const reason = rejected.getByText(/Task acceptance requires attention:/)
      const box = await reason.boundingBox()
      expect(box?.width).toBeGreaterThan(0)
    }
    await writeFile(join(out, 'negative-evidence.json'), JSON.stringify({ tasks: tasks?.list(agent),
      records: tasks?.list(agent).tasks.map((task: { id: string }) => tasks.read(task.id)),
      events: agent.session.snapshotEvents() }, null, 2))
    expect(agent.session.snapshotEvents().some(event => event.type === 'tool/result'
      && event.data.message.content.some(block => block.type === 'text' && block.text.includes('Required text is absent:')))).toBe(true)
    expect(console.pageErrors).toEqual([])
    await writeFile(join(out, 'report.json'), JSON.stringify({ passed: true, paidRequests: 0, scriptedRequests: 6,
      scope: 'Real native registration, queued cancellation and explicit execution with write/present and independent Python artifact assertion; scripted model only.',
      pageErrors: console.pageErrors }, null, 2))
  } finally {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
}, 180000)
