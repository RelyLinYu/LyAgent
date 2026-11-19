/** Competition profile removes DSH's public developer/account surfaces. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold, watchConsole } from './scaffold.ts'
import { connectFreshWorkspaceZh } from './support.ts'

process.env.DSH_CLIENT_COMPETITION = 'true'

it('mounts only the competition workbench and direct settings entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lyagent-competition-surface-'))
  let scaffold: Awaited<ReturnType<typeof launchWebScaffold>> | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  try {
    const overlay = join(root, 'competition.json')
    const disabled = ['deepseek-account', 'llm-deepseek-account', 'message-feedback', 'ui-message-feedback',
      'plugin-inventory', 'ui-plugin-manager', 'ui-settings-plugin-inventory', 'ui-settings-plugins',
      'entry-customization', 'ui-agent-preset', 'schedule', 'ui-schedule', 'ui-settings-account',
      'ui-account-notifications', 'session-log-deepseek', 'ui-settings-session-log', 'product-analytics',
      'desktop-product-telemetry']
    await writeFile(overlay, JSON.stringify([
      ...disabled.map(id => ({ id, disabled: true })),
      { id: 'ui-brand-official', disabled: true },
      { insert: [{ id: 'ui-brand-lyagent', name: '@deepseek-ai/dsh-client-ui-brand-lyagent' }] },
    ]))
    scaffold = await launchWebScaffold({ extraOverlayPath: overlay })
    browser = await chromium.launch({ channel: 'msedge' })
    const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: 'zh-CN' })
    const console = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
    const later = page.getByRole('button', { name: '稍后配置', exact: true })
    try {
      await later.waitFor({ state: 'visible', timeout: 3000 })
      const onboarding = await page.locator('body').innerText()
      expect(onboarding).toContain('配置模型开始使用')
      expect(onboarding).not.toContain('DeepSeek 官方')
      expect(await page.getByRole('button', { name: '配置模型', exact: true }).count()).toBe(1)
      await later.click()
    } catch (_error: unknown) {
      // A configured workspace has no credential onboarding.
    }
    const body = await page.locator('body').innerText()
    for (const removed of ['插件', '自动化任务', 'Agent 预设', '预览版', '登录', '意见反馈']) {
      expect(body).not.toContain(removed)
    }
    expect(body).toContain('开始一项任务')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = await page.locator('body').innerText()
    expect(settings).toContain('通用设置')
    expect(settings).toContain('模型')
    for (const removed of ['内置插件', 'Agent 预设', '语言', '打开配置文件', '账号与余额', '上传 Session Log', '开发者工具']) {
      expect(settings).not.toContain(removed)
    }
    const out = resolve('../artifacts/dsh-native', `competition-surface-${Date.now()}`)
    await mkdir(out, { recursive: true })
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 960 })
      await page.screenshot({ path: join(out, `${width}.png`), fullPage: true })
      expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    }
    expect(console.pageErrors).toEqual([])
    await writeFile(join(out, 'report.json'), JSON.stringify({ passed: true, paidRequests: 0, pageErrors: console.pageErrors }))
  } finally {
    try { await browser?.close() } finally {
      try { await scaffold?.close() } finally { await rm(root, { recursive: true, force: true }) }
    }
  }
}, 120000)
