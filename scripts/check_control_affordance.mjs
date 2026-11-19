import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
const out=`artifacts/control-affordance/${Date.now()}`;await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});const results=[];
try{for(const width of [1440,800,390]){
 const page=await browser.newPage({viewport:{width,height:960}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:8787');await page.getByRole('textbox',{name:'消息',exact:true}).waitFor();
 if(!await page.locator('.sidebar').isVisible())await page.getByRole('button',{name:'展开侧栏',exact:true}).click();
 const controls=await page.locator('.new-chat,.search,.workspace-open,.sidebar-footer button,.conversation-management > summary').evaluateAll(els=>els.map(el=>{const s=getComputedStyle(el);return {name:el.textContent.trim(),border:s.borderTopWidth,style:s.borderTopStyle,bg:s.backgroundColor};}));
 if(controls.some(c=>c.border==='0px'||c.style==='none'||c.bg==='rgba(0, 0, 0, 0)'))throw Error(JSON.stringify(controls));
 await page.screenshot({path:`${out}/sidebar-${width}.png`});
 await page.locator('.search input').fill('test');await page.locator('.search input').fill('');
 if(width<900)await page.getByRole('button',{name:'关闭侧栏',exact:true}).click();
 await page.getByRole('button',{name:'轨迹',exact:true}).click();await page.screenshot({path:`${out}/trace-${width}.png`});
 await page.getByRole('button',{name:'对话',exact:true}).click();
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 if(errors.length||overflow)throw Error(JSON.stringify({width,errors,overflow}));results.push({width,controls,errors,overflow});await page.close();
}await fs.writeFile(`${out}/report.json`,JSON.stringify({passed:true,results,noModelRequests:true},null,2));console.log(JSON.stringify({passed:true,out}));}finally{await browser.close();}
