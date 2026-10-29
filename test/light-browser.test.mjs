import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.FEIYU_PLAYWRIGHT_PATH||'playwright');const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'feiyu-light-ui-'));process.env.DSH_HOME=tmp;
const {createApiHandler}=await import('../lib/api.js');const server=http.createServer(createApiHandler());let browser;
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,...(process.env.FEIYU_BROWSER_CHANNEL?{channel:process.env.FEIYU_BROWSER_CHANNEL}:{})});const page=await browser.newPage({viewport:{width:1365,height:950}}),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
 const data={key:'private:123',label:'演示私聊',counts:{activeTopics:0,pendingThoughts:0,memberImpressions:0,automaticTopics:1},activeTopics:[],pendingThoughts:[],memberImpressions:{},known:{total:1,rows:[{id:'known1',subjectId:'123',tier:'normal',text:'我喜欢下雨天听轻音乐',sourceText:'今天雨很大。我喜欢下雨天听轻音乐。',sourceId:'m1',sourceTime:Date.now()}]},automaticTopics:[{id:'auto1',subjectId:'123',text:'确认明天出门的路线',quote:'明天出门的路线还没定 <img src=x onerror=alert(1)>',sourceId:'m2',expiresAt:Date.now()+3600000}],automaticCheckedAt:Date.now(),automaticAudit:[{at:Date.now(),status:'written',reason:'加入有原话依据的近期话题',sourceId:'m2'}]};
 await page.route('**/api/**',async route=>{const p=new URL(route.request().url()).pathname;let body={ok:true};
  if(p.endsWith('/version'))body.version='0.9.0';
  if(p.endsWith('/overview'))body={ok:true,total:1,active:1,scopes:[],recent:[],fading:[],health:{ok:true,capabilities:[]}};
  if(p.endsWith('/light'))body={ok:true,...data};
  if(p.endsWith('/light/action')){posts.push(route.request().postDataJSON());data.automaticTopics=[];body={ok:true,...data};}
  await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/#/light?key=private%3A123`);await page.getByRole('heading',{name:'已知信息 · 1 条'}).waitFor();
 await page.getByText('查看原话与来源',{exact:true}).click();await page.getByText('今天雨很大。我喜欢下雨天听轻音乐。',{exact:true}).waitFor();
 await page.getByText('原话依据',{exact:true}).click();assert.equal(await page.locator('main img').count(),0);
 await page.getByText('最近自动整理记录',{exact:true}).click();await page.getByText(/加入有原话依据/).waitFor();
 if(process.env.FEIYU_UI_SCREENSHOT_DIR){fs.mkdirSync(process.env.FEIYU_UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.FEIYU_UI_SCREENSHOT_DIR,'light-memory-dark.png'),fullPage:true});}
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
 await page.getByRole('button',{name:'移除这条便签'}).click();await page.getByRole('heading',{name:'自动整理的近期便签 · 0'}).waitFor();
 assert.deepEqual(posts,[{op:'remove',category:'automaticTopic',key:'private:123',id:'auto1'}]);
 assert.deepEqual(errors,[]);console.log('light browser OK: known facts, original source, automatic note audit, escaping, mobile and removal');
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));const rel=path.relative(os.tmpdir(),tmp);if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel))fs.rmSync(tmp,{recursive:true,force:true});}
