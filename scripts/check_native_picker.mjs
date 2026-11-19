import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
const browser = await chromium.launch({channel:'msedge',headless:true});
const page = await browser.newPage();
const out = 'artifacts/native-picker';
await fs.mkdir(out,{recursive:true});
try {
  await page.goto('http://127.0.0.1:8787');
  const model = await page.evaluate(async()=> {
    const boot=await (await fetch('/api/bootstrap')).json();
    const response=await fetch('/api/model/select',{method:'POST',headers:{'Content-Type':'application/json','X-LyAgent-Token':boot.token},body:JSON.stringify({profile:'deepseek-current',effort:null})});
    return {status:response.status,body:await response.json()};
  });
  let calls=0;
  await page.route('**/api/workspace/pick-directory',async route=>{calls++;await route.fulfill({json:{path:null,cancelled:true}});});
  await page.getByRole('button',{name:'添加工作区',exact:true}).click();
  await page.waitForTimeout(500);
  if(calls!==1)throw Error(`Expected one dialog request, got ${calls}`);
  if(await page.getByRole('dialog').count())throw Error('Custom folder browser remains');
  if(await page.getByRole('textbox',{name:'工作区绝对路径',exact:true}).inputValue())throw Error('Cancel changed draft');
  await page.route('**/api/workspace/pick-directory',route=>route.fulfill({json:{path:'D:\\LyAgentWorkspace',cancelled:false}}));
  await page.getByRole('button',{name:'选择工作区文件夹',exact:true}).click();
  await page.waitForTimeout(300);
  if(await page.getByRole('textbox',{name:'工作区绝对路径',exact:true}).inputValue()!=='D:\\LyAgentWorkspace')throw Error('Selection not applied');
  const config=await page.evaluate(async()=>await(await fetch('/api/workspace/configuration')).json());
  if(config.root)throw Error('Picker granted workspace');
  await page.screenshot({path:`${out}/selected-draft.png`,fullPage:true});
  await fs.writeFile(`${out}/ui-report.json`,JSON.stringify({passed:true,model,cancelRequests:calls,selection:'fixture native response; not desktop dialog proof',configurationUnchanged:true},null,2));
  console.log(JSON.stringify({passed:true,model}));
} finally {await browser.close();}
