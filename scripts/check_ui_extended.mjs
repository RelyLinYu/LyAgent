import {chromium} from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const output=new URL('../artifacts/ui-r01-extended/',import.meta.url);
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
const results=[];
for(const zoom of [1,1.25,1.5]){
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.goto('http://127.0.0.1:5177');
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('dialog',{name:'设置',exact:true}).waitFor();
 if(!await page.getByRole('button',{name:'关闭设置',exact:true}).evaluate(el=>el===document.activeElement))throw Error('Initial dialog focus failed');
 for(let i=0;i<9;i++)await page.keyboard.press('Tab');
 if(!await page.getByRole('dialog',{name:'设置',exact:true}).evaluate(el=>el.contains(document.activeElement)))throw Error('Focus escaped dialog');
 await page.keyboard.press('Escape');
 await page.evaluate(z=>document.documentElement.style.zoom=String(z),zoom);
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('长中文与路径 D:/example/'+ '长文件名'.repeat(75)+'\n'+ '多行输入内容\n'.repeat(24));
 const composer=await page.locator('.composer').boundingBox();
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 if(overflow||!composer||composer.y+composer.height>902)throw Error('Zoom layout failed '+zoom);
 await page.screenshot({path:fileURLToPath(new URL(`zoom-${zoom}.png`,output)),fullPage:true});
 results.push({zoom,overflow,composerVisible:true,focusTrap:true});
 await page.close();
}
const page=await browser.newPage({viewport:{width:1440,height:900}});
await page.goto('http://127.0.0.1:5177');
await page.getByRole('button',{name:'设置',exact:true}).click();
// A synthetic local bitmap exercises appearance only; never a model attachment.
await page.locator('input[accept="image/*"]').setInputFiles({name:'test.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=','base64')});
await page.getByRole('button',{name:'移除背景',exact:true}).waitFor();
await page.getByRole('checkbox',{name:'减少透明效果'}).check();
if(!await page.locator('.app').evaluate(el=>el.classList.contains('opaque')))throw Error('Opaque mode failed');
await page.screenshot({path:fileURLToPath(new URL('background-opaque.png',output)),fullPage:true});
await page.getByRole('button',{name:'移除背景',exact:true}).click();
await page.close();await browser.close();
await fs.writeFile(new URL('report.json',output),JSON.stringify({results,backgroundLocal:true,opaqueMode:true,limits:['No real streaming-long-conversation performance measurement','CSS zoom is a layout proxy, not native browser zoom','No independent design review: relay protocol failure']},null,2));
console.log(JSON.stringify(results));
