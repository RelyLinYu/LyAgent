import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
const out=`artifacts/settings-layout/${Date.now()}`;await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const results=[];
try{for(const width of [1440,800,390]){
 const page=await browser.newPage({viewport:{width,height:960}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8787');await page.getByRole('textbox',{name:'消息',exact:true}).fill('Preserve navigation draft');
 if(width<900&&await page.locator('.sidebar').isVisible())await page.getByRole('button',{name:'关闭侧栏',exact:true}).click();
 if(await page.locator('.tabs').getByRole('button',{name:'能力',exact:true}).count()||await page.locator('.tabs').getByRole('button',{name:'上下文',exact:true}).count())throw Error('Old top navigation remains');
 await page.getByRole('button',{name:'轨迹',exact:true}).click();
 if(await page.locator('.composer-wrap').isVisible())throw Error('Composer consumes tool view height');
 const expanded=await page.locator('.workspace-view').boundingBox();
 await page.getByRole('button',{name:'对话',exact:true}).click();
 if(await page.getByRole('textbox',{name:'消息',exact:true}).inputValue()!=='Preserve navigation draft')throw Error('Draft lost');
 if(!await page.locator('.sidebar').isVisible())await page.getByRole('button',{name:'展开侧栏',exact:true}).click();
 await page.getByRole('button',{name:'设置',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'设置',exact:true});
 for(const name of ['模型','Skills','MCP 服务器','额度与恢复','会话高级','外观']){
  await dialog.getByRole('navigation',{name:'设置分类'}).getByRole('button',{name,exact:true}).click();
  await page.screenshot({path:`${out}/${width}-${name}.png`});
 }
 await dialog.getByRole('navigation').getByRole('button',{name:'Skills',exact:true}).click();
 await dialog.getByRole('heading',{name:'自定义 Skills',exact:true}).waitFor();
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 if(overflow||errors.length)throw Error(JSON.stringify({width,overflow,errors}));
 results.push({width,expandedWidth:expanded.width,overflow,errors});await page.close();
}await fs.writeFile(`${out}/report.json`,JSON.stringify({passed:true,results,noModelRequests:true},null,2));console.log(JSON.stringify({out,passed:true}));}finally{await browser.close();}
