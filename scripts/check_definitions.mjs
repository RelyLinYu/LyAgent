import fs from 'node:fs/promises';
import path from 'node:path';
import { auditReadability } from './audit_readability.mjs';

export async function checkDefinitions(page, out) {
  await page.getByRole('button', { name: '配置', exact: true }).click();
  const editor = page.getByRole('region', { name: '版本配置', exact: true });
  const name = editor.getByRole('textbox', { name: '配置名称', exact: true });
  const body = editor.getByRole('textbox', { name: '配置定义', exact: true });
  const save = editor.getByRole('button', { name: '保存新版本', exact: true });
  const profile = { role: 'UI acceptance reader', model_ref: 'configured', tools: ['read_file'], capacity: 1 };
  await editor.getByRole('button', { name: 'JSON', exact: true }).click();
  await name.fill('ui-reader');
  await body.fill('{');
  await save.click();
  await editor.getByRole('alert').filter({ hasText: '有效 JSON' }).waitFor();
  if (await body.inputValue() !== '{') throw Error('Invalid JSON draft erased');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await page.getByRole('button', { name: '配置', exact: true }).click();
  if (await body.inputValue() !== '{') throw Error('Tab switch erased draft');
  await body.fill(JSON.stringify(profile, null, 2));
  await save.click();
  await editor.getByRole('status').filter({ hasText: '已保存版本 1' }).waitFor();
  await body.fill(JSON.stringify({ ...profile, capacity: 2 }, null, 2));
  await save.click();
  await editor.getByRole('status').filter({ hasText: '已保存版本 2' }).waitFor();
  const history = editor.getByRole('combobox', { name: '配置历史版本', exact: true });
  await history.selectOption('1');
  await page.waitForFunction(() => JSON.parse(document.querySelector('[aria-label="配置定义"]').value).capacity === 1);
  await body.fill(JSON.stringify({ ...profile, role: 'stale draft' }, null, 2));
  await save.click();
  await editor.getByRole('alert').filter({ hasText: '版本已变化' }).waitFor();
  if (!await body.inputValue().then(value => value.includes('stale draft'))) throw Error('Conflict erased draft');
  await editor.getByRole('button', { name: '丢弃草稿', exact: true }).click();
  await editor.getByRole('button', { name: 'ui-reader 版本 2', exact: true }).click();
  await history.waitFor();
  await editor.getByRole('button', { name: '复制为新配置', exact: true }).click();
  if (await name.inputValue() !== 'ui-reader-copy') throw Error('Copy identity incorrect');
  await save.click();
  await editor.getByRole('status').filter({ hasText: '已保存版本 1' }).waitFor();
  for (const width of [1440, 800]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 800 && await page.locator('.sidebar').isVisible()) await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Definitions page overflow');
    await page.screenshot({ path: path.join(out, `definitions-${width}.png`), fullPage: true });
  }
  await editor.getByRole('tab', { name: '团队', exact: true }).click();
  await name.fill('ui-team');
  await body.fill(JSON.stringify({ profiles: ['ui-reader@1'] }, null, 2));
  await save.click();
  await editor.getByRole('status').filter({ hasText: '已保存版本 1' }).waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  await editor.getByRole('tab', { name: '流程', exact: true }).click();
  await name.fill('ui-form-flow');
  await editor.getByRole('button', { name: '表单', exact: true }).click();
  await editor.getByRole('button', { name: '添加节点', exact: true }).click();
  await editor.getByRole('textbox', { name: '节点 1 目标', exact: true }).fill('Read the projected note');
  await editor.getByRole('textbox', { name: '节点 1 职责', exact: true }).fill('reader');
  await editor.getByRole('textbox', { name: '节点 1 文件', exact: true }).fill('note.md');
  await editor.getByRole('textbox', { name: '流程必需输出', exact: true }).fill('node-1');
  await save.click();
  await editor.getByRole('status').filter({ hasText: '已保存版本 1' }).waitFor();
  await editor.getByLabel('流程依赖图', { exact: true }).getByText('node-1', { exact: true }).waitFor();
  const settings = editor.getByRole('textbox', { name: '节点 1 工作单设置', exact: true });
  await settings.fill('{');
  if (await settings.evaluate(el => el.validity.valid)) throw Error('Invalid form JSON not blocked');
  await settings.fill(JSON.stringify({ id: 'node-1', goal: 'Read the projected note', role: 'reader', paths: ['note.md'], tools: ['read_file'] }));
  await editor.getByRole('textbox', { name: '流程必需输出', exact: true }).click();
  for (const width of [1440, 800]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 800 && await page.locator('.sidebar').isVisible()) await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Node form overflow');
    await page.screenshot({ path: path.join(out, `definition-form-${width}.png`), fullPage: true });
  }
  await editor.getByRole('button', { name: 'JSON', exact: true }).click();
  if (JSON.parse(await body.inputValue()).nodes[0].work_order.goal !== 'Read the projected note') throw Error('Form state lost in JSON mode');
  await editor.getByRole('button', { name: '表单', exact: true }).click();
  await editor.getByRole('button', { name: '添加节点', exact: true }).click();
  await editor.getByRole('combobox', { name: '节点 2 类型', exact: true }).selectOption('verification');
  await editor.getByRole('textbox', { name: '节点 2 前置', exact: true }).fill('node-1');
  await editor.getByRole('combobox', { name: '节点 2 修复流程', exact: true }).selectOption('ui-form-flow@1');
  await editor.getByRole('spinbutton', { name: '节点 2 修复轮数', exact: true }).fill('2');
  await editor.getByRole('textbox', { name: '流程必需输出', exact: true }).fill('node-2');
  await save.click();
  await editor.getByRole('status').filter({ hasText: '已保存版本 2' }).waitFor();
  for (const width of [1440, 800]) {
    await page.setViewportSize({ width, height: 900 });
    await editor.getByRole('combobox', { name: '节点 2 修复流程', exact: true }).scrollIntoViewIfNeeded();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Repair form overflow');
    await page.screenshot({ path: path.join(out, `definition-repair-${width}.png`), fullPage: true });
    await auditReadability(page, out, 'definition-repair');
  }
  await editor.getByRole('button', { name: 'JSON', exact: true }).click();
  const repair = JSON.parse(await body.inputValue()).nodes[1];
  if (repair.repair_ref !== 'ui-form-flow@1' || repair.max_repairs !== 2) throw Error('Repair settings lost');
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await fs.writeFile(path.join(out, 'definitions.json'), JSON.stringify({ mode: 'real-http-browser', invalidJsonRetained: true, tabDraftRetained: true, immutableRevisions: true, historicalRevisionRead: true, optimisticConflictRetained: true, copySaved: true, teamPinnedToHistory: true, widths: [1440, 800] }, null, 2));
}
