import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
const out = `artifacts/settings-controls/${Date.now()}`;
await fs.mkdir(out, {recursive:true});
const browser = await chromium.launch({channel:'msedge',headless:true});
const results=[];
try {
 for (const width of [1440,800,390]) {
  const page=await browser.newPage({viewport:{width,height:960}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:8787');
  if(width<900 && await page.locator('.sidebar').isVisible()) await page.getByRole('button',{name:'关闭侧栏',exact:true}).click();
  await page.getByRole('button',{name:'能力',exact:true}).click();
  await page.getByRole('button',{name:'添加模型提供商',exact:true}).click();
  await page.getByRole('textbox',{name:'模型配置 ID',exact:true}).fill('draft-only');
  await page.screenshot({path:`${out}/model-${width}.png`,fullPage:true});
  const style=await page.locator('.add-provider').evaluate(el=>({border:getComputedStyle(el).borderStyle,background:getComputedStyle(el).backgroundColor}));
  if(style.border!=='dashed')throw Error('Add control has no visible border');
  await page.getByRole('button',{name:'关闭模型编辑',exact:true}).click();
  for(const name of ['Skills','MCP']) {
   await page.getByRole('button',{name,exact:true}).click();
   await page.screenshot({path:`${out}/${name}-${width}.png`,fullPage:true});
  }
  if(!await page.locator('.sidebar').isVisible())await page.getByRole('button',{name:'展开侧栏',exact:true}).click();
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'设置',exact:true});
  await dialog.getByRole('button',{name:'添加模型提供商',exact:true}).waitFor();
  await page.screenshot({path:`${out}/settings-${width}.png`,fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
  if(errors.length||overflow)throw Error(JSON.stringify({errors,overflow,width}));
  results.push({width,errors,overflow,addControl:style});await page.close();
 }
 await fs.writeFile(`${out}/report.json`,JSON.stringify({passed:true,results,noModelRequests:true},null,2));
 console.log(JSON.stringify({out,passed:true}));
}finally{await browser.close();}
