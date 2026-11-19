import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const out = new URL(`../artifacts/composer-keyboard/${Date.now()}/`, import.meta.url);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [1440, 800]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const submissions = [], errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      if (path.startsWith('/api/definitions/') || path.endsWith('/knowledge') || path === '/api/knowledge/collections') return route.fulfill({ json: [] });
      if (path === '/api/capabilities') return route.fulfill({ json: { enabled: false, model: { configured: true, name: 'keyboard fixture' }, skills: [], mcp: { server: 'fixture', transport: 'stdio', allowed_tools: [] } } });
      if (path.endsWith('/messages')) { submissions.push(request.postDataJSON()); return route.fulfill({ json: { id: 'turn-fixture' } }); }
      const conversation = { id: 'keyboard-fixture', title: '键盘验收', created: 1 };
      const body = path === '/api/bootstrap' ? { token: 'fixture', configured: true, model: 'keyboard fixture', tools_enabled: false } : path === '/api/conversations' ? (request.method() === 'POST' ? conversation : [conversation]) : { ...conversation, messages: [], turns: [], cursor: 0 };
      await route.fulfill({ json: body });
    });
    await page.goto(process.env.LYAGENT_UI_URL || 'http://127.0.0.1:5177');
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
    if (width < 1000) await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await page.getByRole('button', { name: '键盘验收', exact: true }).click();
    const input = page.getByRole('textbox', { name: '消息', exact: true });
    await input.fill('中文候选词');
    await input.dispatchEvent('compositionstart', { data: '中文' });
    await input.dispatchEvent('keydown', { key: 'Enter', code: 'Enter', isComposing: true, bubbles: true });
    await input.dispatchEvent('compositionend', { data: '中文候选词' });
    if (submissions.length || await input.inputValue() !== '中文候选词') throw Error('Composition confirmation submitted or erased draft');
    await input.press('Shift+Enter');
    if (submissions.length || !(await input.inputValue()).includes('\n')) throw Error('Shift+Enter did not preserve newline');
    const expected = await input.inputValue();
    await input.press('Enter');
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="消息"]').value === '');
    if (submissions.length !== 1 || submissions[0].content !== expected || 'task' in submissions[0]) throw Error('Plain Enter payload incorrect');
    if (errors.length) throw Error(errors.join('\n'));
    results.push({ width, syntheticCompositionEnterNotSubmitted: true, shiftEnterNewline: true, plainEnterSubmitsOnce: true, errors });
    await page.close();
  }
  await fs.writeFile(new URL('report.json', out), JSON.stringify({ mode: 'UI-fixture-synthetic-composition-events', limits: 'Synthetic DOM composition events plus real Playwright keyboard; not an installed Windows IME candidate-window test.', results }, null, 2));
  console.log(JSON.stringify({ out: fileURLToPath(out), results }));
} finally { await browser.close(); }
