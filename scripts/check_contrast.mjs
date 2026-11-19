import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const out = new URL(`../artifacts/contrast/${Date.now()}/`, import.meta.url);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const color of ['#ffffff', '#00ff00', '#ff00ff']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.addInitScript(color => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 4;
      const context = canvas.getContext('2d'); context.fillStyle = color; context.fillRect(0, 0, 4, 4);
      localStorage.setItem('ly-background', canvas.toDataURL()); localStorage.setItem('ly-dim', '35');
    }, color);
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture\n\n' });
      return route.fulfill({ json: path === '/api/bootstrap' ? { token: 'fixture', configured: true, model: 'contrast fixture', tools_enabled: false } : [] });
    });
    await page.goto('http://127.0.0.1:5177');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const slider = page.getByRole('slider', { name: '背景暗化', exact: true });
    if (await slider.inputValue() !== '78') throw Error('Unsafe saved dimming was not clamped');
    await page.keyboard.press('Escape');
    const checks = await page.evaluate(baseColor => {
      const rgb = value => (value.match(/[\d.]+/g) || []).map(Number);
      const blend = (fg, bg, alpha) => fg.map((v, i) => v * alpha + bg[i] * (1 - alpha));
      const lum = value => value.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      const base = [1, 3, 5].map(i => parseInt(baseColor.slice(i, i + 2), 16));
      const ground = blend([15, 16, 17], base, .78);
      return ['.empty h2', '.composer textarea', '.model-label', '.section-label', '.build', '.search input', '.task-contract summary', '.contract-enabled', '.composer select'].filter(selector => document.querySelector(selector)).map(selector => {
        const el = document.querySelector(selector), style = getComputedStyle(el);
        let bg = ground;
        const chain = []; for (let node = el; node && !node.classList.contains('app'); node = node.parentElement) chain.unshift(node);
        for (const node of chain) { const c = rgb(getComputedStyle(node).backgroundColor); if (c.length >= 3) bg = blend(c.slice(0, 3), bg, c[3] ?? 1); }
        const fg = rgb(style.color).slice(0, 3), a = lum(fg), b = lum(bg);
        const ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        return { selector, foreground: fg, compositedBackground: bg, ratio, passed: ratio >= 4.5 };
      });
    }, color);
    const placeholderChecks = await page.evaluate(baseColor => {
      const rgb = value => (value.match(/[\d.]+/g) || []).map(Number);
      const lum = values => values.map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
      const blend = (fg, bg, a) => fg.map((v, i) => v * a + bg[i] * (1 - a));
      const base = [1, 3, 5].map(i => parseInt(baseColor.slice(i, i + 2), 16));
      return ['.search input', '.composer textarea'].map(selector => {
        const el = document.querySelector(selector), placeholder = getComputedStyle(el, '::placeholder');
        let bg = blend([15, 16, 17], base, .78);
        const chain = []; for (let node = el; node && !node.classList.contains('app'); node = node.parentElement) chain.unshift(node);
        for (const node of chain) { const c = rgb(getComputedStyle(node).backgroundColor); if (c.length >= 3) bg = blend(c.slice(0, 3), bg, c[3] ?? 1); }
        const c = rgb(placeholder.color), fg = blend(c.slice(0, 3), bg, (c[3] ?? 1) * Number(placeholder.opacity));
        const a = lum(fg), b = lum(bg), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        return { selector: selector + '::placeholder', ratio, passed: ratio >= 4.5 }; 
      });
    }, color);
    checks.push(...placeholderChecks);
    if (checks.some(c => !c.passed)) throw Error(JSON.stringify({ color, checks }));
    if (color === '#ffffff') await page.screenshot({ path: fileURLToPath(new URL('white-background.png', out)), fullPage: true });
    results.push({ color, checks }); await page.close();
  }
  await fs.writeFile(new URL('report.json', out), JSON.stringify({ mode: 'computed-srgb-alpha-composition', limits: 'Selected enabled text roles and uniform bitmap backgrounds only; not a WCAG audit or screenshot pixel measurement.', results }, null, 2));
  console.log(JSON.stringify({ out: fileURLToPath(out), results }));
} finally { await browser.close(); }
