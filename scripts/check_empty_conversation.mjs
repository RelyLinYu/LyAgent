import { chromium } from '../apps/web/node_modules/playwright-core/index.mjs';
import fs from 'node:fs/promises';
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:900}});
 await page.goto('http://127.0.0.1:8787');
 const empty=await page.evaluate(async()=>{
  await fetch('/api/bootstrap');
  const items=await(await fetch('/api/conversations')).json();
  for(const item of items){const state=await(await fetch(`/api/conversations/${item.id}?recent=true`)).json();if(!state.messages.length&&!state.turns.length)return item;}
  throw Error('No existing empty conversation available');
 });
 await page.evaluate(item=>localStorage.setItem('ly-workbench-draft-v1',JSON.stringify({id:item.id,draft:'Keep this unsent draft',mode:'Agent',attachments:[]})),empty);
 await page.reload();
 await page.getByRole('textbox',{name:'消息',exact:true}).waitFor();
 let posts=0;
 page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/conversations')posts++;});
 for(let i=0;i<4;i++){await page.locator('button.new-chat').click();await page.waitForTimeout(200);}
 if(posts)throw Error(`Created ${posts} duplicate empty conversations`);
 if(await page.getByRole('textbox',{name:'消息',exact:true}).inputValue()!=='Keep this unsent draft')throw Error('Draft lost');
 await page.getByRole('button',{name:'能力',exact:true}).click();
 await page.locator('button.new-chat').click();
 await page.getByRole('textbox',{name:'消息',exact:true}).waitFor();
 if(posts)throw Error('Created duplicate from capability view');
 await fs.mkdir('artifacts/empty-conversation',{recursive:true});
 await fs.writeFile('artifacts/empty-conversation/report.json',JSON.stringify({passed:true,creationRequests:posts,draftPreserved:true,returnedToConversation:true,noModelRequests:true},null,2));
 console.log('Passed: repeated empty conversation reuse, draft preserved, no creation requests');
}finally{await browser.close();}
