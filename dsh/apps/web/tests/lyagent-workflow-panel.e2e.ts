/** Native workflow forms exercise real zero-model command persistence. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh } from './support.ts'

it('saves roles, pinned team members and workflows from native forms without model requests', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-workflow-panel-'))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const overlay = join(root, 'workflow.json')
    await writeFile(overlay, JSON.stringify([{ insert: [
      { id: 'ui-lyagent-workflows', name: '@deepseek-ai/dsh-client-ui-lyagent-workflows' },
      { id: 'lyagent-workflow-library', name: '@deepseek-ai/dsh-lyagent-workflow-library',
        config: { maxDefinitionBytes: 65536, maxEntries: 20 } },
    ] }]))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    browser = await chromium.launch({ channel: 'msedge' })
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    const console = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    await page.getByRole('button', { name: '打开右侧边栏', exact: true }).click()
    await page.getByRole('button', { name: '编排', exact: true }).click()
    await page.getByRole('button', { name: '刷新', exact: true }).click()
    await page.getByText('暂无已保存定义', { exact: true }).waitFor()
    const panel = page.getByRole('tabpanel').filter({ has: page.getByLabel('名称', { exact: true }) })
    await panel.getByLabel('名称', { exact: true }).fill('Synthetic reviewer')
    await panel.getByLabel('职责说明', { exact: true }).fill('Review only synthetic evidence')
    await panel.getByLabel('供应商', { exact: true }).fill('fixture')
    await panel.getByLabel('模型', { exact: true }).fill('scripted')
    expect(await page.getByRole('tab', { name: '团队', exact: true }).isDisabled()).toBe(true)
    await panel.getByRole('button', { name: '保存版本', exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    await page.getByRole('tab', { name: '团队', exact: true }).click()
    await panel.getByLabel('名称', { exact: true }).fill('Synthetic review team')
    await panel.getByRole('button', { name: '添加成员', exact: true }).click()
    await panel.getByLabel('成员职责名', { exact: true }).fill('review')
    await panel.getByRole('button', { name: '角色版本', exact: true }).click()
    await page.getByRole('menuitem', { name: 'Synthetic reviewer v1', exact: true }).click()
    await panel.getByRole('button', { name: '保存版本', exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    await page.getByRole('tab', { name: '流程', exact: true }).click()
    await panel.getByLabel('名称', { exact: true }).fill('Synthetic workflow ' + '长名称'.repeat(30))
    await panel.getByLabel('流程脚本', { exact: true }).fill('return { marker: "workflow-panel" }')
    await panel.getByRole('button', { name: '保存版本', exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    await panel.getByRole('button', { name: '选择', exact: true }).click()
    expect(await panel.getByLabel('流程脚本', { exact: true }).inputValue()).toContain('workflow-panel')
    await panel.getByLabel('流程脚本', { exact: true }).fill('return { marker: "workflow-panel-v2" }')
    await panel.getByRole('button', { name: '保存版本', exact: true }).click()
    await page.getByText('已保存', { exact: true }).waitFor()
    await panel.getByRole('button', { name: '运行所选版本', exact: true }).click()
    await expect.poll(() => scaffold?.ctx.agents.list()[0]?.session.snapshotEvents()
      .filter(event => event.type === 'tool-workflow/run-end'), { timeout: 30000 }).toHaveLength(1)
    await panel.getByRole('spinbutton').fill('1')
    await panel.getByRole('button', { name: '选择', exact: true }).click()
    expect(await panel.getByLabel('流程脚本', { exact: true }).inputValue()).toBe('return { marker: "workflow-panel" }')
    await panel.getByLabel('流程脚本', { exact: true }).fill('return { marker: "retained-draft" }')
    expect(await page.getByRole('tab', { name: '团队', exact: true }).isDisabled()).toBe(true)
    const out = resolve('../artifacts/dsh-native', `workflow-panel-${Date.now()}`)
    await mkdir(out, { recursive: true })
    const collapse = page.getByRole('button', { name: '收起侧边栏', exact: true })
    if (await collapse.isVisible()) await collapse.click()
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 })
      await page.emulateMedia({ colorScheme: width === 1440 ? 'light' : 'dark' })
      await page.screenshot({ path: join(out, `${width}.png`), fullPage: true })
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    }
    expect(console.pageErrors).toEqual([])
    expect(scaffold.ctx.agents.list().flatMap(agent => agent.session.snapshotEvents()).filter(event => event.type === 'request/header')).toHaveLength(0)
    await writeFile(join(out, 'report.json'), JSON.stringify({ passed: true, paidRequests: 0, pageErrors: console.pageErrors }))
  } finally {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
}, 120000)
