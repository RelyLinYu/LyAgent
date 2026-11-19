import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
const out = new URL('../artifacts/ui-r01/', import.meta.url);
await fs.mkdir(out, {recursive:true});
const browser = await chromium.launch({channel:'msedge',headless:true});
const results=[];
for(const [width,height] of [[1280,800],[1440,900],[1920,1080],[800,900]]){
 const page=await browser.newPage({viewport:{width,height}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('http://127.0.0.1:5177');
 await page.getByRole('button',{name:'运行详情',exact:true}).waitFor();
 if(width<1000){await page.getByRole('button',{name:'展开侧栏',exact:true}).click();await page.getByRole('button',{name:'关闭侧栏',exact:true}).click();}
 await page.getByRole('button',{name:'发送',exact:true}).waitFor();
 await page.getByLabel('选择附件',{exact:true}).setInputFiles({name:'验收附件.md',mimeType:'text/markdown',buffer:Buffer.from('虚构附件：责任人小林，截止 11 月 18 日。')});
 await page.getByRole('button',{name:'移除附件 验收附件.md',exact:true}).waitFor();
 await page.getByRole('button',{name:'移除附件 验收附件.md',exact:true}).click();
 await page.getByRole('textbox',{name:'消息',exact:true}).fill('你好，这是新版界面验收。');
 await page.getByRole('button',{name:'发送',exact:true}).click();
 await page.getByText('模型尚未配置。请在服务端设置模型地址、名称与密钥后重启。',{exact:true}).waitFor();
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 const composer=await page.locator('.composer').boundingBox();
 if(overflow||!composer||composer.y+composer.height>height||errors.length)throw new Error(JSON.stringify({width,overflow,composer,errors}));
 await page.screenshot({path:new URL(`desktop-${width}.png`,out).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
 await page.getByRole('button',{name:'运行详情',exact:true}).click();
 await page.screenshot({path:new URL(`inspector-${width}.png`,out).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
 await page.getByRole('button',{name:'关闭详情',exact:true}).click();
 if(width<1000)await page.getByRole('button',{name:'展开侧栏',exact:true}).click();
 await page.getByRole('button',{name:'设置',exact:true}).click();
 await page.getByRole('checkbox',{name:'减少透明效果'}).check();
 await page.screenshot({path:new URL(`settings-${width}.png`,out).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
 results.push({width,height,overflow,errors,composerVisible:true,unconfiguredModelHonest:true});
 await page.close();
}
await fs.writeFile(new URL('report.json',out),JSON.stringify({mode:'real-ui-no-live-model',results},null,2));
await browser.close();
console.log(JSON.stringify(results));
