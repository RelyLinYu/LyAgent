import {chromium} from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const out=new URL('../artifacts/approval-ui/',import.meta.url);
await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.route('**/api/**',async route=>{
  const request=route.request();
  if(request.url().includes('/events')){await route.fulfill({status:200,contentType:'text/event-stream',body:': test-only snapshot transport\n\n'});return;}
  const response=await route.fetch({url:request.url().replace('127.0.0.1:5177','127.0.0.1:8778')});
  await route.fulfill({response});
 });
 await page.goto('http://127.0.0.1:5177');
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('Test fixture: propose creating note.md');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByRole('button',{name:'批准这次调用',exact:true}).waitFor();
 await fs.access(new URL('workspace/note.md',out)).then(()=>{throw Error('File exists before approval')},()=>{});
 await page.screenshot({path:fileURLToPath(new URL('pending.png',out)),fullPage:true});
 await page.getByRole('button',{name:'拒绝',exact:true}).click();
 await page.waitForTimeout(300);
 await fs.access(new URL('workspace/note.md',out)).then(()=>{throw Error('Rejected write created file')},()=>{});
 await page.getByRole('button',{name:'新对话',exact:true}).click();
 await page.waitForTimeout(150);
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('Test fixture: approve a new file');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByRole('button',{name:'批准这次调用',exact:true}).click();
 for(let i=0;i<50;i++){if(await fs.readFile(new URL('workspace/note.md',out),'utf8').catch(()=>'')==='approved content')break;await page.waitForTimeout(100);}
 if(await fs.readFile(new URL('workspace/note.md',out),'utf8')!=='approved content')throw Error('Approved write did not reach disk');
 await page.screenshot({path:fileURLToPath(new URL('approved.png',out)),fullPage:true});
 await fs.writeFile(new URL('ui-report.json',out),JSON.stringify({mode:'deterministic-provider-real-api-and-ui',deniedNoWrite:true,approvedDiskContent:true,limit:'SSE replaced by test snapshot transport; stop tested at API layer'},null,2));
 console.log('Approval UI: denied write absent; approved content verified on disk.');
} finally {await browser.close();}
