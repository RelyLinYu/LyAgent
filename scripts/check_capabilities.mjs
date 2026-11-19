import path from 'node:path';
import { auditReadability } from './audit_readability.mjs';

export async function checkCapabilities(page, out) {
  await page.getByRole('button', { name: '能力', exact: true }).click();
  const region = page.getByRole('region', { name: '能力管理', exact: true });
  await region.getByRole('button', { name: '检查技能 evidence-review', exact: true }).click();
  await region.getByRole('region', { name: '技能内容', exact: true }).getByRole('heading', { name: 'evidence-review · 内容校验通过', exact: true }).waitFor();
  await region.getByRole('button', { name: '检测 MCP 连接', exact: true }).click();
  try { await region.getByRole('region', { name: 'MCP 工具目录', exact: true }).getByRole('heading', { name: '连接成功', exact: true }).waitFor(); } catch (error) { await page.screenshot({ path: path.join(out, 'mcp-probe-failed.png'), fullPage: true }); throw Error(String(error) + '\n' + await region.innerText()); }
  await region.getByText('reference_rules', { exact: true }).last().click();
  await region.getByRole('checkbox', { name: '启用 Skills 与 MCP', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="能力管理"]')?.textContent.includes('执行器未启用'));
  if (!await region.getByRole('button', { name: '检测 MCP 连接', exact: true }).isDisabled()) throw Error('Disabled MCP still offers probe');
  await region.getByRole('checkbox', { name: '启用 Skills 与 MCP', exact: true }).click();
  await region.getByRole('button', { name: '检测 MCP 连接', exact: true }).click();
  await region.getByRole('region', { name: 'MCP 工具目录', exact: true }).getByRole('heading', { name: '连接成功', exact: true }).waitFor();
  for (const width of [1440, 800]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 800 && await page.locator('.sidebar').isVisible()) await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Capabilities overflow');
    await page.screenshot({ path: path.join(out, `capabilities-${width}.png`), fullPage: true });
    await page.locator('.conversation-scroll').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: path.join(out, `capabilities-top-${width}.png`), fullPage: true });
    await auditReadability(page, out, 'capabilities');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  if (!await page.locator('.sidebar').isVisible()) await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await page.getByRole('button', { name: '对话', exact: true }).click();
}
