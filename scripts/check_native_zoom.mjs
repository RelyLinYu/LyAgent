import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const out = new URL(`../artifacts/native-zoom/${Date.now()}/`, import.meta.url);
await fs.mkdir(out, { recursive: true });
const results = [];
for (const zoom of [1, 1.25, 1.5]) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'lyagent-zoom-'));
  await fs.mkdir(path.join(profile, 'Default'));
  const extension = fileURLToPath(new URL('./zoom-extension/', import.meta.url));
  const context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true, viewport: null, args: ['--window-size=1440,1000', '--force-device-scale-factor=1', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  try {
    const page = context.pages()[0];
    await page.route('**/api/**', route => {
      const pathname = new URL(route.request().url()).pathname;
      return route.fulfill({ json: pathname === '/api/bootstrap' ? { token: 'fixture', configured: true, model: 'native zoom fixture', tools_enabled: false } : [] });
    });
    await page.goto(process.env.LYAGENT_UI_URL || 'http://127.0.0.1:5177');
    await page.getByRole('button', { name: '发送', exact: true }).waitFor();
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const actual = await worker.evaluate(async zoom => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find(tab => tab.url?.startsWith('http://127.0.0.1:')); 
      if (!tab) throw Error('Acceptance tab not found');
      await chrome.tabs.setZoom(tab.id, zoom);
      return await chrome.tabs.getZoom(tab.id);
    }, zoom);
    if (actual !== zoom) throw Error('Browser zoom API mismatch');
    await page.waitForFunction(expected => Math.abs(devicePixelRatio - expected) < .03, zoom);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(150);
    const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, cssZoom: getComputedStyle(document.documentElement).zoom, overflow: document.documentElement.scrollWidth > innerWidth }));
    if (Math.abs(metrics.dpr - zoom) > .03 || metrics.cssZoom !== '1') throw Error('Native page zoom not confirmed: ' + JSON.stringify({ zoom, metrics }));
    if (await page.getByRole('button', { name: '关闭侧栏', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('原生缩放验收\n' + '中文长行与路径 '.repeat(60));
    const composer = await page.locator('.composer').boundingBox();
    if (metrics.overflow || !composer || composer.y < 0 || composer.y + composer.height > metrics.height + 1) throw Error('Native zoom layout clipped: ' + JSON.stringify({ metrics, composer }));
    const send = await page.getByRole('button', { name: '发送', exact: true }).boundingBox();
    if (!send || send.x < 0 || send.y < 0 || send.x + send.width > metrics.width + 1 || send.y + send.height > metrics.height + 1) throw Error('Send control clipped');
    const cdp = await context.newCDPSession(page);
    const capture = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: { x: 0, y: 0, width: metrics.width * metrics.dpr, height: metrics.height * metrics.dpr, scale: 1 } });
    await fs.writeFile(new URL(`zoom-${zoom}.png`, out), Buffer.from(capture.data, 'base64'));
    await cdp.detach();
    results.push({ zoom, metrics, composer, passed: true });
  } finally {
    await context.close();
    const resolved = path.resolve(profile);
    if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('lyagent-zoom-')) await fs.rm(resolved, { recursive: true, force: true });
  }
}
await fs.writeFile(new URL('report.json', out), JSON.stringify({ mode: 'native-browser-tabs-setZoom', fixtureOnly: true, isolatedTemporaryProfiles: true, results }, null, 2));
console.log(JSON.stringify({ out: fileURLToPath(out), results }));
