import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const out = new URL(`../artifacts/state-contrast/${Date.now()}/`, import.meta.url);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [1440, 800]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.addInitScript(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4;
      const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 4, 4);
      localStorage.setItem('ly-background', canvas.toDataURL()); localStorage.setItem('ly-dim', '78');
    });
    let fail = false;
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      if (pathname.startsWith('/api/definitions/') || pathname.endsWith('/knowledge') || pathname === '/api/knowledge/collections') return route.fulfill({ json: [] });
      if (pathname === '/api/capabilities') return route.fulfill({ json: { enabled: false, model: { configured: true, name: 'contrast fixture' }, skills: [], mcp: { server: 'fixture', transport: 'stdio', allowed_tools: [] } } });
      if (pathname.endsWith('/messages')) { fail = true; return route.fulfill({ status: 409, json: { detail: '验收注入：请求冲突，请重试' } }); }
      let data;
      if (pathname === '/api/bootstrap') data = { token: 'fixture', configured: true, model: 'contrast fixture', build: 'fixture-only', tools_enabled: true, writes_enabled: true };
      else if (pathname === '/api/conversations') data = [{ id: 'states', title: '状态核对', created: 1 }];
      else data = { id: 'states', title: '状态核对', cursor: 0, workspace_granted: true, messages: [], turns: [], recovery: [{ turn_id: 't', invocation_id: 'write-1', tool: 'create_file' }] };
      return route.fulfill({ json: data });
    });
    await page.goto(process.env.LYAGENT_UI_URL || 'http://127.0.0.1:5177');
    async function scan(state, selectors) {
      const checks = await page.evaluate(selectors => {
        const rgb = color => (color.match(/[\d.]+/g) || []).map(Number);
        const blend = (fg, bg, a) => fg.map((value, i) => value * a + bg[i] * (1 - a));
        const lum = rgb => rgb.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        return selectors.flatMap(selector => [...document.querySelectorAll(selector)].filter(el => el.getClientRects().length && !el.matches(':disabled') && getComputedStyle(el).opacity === '1').map(el => {
          const chain = []; for (let node = el; node; node = node.parentElement) chain.unshift(node);
          let bg = [255, 255, 255];
          for (const node of chain) {
            if (node.classList.contains('app')) bg = blend([15, 16, 17], [255, 255, 255], .78);
            const values = rgb(getComputedStyle(node).backgroundColor);
            if (values.length >= 3) bg = blend(values.slice(0, 3), bg, values[3] ?? 1);
          }
          const color = rgb(getComputedStyle(el).color), fg = blend(color.slice(0, 3), bg, color[3] ?? 1);
          const a = lum(fg), b = lum(bg), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
          return { selector, text: (el.textContent || el.getAttribute('aria-label') || '').slice(0, 60), ratio, passed: ratio >= 4.5 };
        }));
      }, selectors);
      if (!checks.length || checks.some(check => !check.passed)) throw Error(JSON.stringify({ width, state, checks }));
      results.push({ width, state, checks });
    }
    if (width < 1000) await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await page.getByRole('button', { name: '状态核对', exact: false }).click();
    await page.getByRole('checkbox', { name: '任务验收', exact: true }).check();
    await scan('contract', ['.task-contract label', '.contract-fields input', '.contract-fields textarea']);
    await page.getByRole('textbox', { name: '验收目标', exact: true }).fill('核对状态');
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('验收样例');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await page.getByRole('alert').waitFor();
    if (!fail) throw Error('Error state not exercised');
    await scan('error', ['.error-banner span']);
    await page.getByRole('button', { name: '运行详情', exact: true }).click();
    await scan('recovery', ['.recovery-panel h3', '.recovery-panel p', '.recovery-item code', '.recovery-item textarea', '.recovery-panel button']);
    await page.screenshot({ path: fileURLToPath(new URL(`states-${width}.png`, out)) });
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    if (width < 1000) await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await scan('settings', ['.settings-panel h2', '.settings-panel h3', '.setting-row', '.config-note', '.settings-panel .build']);
    await page.screenshot({ path: fileURLToPath(new URL(`settings-${width}.png`, out)) });
    await page.close();
    if (errors.length) throw Error(errors.join('\n'));
  }
  await fs.writeFile(new URL('report.json', out), JSON.stringify({ mode: 'computed-alpha-uniform-white-wallpaper-ui-fixture', limits: 'Selected visible enabled roles only. Excludes disabled opacity, focus/hover, pixel contrast, IME and WCAG compliance.', results }, null, 2));
  console.log(JSON.stringify({ out: fileURLToPath(out), checked: results.length }));
} finally { await browser.close(); }
