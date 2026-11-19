import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const out = new URL(`../artifacts/clarification-ui/${Date.now()}/`, import.meta.url);
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const results = [];
try {
  for (const width of [1440, 800]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let answered = false;
    let corrected = false;
    let correctionAttempts = 0;
    let newConversationStarted = false;
    const conversation = { id: 'clarification-ui-fixture', title: '澄清交互验收', created: 1 };
    const runs = [{ id: 'run-fixture', status: 'needs_attention', reason: 'Required verification missing, failed or stale', contract: { goal: '核验产物与独立测试', required_artifacts: ['nested/' + 'long-path-'.repeat(8) + '.py'], require_tests: true }, artifacts: [{ id: 'artifact-a', path: 'calculator.py', sha256: 'a'.repeat(64) }, { id: 'artifact-b', path: 'notes.md', sha256: 'b'.repeat(64) }], verifications: [{ id: 'check-a', status: 'inconclusive', result: JSON.stringify({ status: 'inconclusive', tests_run: 0, reason: 'No tests discovered', output: 'bounded output '.repeat(80) }) }] }];
    const snapshot = () => ({ ...conversation, cursor: 1, turns: [{ id: 'turn-1', status: answered ? 'completed' : 'waiting_user', mode: 'Agent', error: null }], messages: [{ id: 'user-1', turn_id: 'turn-1', role: 'user', content: '整理资料，输出名称待确认。' }, { id: 'assistant-1', turn_id: 'turn-1', role: 'assistant', content: answered ? '已收到：验收结果。' : '' }], controls: [], clarifications: [{ id: 'question-1', turn_id: 'turn-1', question: '请确认本次输出文件的名称。', question_hash: 'a'.repeat(64), status: answered ? 'answered' : 'pending' }] });
    await page.route('**/api/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      let body;
      if (path === '/api/bootstrap') body = { token: 'fixture', configured: true, model: 'UI fixture, not live', build: 'clarification-ui-fixture', tools_enabled: false };
      else if (path === '/api/conversations' && request.method() === 'POST') { newConversationStarted = true; await new Promise(resolve => setTimeout(resolve, 600)); body = { id: 'new-conversation', title: '新对话', created: 2 }; }
      else if (path === '/api/conversations') body = [conversation];
      else if (path.endsWith('/events')) { await route.fulfill({ contentType: 'text/event-stream', body: ': fixture snapshot transport\n\n' }); return; }
      else if (path.endsWith('/correct')) {
        const value = request.postDataJSON();
        if (value.target_turn_id !== 'turn-1' || value.content !== '新的纠正要求') throw Error('Wrong correction binding');
        correctionAttempts += 1;
        if (correctionAttempts === 1) { await route.fulfill({ status: 409, json: { detail: 'Injected correction failure' } }); return; }
        corrected = true; body = { turn_id: 'corrected-turn', effects_reverted: false };
      }
      else if (path.endsWith('/clarifications/question-1')) {
        const value = request.postDataJSON();
        if (value.answer !== '验收结果' || value.question_hash !== 'a'.repeat(64)) throw Error('Incorrect answer binding');
        answered = true; body = { status: 'answered' };
      } else body = { ...snapshot(), runs };
      await route.fulfill({ json: body });
    });
    await page.goto('http://127.0.0.1:5177');
    if (width < 1000) await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await page.getByRole('button', { name: '澄清交互验收', exact: false }).click();
    if (width < 1000 && await page.getByRole('button', { name: '关闭侧栏', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
    const answer = page.getByRole('textbox', { name: '回答', exact: true });
    await answer.waitFor();
    await page.getByRole('button', { name: '停止回复并取消排队', exact: true }).waitFor();
    if (!await page.getByRole('button', { name: '回答并继续', exact: true }).isDisabled()) throw Error('Empty answer should be disabled');
    await answer.fill('验收结果');
    await page.screenshot({ path: fileURLToPath(new URL(`pending-${width}.png`, out)), fullPage: true });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow || errors.length) throw Error(JSON.stringify({ overflow, errors }));
    await page.getByRole('button', { name: '回答并继续', exact: true }).click();
    await page.getByText('已收到：验收结果。', { exact: true }).waitFor();
    if (await answer.count()) throw Error('Answered form remains');
    await page.getByRole('button', { name: '运行详情', exact: true }).click();
    await page.getByRole('heading', { name: '任务待核对', exact: true }).waitFor();
    await page.getByText('notes.md · 版本 1', { exact: true }).click();
    await page.getByText('无法判定', { exact: true }).click();
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw Error('Run inspector overflows');
    await page.screenshot({ path: fileURLToPath(new URL(`runs-${width}.png`, out)), fullPage: true });
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    await page.screenshot({ path: fileURLToPath(new URL(`answered-${width}.png`, out)), fullPage: true });
    answered = false;
    await page.reload();
    if (width < 1000) await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await page.getByRole('button', { name: '澄清交互验收', exact: false }).click();
    if (width < 1000 && await page.getByRole('button', { name: '关闭侧栏', exact: true }).isVisible()) await page.getByRole('button', { name: '关闭侧栏', exact: true }).click();
    const composer = page.getByRole('textbox', { name: '消息', exact: true });
    await composer.fill('新的纠正要求');
    const correction = page.getByRole('button', { name: '用草稿纠正当前任务并取消排队', exact: true });
    await correction.click();
    await page.getByText('Injected correction failure', { exact: true }).waitFor();
    if (await composer.inputValue() !== '新的纠正要求') throw Error('Draft lost after failed correction');
    await correction.click();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="消息"]').value === '');
    if (!corrected) throw Error('Correction not bound');
    if (width < 1000) await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('textarea[aria-label="消息"]').disabled);
    if (!newConversationStarted) throw Error('New conversation request missing');
    await page.waitForFunction(() => !document.querySelector('textarea[aria-label="消息"]').disabled);
    results.push({ width, overflow, errors, boundAnswer: true, emptyDisabled: true, stopVisible: true, correctionBound: corrected, failedCorrectionDraftRetained: true });
    await page.close();
  }
  await fs.writeFile(new URL('report.json', out), JSON.stringify({ mode: 'browser-ui-fixture-only', limit: 'All API routes and SSE replaced with deterministic fixtures; real resume is separately API-tested.', results }, null, 2));
  console.log(JSON.stringify({ out: fileURLToPath(out), results }));
} finally { await browser.close(); }
