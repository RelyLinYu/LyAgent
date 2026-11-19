import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
const out=`artifacts/conversation-comfort/${Date.now()}`;
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const results=[];
try {
 for(const width of [1440,800,390]) {
  const page=await browser.newPage({viewport:{width,height:900}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8787');
  const field=page.getByRole('textbox',{name:'消息',exact:true});await field.waitFor();
  if(width<1000 && await page.locator('.sidebar').isVisible()) await page.getByRole('button',{name:'关闭侧栏',exact:true}).click();
  await field.fill('');
  const compact=await page.locator('.composer').boundingBox();
  if(compact.height>145) throw Error(`Composer too tall: ${width} ${compact.height}`);
  await field.fill('第一行');await field.press('Shift+Enter');await field.press('a');
  if(!((await field.inputValue()).includes('\n'))) throw Error('Newline lost');
  await field.fill(Array(16).fill('长消息内容，检查输入框自动增高和内部滚动。').join('\n'));
  const expanded=await field.boundingBox();if(expanded.height>161 || expanded.height<100) throw Error('Autosize limit failed');
  await field.fill('简短消息');
  const shrunk=await field.boundingBox();if(shrunk.height>55) throw Error('Input did not shrink');
  await page.getByRole('checkbox',{name:'任务验收',exact:true}).check();
  await page.getByRole('textbox',{name:'验收目标',exact:true}).fill('检查任务设置仍然可用');
  await page.getByRole('checkbox',{name:'任务验收',exact:true}).uncheck();
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  const rects=await page.locator('.composer > .attachments, .composer > .task-contract, .composer > .workspace-access, .composer > .composer-toolbar').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};}));
  for(let i=0;i<rects.length;i++) for(let j=i+1;j<rects.length;j++) {const a=rects[i],b=rects[j];if(Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)>1 && Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y)>1) throw Error('Toolbar overlap');}
  await page.screenshot({path:`${out}/${width}.png`});
  if(overflow||errors.length)throw Error(JSON.stringify({width,overflow,errors}));
  results.push({width,compactHeight:compact.height,expandedHeight:expanded.height,shrunkHeight:shrunk.height,overflow,errors});
  await page.close();
 }
 await fs.writeFile(`${out}/report.json`,JSON.stringify({passed:true,noModelCalls:true,results},null,2));console.log(JSON.stringify({out,passed:true,results}));
} finally {await browser.close();}
