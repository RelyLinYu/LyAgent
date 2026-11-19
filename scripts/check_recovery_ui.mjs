import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const out = new URL(`../artifacts/recovery-ui/${Date.now()}/`, import.meta.url);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [1440, 800]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    let granted = true, decision = null, note = null, attempts = 0, inspections = 0;
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const conversation = { id: 'recovery-fixture', title: '恢复核对样例', created: 1 };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let body;
      if (path.endsWith('/events')) { await route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' }); return; }
      if (path === '/api/bootstrap') body = { token: 'fixture', configured: true, model: 'recovery UI fixture', tools_enabled: true };
      else if (path === '/api/conversations') body = [conversation];
      else if (path.endsWith('/recovery/inspect')) { inspections++; body = { observations: [{ turn_id: 'turn-1', invocation_id: 'write-1', conclusion: 'expected_content_observed' }] }; }
      else if (path.endsWith('/workspace/revoke')) { granted = false; body = { status: 'revoked' }; }
      else if (path.endsWith('/recovery/decide')) {
        const value = route.request().postDataJSON();
        if (value.turn_id !== 'turn-1' || value.invocation_id !== 'write-1' || value.note !== '已人工核对，保留当前内容') throw Error('Wrong recovery binding');
        attempts++;
        if (attempts === 1) { await route.fulfill({ status: 409, json: { detail: 'Injected recovery failure' } }); return; }
        decision = value.decision; note = value.note; body = value;
      } else body = { ...conversation, messages: [], turns: [{ id: 'turn-1', status: 'needs_attention', mode: 'Agent' }], workspace_granted: granted, cursor: 0, recovery: [{ turn_id: 'turn-1', invocation_id: 'write-1', tool: 'create_file', decision, note }] };
      await route.fulfill({ json: body });
    });
    await page.goto('http://127.0.0.1:5177');
    if (width < 1000) await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await page.getByRole('button', { name: '恢复核对样例', exact: false }).click();
    await page.getByRole('button', { name: '运行详情', exact: true }).click();
    const keep = page.getByRole('button', { name: '保留现状', exact: true });
    if (!await keep.isDisabled()) throw Error('Blank decision accepted');
    await page.getByRole('button', { name: '核对未知写入', exact: true }).click();
    await page.getByText('当前内容符合期望', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: '核对说明 write-1', exact: true }).fill('已人工核对，保留当前内容');
    await keep.click();
    await page.getByText('Injected recovery failure', { exact: true }).waitFor();
    if (await page.getByRole('textbox', { name: '核对说明 write-1', exact: true }).inputValue() !== '已人工核对，保留当前内容') throw Error('Review note lost');
    await keep.click();
    await page.getByText('已记录保留现状：已人工核对，保留当前内容', { exact: true }).waitFor();
    await page.getByRole('button', { name: '撤回工作区权限', exact: true }).click();
    await page.getByRole('button', { name: '撤回工作区权限', exact: true }).waitFor({ state: 'hidden' });
    if (!await page.getByRole('button', { name: '核对未知写入', exact: true }).isDisabled()) throw Error('Inspection enabled after revoke');
    await page.getByText('历史调用结果未知，未自动重放。', { exact: true }).waitFor();
    if (errors.length || inspections !== 1 || await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error(JSON.stringify({ errors, inspections }));
    await page.screenshot({ path: fileURLToPath(new URL(`recovery-${width}.png`, out)), fullPage: true });
    results.push({ width, scopeBound: true, failedNoteRetained: true, revokeDisablesInspection: true, historicalUnknownVisible: true });
    await page.close();
  }
  await fs.writeFile(new URL('report.json', out), JSON.stringify({ mode: 'UI-fixture-only', results }, null, 2));
  console.log(JSON.stringify({ out: fileURLToPath(out), results }));
} finally { await browser.close(); }
