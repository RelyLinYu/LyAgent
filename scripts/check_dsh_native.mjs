import fs from 'node:fs/promises';
import path from 'node:path';
import {chromium} from '../apps/web/node_modules/playwright-core/index.mjs';
const port=process.argv[2] || '';
const serviceRoot=path.resolve(process.argv[3] || '.');
const state=JSON.parse(await fs.readFile(path.join(serviceRoot,port ? `artifacts/dsh-native/managed-${port}.json` : 'artifacts/dsh-native/current.json'),'utf8'));
const log=await fs.readFile(state.stdout,'utf8');
const url=log.match(/dsh web: (http:\/\/[^\s]+)/)?.[1];
if(!url) throw Error('No native startup URL');
const out=`artifacts/dsh-native/browser-${Date.now()}`;await fs.mkdir(out,{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
try {
 const results=[];
 for(const width of [1440,390]) {
  const page=await browser.newPage({viewport:{width,height:960}});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.waitForTimeout(4000);
  const consent=page.getByRole('button',{name:'继续',exact:true});
  if(await consent.isVisible()) { await consent.click(); await consent.waitFor({state:'hidden'}); }
  await page.waitForTimeout(1500);
  const text=await page.locator('body').innerText();
  const identityMissing=port && (await page.title() !== 'LyAgent' || !text.includes('LyAgent') && width > 700);
  await page.screenshot({path:`${out}/${width}.png`});
  await fs.writeFile(`${out}/${width}-text.txt`,text);
  if(identityMissing) throw Error(`LyAgent identity missing: title=${await page.title()}; evidence=${out}; errors=${JSON.stringify(errors)}`);
  results.push({width,title:await page.title(),textLength:text.length,errors,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
  await page.close();
 }
 const stderr=await fs.readFile(state.stderr,'utf8');
 await fs.writeFile(`${out}/report.json`,JSON.stringify({results,stderr,sourceCommit:'e8f7b93a344964de3dca1ace9e72b6e4d6de87cb',noModelRequests:true,scope:port ? 'LyAgent title and sidebar identity on native initial page; no task execution verified' : 'Upstream native startup and initial page only; no task execution verified'},null,2));
 if(results.some(result=>result.errors.length || result.overflow) || stderr.trim()) throw Error(`Native startup checks failed; inspect ${out}/report.json`);
 console.log(JSON.stringify({out,results,stderr}));
} finally {await browser.close();}
