import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const out = new URL(`../artifacts/snapshot-order/${Date.now()}/`, import.meta.url);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const conversations = ['a', 'b'].map(id => ({ id, title: `Snapshot ${id}`, created: 1 }));
  const pending = [];
  let held = true;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/events')) return route.fulfill({ contentType: 'text/event-stream', body: ': fixture only\n\n' });
    if (path === '/api/bootstrap') return route.fulfill({ json: { token: 'fixture', configured: true, model: 'snapshot fixture', tools_enabled: false } });
    if (path === '/api/conversations') return route.fulfill({ json: conversations });
    const id = path.split('/').at(-1);
    const reply = (cursor, content) => route.fulfill({ json: { ...conversations.find(c => c.id === id), cursor, turns: [], messages: [{ id: `${id}-${cursor}`, turn_id: 't', role: 'assistant', content }] } });
    if (held && id === 'a') pending.push(reply);
    else return reply(30, `Current ${id}`);
  });
  await page.goto(process.env.LYAGENT_UI_URL || 'http://127.0.0.1:5177');
  await page.getByRole('button', { name: 'Snapshot a', exact: false }).click();
  // The heading comes from the held snapshot, so wait on requests instead.
  const deadline = Date.now() + 10000;
  while (pending.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (pending.length < 2) throw Error('Expected overlapping initial/onopen snapshots');
  await pending[1](20, 'Newer completed result');
  await page.getByText('Newer completed result', { exact: true }).waitFor();
  await pending[0](10, 'Stale running result');
  await page.waitForTimeout(200);
  if (await page.getByText('Stale running result', { exact: true }).count()) throw Error('Old snapshot regressed state');
  await page.getByText('Newer completed result', { exact: true }).waitFor();
  // Reconnect starts more requests; switching must discard their late responses.
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  while (pending.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  if (pending.length < 3) throw Error('Reconnect did not request a snapshot');
  held = false;
  await page.getByRole('button', { name: 'Snapshot b', exact: false }).click();
  await page.getByText('Current b', { exact: true }).waitFor();
  for (const reply of pending.slice(2)) await reply(99, 'Late other conversation');
  await page.waitForTimeout(200);
  await page.getByText('Current b', { exact: true }).waitFor();
  if (await page.getByText('Late other conversation', { exact: true }).count()) throw Error('Cross-conversation response applied');
  if (errors.length) throw Error(errors.join('\n'));
  await page.screenshot({ path: fileURLToPath(new URL('snapshot-order.png', out)) });
  const report = { mode: 'UI-fixture-delayed-responses', olderCursorDiscarded: true, crossConversationDiscarded: true, errors };
  await fs.writeFile(new URL('report.json', out), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ out: fileURLToPath(out), ...report }));
} finally { await browser.close(); }
