import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { auditReadability } from './audit_readability.mjs';
const base = process.argv[2] || 'http://127.0.0.1:8777';
const out = path.resolve('artifacts/release-surface', String(Date.now()));
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const [width, height] of [[1280, 800], [1440, 900], [1920, 1080], [800, 900]]) {
    const page = await browser.newPage({ viewport: { width, height }, reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.getByRole('button', { name: '连接模型', exact: true }).click();
    await page.getByRole('textbox', { name: '模型 API 地址', exact: true }).waitFor();
    await auditReadability(page, out, 'unconfigured-model-form');
    if (process.env.LYAGENT_SURFACE_WORKSPACE) {
      await page.getByRole('button', { name: '对话', exact: true }).click();
      const draft = 'Read my project after explicit authorization';
      await page.getByRole('textbox', { name: '消息', exact: true }).fill(draft);
      await page.getByRole('checkbox', { name: '任务验收', exact: true }).check();
      await page.getByRole('textbox', { name: '验收目标', exact: true }).waitFor();
      if (await page.getByText('此会话工作区权限已撤回，请新建会话后授权', { exact: true }).count()) throw Error('Unconfigured workspace mislabeled revoked');
      await page.getByRole('button', { name: '授权工作区', exact: true }).click();
      await page.getByRole('button', { name: '返回任务', exact: true }).waitFor();
      await page.getByRole('textbox', { name: '工作区绝对路径', exact: true }).fill('relative/not-authorized');
      await page.getByRole('button', { name: '应用工作区授权', exact: true }).click();
      await page.getByRole('alert').waitFor();
      if (await page.getByRole('textbox', { name: '工作区绝对路径', exact: true }).inputValue() !== 'relative/not-authorized') throw Error('Failed authorization lost input');
      await page.getByRole('textbox', { name: '工作区绝对路径', exact: true }).fill(process.env.LYAGENT_SURFACE_WORKSPACE);
      await page.getByRole('checkbox', { name: '允许逐次审批写入', exact: true }).check();
      await page.getByRole('checkbox', { name: '启用团队与工作流', exact: true }).check();
      await page.getByRole('textbox', { name: '独立验收目录', exact: true }).fill(process.env.LYAGENT_SURFACE_EVALUATION);
      await page.getByRole('checkbox', { name: '允许逐次审批运行测试', exact: true }).check();
      const apply = page.getByRole('button', { name: '应用工作区授权', exact: true });
      if (!await apply.isDisabled()) throw Error('Missing trusted-code consent');
      await page.getByRole('checkbox', { name: '确认工作区与验收代码可信（非系统沙箱）', exact: true }).check();
      await apply.click();
      await page.getByText('工作区授权已应用 · 仅本次服务有效', { exact: true }).waitFor();
      await page.getByRole('button', { name: '配置', exact: true }).waitFor();
      await page.screenshot({ path: path.join(out, `workspace-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '返回并继续任务', exact: true }).click();
      if (await page.getByRole('textbox', { name: '消息', exact: true }).inputValue() !== draft) throw Error('Authorization lost draft');
      if (await page.getByRole('checkbox', { name: '任务验收', exact: true }).isDisabled()) throw Error('Authorization did not unlock task');
      await page.screenshot({ path: path.join(out, `task-return-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '管理工作区', exact: true }).click();
      await page.getByRole('checkbox', { name: '允许逐次审批写入', exact: true }).uncheck();
      await page.getByRole('checkbox', { name: '启用团队与工作流', exact: true }).uncheck();
      await page.getByRole('textbox', { name: '工作区绝对路径', exact: true }).fill('');
      await apply.click();
      await page.getByRole('button', { name: '配置', exact: true }).waitFor({ state: 'hidden' });
    }
    await page.getByRole('button', { name: '对话', exact: true }).click();
    for (const tab of ['轨迹', '上下文', '知识', '能力']) {
      await page.getByRole('button', { name: tab, exact: true }).click();
      await auditReadability(page, out, 'empty-' + tab);
    }
    await page.getByRole('button', { name: '对话', exact: true }).click();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('Release layout check\n' + 'LongPathSegment'.repeat(75));
    if (!await page.locator('.sidebar').isVisible()) await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '设置', exact: true });
    await dialog.waitFor();
    for (let i = 0; i < 15; i++) {
      await page.keyboard.press('Tab');
      if (!await dialog.evaluate(el => el.contains(document.activeElement))) throw Error('Focus escaped settings');
    }
    await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 8;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 8, 8);
      window.__releaseBitmap = canvas.toDataURL().split(',')[1];
    });
    const bitmap = await page.evaluate(() => window.__releaseBitmap);
    await dialog.locator('input[accept="image/*"]').setInputFiles({ name: 'white.png', mimeType: 'image/png', buffer: Buffer.from(bitmap, 'base64') });
    await page.getByRole('button', { name: '移除背景', exact: true }).waitFor();
    await auditReadability(page, out, 'settings-white-wallpaper');
    await page.getByRole('checkbox', { name: '减少透明效果', exact: true }).check();
    if (!await page.locator('.app').evaluate(el => el.classList.contains('opaque'))) throw Error('Opaque toggle failed');
    await auditReadability(page, out, 'settings-opaque');
    await page.screenshot({ path: path.join(out, `settings-${width}.png`), fullPage: true });
    await page.getByRole('button', { name: '配置模型', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('textbox', { name: '模型 API 地址', exact: true }).waitFor();
    if (await page.locator('.sidebar').isVisible() && width < 1000) await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
    await page.getByRole('button', { name: '对话', exact: true }).click();
    const composer = await page.locator('.composer').boundingBox();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow || !composer || composer.y + composer.height > height + 1 || errors.length) throw Error(JSON.stringify({ width, overflow, composer, errors }));
    await page.screenshot({ path: path.join(out, `conversation-${width}.png`), fullPage: true });
    results.push({ width, height, focusContained: true, configurationReachable: true, opaque: true, overflow, errors });
    await page.close();
  }
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify({ mode: 'real-production-http-no-model-submission', base, results, limits: 'Computed CSS contrast only; wallpaper pixel contrast, native IME and independent review are not claimed.' }, null, 2));
  console.log(JSON.stringify({ out, passed: true, sizes: results.length }));
} finally { await browser.close(); }
