import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs'

const root = path.resolve(process.argv[2] ?? '.')
const port = process.argv[3] ?? '8798'
const state = JSON.parse(await fs.readFile(path.join(root, `artifacts/dsh-native/managed-${port}.json`), 'utf8'))
const url = (await fs.readFile(state.stdout, 'utf8')).match(/dsh web: (http:\/\/[^\s]+)/)?.[1]
assert(url, 'Missing native startup URL')
const out = path.join(root, `artifacts/dsh-native/knowledge-browser-${Date.now()}`)
await fs.mkdir(out, { recursive: true })
const browser = await chromium.launch({ channel: 'msedge', headless: true })
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  await page.waitForTimeout(3000)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '打开右侧边栏', exact: true }).click()
  await page.getByRole('button', { name: '知识库', exact: true }).click()
  await page.getByRole('button', { name: '加载集合', exact: true }).click()
  await page.getByRole('button', { name: '刷新', exact: true }).waitFor()
  assert.equal(await page.getByLabel('集合标识', { exact: true }).count(), 0)
  const title = `Synthetic acceptance ${Date.now()}`
  await page.getByLabel('集合名称', { exact: true }).fill(title)
  await page.getByLabel('文本文件', { exact: true }).setInputFiles({ name: 'acceptance.txt', mimeType: 'text/plain',
    buffer: Buffer.from('Synthetic acceptance fixture. Delivery deadline: Friday.') })
  await page.getByRole('button', { name: '导入文件', exact: true }).click()
  const row = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
  await row.waitFor()
  assert.equal(await row.getByText(/已授权/).count(), 0)
  await row.getByRole('button', { name: '用于当前对话', exact: true }).click()
  await row.getByText(/已授权 v1/).waitFor()
  await page.getByRole('button', { name: '撤销全部授权', exact: true }).click()
  await row.getByText(/已授权 v1/).waitFor({ state: 'hidden' })
  await row.getByRole('button', { name: '导入新版本', exact: true }).click()
  await page.getByRole('button', { name: '导入文件', exact: true }).click()
  await row.getByRole('button', { name: '版本 2', exact: true }).waitFor()
  await row.getByRole('button', { name: '版本 2', exact: true }).click()
  await page.getByRole('menuitem', { name: '1', exact: true }).click()
  await row.getByRole('button', { name: '版本 1', exact: true }).waitFor()
  await page.screenshot({ path: path.join(out, 'desktop.png') })
  const closeSidebar = page.getByRole('button', { name: '收起侧边栏', exact: true })
  if (await closeSidebar.isVisible()) await closeSidebar.click()
  await page.setViewportSize({ width: 390, height: 960 })
  await page.waitForTimeout(500)
  await row.getByRole('button', { name: '归档', exact: true }).click()
  await row.getByText(/已归档/).waitFor()
  await page.screenshot({ path: path.join(out, 'mobile.png') })
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
  assert.equal(overflow, false)
  assert.deepEqual(errors, [])
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ port, title, errors, overflow,
    importedWithoutGrant: true, grantRevoke: true, newVersion: true, versionMenu: true, archive: true,
    scope: 'Native uploaded text and human knowledge commands only; no model task execution.' }, null, 2))
  console.log(JSON.stringify({ out, passed: true }))
} finally { await browser.close() }
