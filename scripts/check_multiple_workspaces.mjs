import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
const out = `artifacts/multiple-workspaces/${Date.now()}`;
await fs.mkdir(out, {recursive:true});
const browser = await chromium.launch({channel:'msedge',headless:true});
const results = [];
try {
  for (const width of [1440,390]) {
    const page = await browser.newPage({viewport:{width,height:960}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let root = 'C:\\Test\\Alpha';
    const roots = [root, 'C:\\Test\\Empty'];
    await page.route('**/api/conversations', async route => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({json:[{id:'project-fixture-one',title:'继续 LyAgent 重写',created:1794500000,workspace_root:'C:\\Test\\Alpha'},{id:'project-fixture-two',title:'另一项任务',created:1794490000,workspace_root:'C:\\Test\\Alpha'}]});
    });
    const requests = [];
    await page.route('**/api/workspaces', route => route.fulfill({json:roots.map(value => ({root:value,active:value===root}))}));
    await page.route('**/api/workspace/configuration', async route => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON(); requests.push(body); root = body.root;
        if (!roots.includes(root)) roots.push(root);
      }
      await route.fulfill({json:{root,allow_writes:false,allow_tests:false,enable_workflows:false,evaluation_root:''}});
    });
    await page.route('**/api/workspace/pick-directory', route => route.fulfill({json:{path:'C:\\Test\\Beta',cancelled:false}}));
    await page.goto('http://127.0.0.1:8787');
    const sidebar = page.locator('.sidebar');
    if (!await sidebar.isVisible()) await page.getByRole('button',{name:'展开侧栏',exact:true}).click();
    await sidebar.getByRole('button',{name:'添加工作区',exact:true}).click();
    await page.getByRole('textbox',{name:'工作区绝对路径',exact:true}).waitFor();
    await page.waitForFunction(() => document.querySelector('#workspace-root')?.value === 'C:\\Test\\Beta');
    if (requests.length) throw Error('Folder choice silently authorized workspace');
    if (await page.getByRole('combobox',{name:'文件访问权限'}).inputValue() !== 'read') throw Error('Not readonly by default');
    await page.getByRole('button',{name:'应用工作区授权',exact:true}).click();
    await page.getByRole('status').filter({hasText:'工作区已启用'}).waitFor();
    if (requests.length !== 1 || requests[0].allow_writes || requests[0].allow_tests) throw Error('Grant leakage');
    if (!await sidebar.isVisible()) await page.getByRole('button',{name:'展开侧栏',exact:true}).click();
    await sidebar.getByRole('button',{name:'添加工作区',exact:true}).waitFor();
    const group = sidebar.locator('.project-group').filter({has:page.getByRole('button',{name:'Alpha',exact:true})});
    if (await group.locator('.conversation-row').count() !== 2) throw Error('Conversations not grouped under folder');
    await group.getByRole('button',{name:'Alpha',exact:true}).click();
    if (await group.locator('.project-conversations').isVisible()) throw Error('Project did not collapse');
    await group.getByRole('button',{name:'Alpha',exact:true}).click();
    await sidebar.getByRole('button',{name:'管理工作区 Alpha',exact:true}).click();
    if (!await sidebar.isVisible()) await page.getByRole('button',{name:'展开侧栏',exact:true}).click();
    await sidebar.getByRole('textbox',{name:'搜索会话',exact:true}).fill('另一项');
    if (await sidebar.locator('.conversation-row').count() !== 1) throw Error('Grouped search failed');
    await sidebar.getByRole('textbox',{name:'搜索会话',exact:true}).fill('');
    await group.getByLabel('管理会话 继续 LyAgent 重写',{exact:true}).click();
    await group.getByRole('button',{name:'重命名',exact:true}).waitFor();
    await group.getByRole('button',{name:'归档',exact:true}).waitFor();
    await group.getByRole('button',{name:'删除',exact:true}).waitFor();
    await group.getByLabel('管理会话 继续 LyAgent 重写',{exact:true}).click();
    await page.waitForFunction(() => document.querySelector('#workspace-root')?.value === 'C:\\Test\\Alpha');
    await page.screenshot({path:`${out}/${width}-switch.png`});
    if (!await sidebar.isVisible()) await page.getByRole('button',{name:'展开侧栏',exact:true}).click();
    await page.screenshot({path:`${out}/${width}-navigation.png`});
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow || errors.length) throw Error(JSON.stringify({overflow,errors}));
    results.push({width,passed:true,requests,overflow,errors});
    await page.close();
  }
  await fs.writeFile(`${out}/report.json`,JSON.stringify({passed:true,fixtureWorkspaceRoutes:true,nativeDialogNotTested:true,noModelCalls:true,results},null,2));
  console.log(JSON.stringify({out,passed:true}));
} finally {await browser.close();}
