import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const out = new URL(`../artifacts/contract-ui/${Date.now()}/`, import.meta.url);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [1440, 800]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let attempts = 0;
    const submitted = [];
    const conversations = [{ id: 'contract-a', title: '契约草稿 A', created: 1 }, { id: 'contract-b', title: '契约草稿 B', created: 2 }];
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path.endsWith('/events')) { await route.fulfill({ contentType: 'text/event-stream', body: ': fixture only\n\n' }); return; }
      if (path.endsWith('/messages')) {
        attempts++;
        submitted.push(request.postDataJSON());
        await route.fulfill(attempts === 1 ? { status: 409, json: { detail: 'Injected contract failure' } } : { json: { id: 'accepted' } });
        return;
      }
      let body;
      if (path === '/api/bootstrap') body = { token: 'fixture', configured: true, model: 'contract UI fixture', build: 'fixture-only', tools_enabled: true, writes_enabled: true };
      else if (path === '/api/conversations') body = conversations;
      else body = { ...conversations.find(c => path.endsWith(c.id)), messages: [], turns: [], cursor: 0, workspace_granted: true };
      await route.fulfill({ json: body });
    });
    await page.goto(process.env.LYAGENT_UI_URL || 'http://127.0.0.1:5177');
    async function select(title) {
      if (width < 1000) await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
      await page.getByRole('button', { name: title, exact: false }).click();
      await page.getByRole('heading', { name: title, exact: true }).waitFor();
    }
    await select('契约草稿 A');
    await page.getByRole('checkbox', { name: '任务验收', exact: true }).check();
    await page.getByRole('textbox', { name: '验收目标', exact: true }).fill('交付可核验文件');
    await page.getByRole('textbox', { name: '必需产物路径', exact: true }).fill('notes.md\nnested/result.py');
    await page.getByRole('checkbox', { name: '要求独立测试通过', exact: true }).check();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('执行这项任务');
    await select('契约草稿 B');
    if (await page.getByRole('checkbox', { name: '任务验收', exact: true }).isChecked()) throw Error('Contract leaked into another conversation');
    await select('契约草稿 A');
    if (await page.getByRole('textbox', { name: '验收目标', exact: true }).inputValue() !== '交付可核验文件') throw Error('Contract draft lost');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('alert').getByText('Injected contract failure').waitFor();
    if (await page.getByRole('textbox', { name: '验收目标', exact: true }).inputValue() !== '交付可核验文件') throw Error('Failed submission erased contract');
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Page overflow');
    await page.screenshot({ path: fileURLToPath(new URL(`contract-${width}.png`, out)), fullPage: true });
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.task-contract input[type=checkbox]').checked);
    if (submitted[1].task.goal !== '交付可核验文件' || !submitted[1].task.require_tests || submitted[1].task.required_artifacts.join(',') !== 'notes.md,nested/result.py') throw Error('Wrong contract payload');
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('普通问答');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="消息"]').value === '');
    if ('task' in submitted[2]) throw Error('Ordinary chat forced into Run');
    if (errors.length) throw Error(errors.join('\n'));
    results.push({ width, draftIsolation: true, failureRetention: true, payloadBound: true, successClears: true, ordinaryChatNoContract: true, errors });
    await page.close();
  }
  await fs.writeFile(new URL('report.json', out), JSON.stringify({ mode: 'UI-fixture-only', results }, null, 2));
  console.log(JSON.stringify({ out: fileURLToPath(out), results }));
} finally { await browser.close(); }
