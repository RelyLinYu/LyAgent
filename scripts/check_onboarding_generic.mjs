import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from './apps/web/node_modules/playwright-core/index.mjs';

const state = JSON.parse(await fs.readFile('artifacts/dsh-native/managed-8791.json', 'utf8'));
const log = await fs.readFile(state.stdout, 'utf8');
const url = log.match(/dsh web: (http:\/\/[^\s]+)/)?.[1];
if (!url) throw Error('no url');
const stamp = Date.now();
const out = `artifacts/dsh-native/onboarding-takeover-${stamp}`;
await fs.mkdir(out, {recursive: true});
const browser = await chromium.launch({channel: 'msedge', headless: true});
const report = {};
try {
  const page = await browser.newPage({viewport: {width: 1440, height: 960}});
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(url);
  await page.waitForTimeout(4000);
  const consent = page.getByRole('button', {name: '继续', exact: true});
  if (await consent.isVisible()) { await consent.click(); await consent.waitFor({state: 'hidden'}); }
  await page.waitForTimeout(2000);
  const body = await page.locator('body').innerText();
  await page.screenshot({path: `${out}/1440.png`});
  const generic = body.includes('配置模型开始使用');
  const deepseekOfficial = body.includes('DeepSeek 官方') || body.includes('deepseek-official');
  const configButtons = await page.getByRole('button', {name: /配置模型/}).count();
  report.initial = {generic, deepseekOfficial, configButtons, textLength: body.length, errors};
  // open models settings
  if (configButtons > 0) {
    await page.getByRole('button', {name: /配置模型/}).first().click();
    await page.waitForTimeout(2500);
    const after = await page.locator('body').innerText();
    await page.screenshot({path: `${out}/models.png`});
    report.models = {
      addProvider: /添加.*提供商|添加提供商/.test(after),
      deepseekOfficial: /DeepSeek\s*官方/.test(after),
      textLength: after.length,
    };
  }
  await page.close();
} finally { await browser.close(); }
await fs.writeFile(`${out}/report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify({out, report}));
