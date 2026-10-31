import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {createRequire} from 'node:module';
import {GrowthClassroom} from '../bridge/growth-classroom.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.FEIYU_PLAYWRIGHT_PATH||'playwright');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'classroom-browser-'));process.env.DSH_HOME=tmp;
const {createApiHandler}=await import('../lib/api.js');const server=http.createServer(createApiHandler());let browser,calls=0;
const key='private:1',c=new GrowthClassroom({allowed:k=>k===key,generate:async()=>{calls++;return JSON.stringify({guidance:'回应具体细节 <img src=x onerror=alert(1)>',avoid:'不机械建议',example:'模拟示例',rationale:'对应当前分享',checks:['有具体回应']})}});
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,channel:process.env.FEIYU_BROWSER_CHANNEL||'msedge'});const page=await browser.newPage({viewport:{width:1365,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/api/**',async route=>{
  const api=new URL(route.request().url()).pathname.replace(/^.*\/api/,'');let data={ok:true};
  if(api==='/overview')data={ok:true,total:0,scopes:[],recent:[],fading:[],health:{ok:true,capabilities:[],bridge:{ok:true}}};
  if(api==='/classroom'){
   let result={};if(route.request().method()==='POST'){const b=route.request().postDataJSON();if(b.action==='generate'){result=c.start(key,b.id);await c.job}else c.edit(key,b)}
   data={ok:true,...c.view(key),model:'fixture-model',effort:'low',continuityEnabled:true,workspaceEnabled:true,reused:result.reused===true};
  }
  if(api==='/audit')data={ok:true,entries:[{id:'old',at:new Date().toISOString(),op:'confirm',label:'确认候选',status:'error',summary:'confirm 失败',error:'自动核对期间事实变化或仍有不确定关系，未确认',undoable:false},{id:'error',at:new Date().toISOString(),op:'edit',label:'改记忆',status:'error',summary:'edit 失败',error:'数据库暂不可用'}]};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/#/classroom`);await page.getByRole('heading',{name:'成长课堂',exact:true}).waitFor();
 await page.getByRole('button',{name:'从“自然说话”开始',exact:true}).click();await page.getByRole('button',{name:'保存',exact:true}).click();await page.locator('.classroom-course').waitFor();assert.equal(calls,0);
 assert.equal(await page.getByRole('button',{name:'生成学习草案（最多1次调用）',exact:true}).isDisabled(),true);
 await page.getByLabel('启用成长课堂（可选）').check();await page.getByRole('button',{name:'生成学习草案（最多1次调用）',exact:true}).click();await page.getByRole('button',{name:'已核对，启用这份参考',exact:true}).waitFor();assert.equal(c.catalog(key).length,0);assert.equal(calls,1);
 assert.equal(await page.locator('.classroom-course img').count(),0);await page.getByRole('button',{name:'已核对，启用这份参考',exact:true}).click();await page.getByText('已启用参考',{exact:true}).waitFor();assert.equal(c.catalog(key).length,1);
 await page.getByRole('button',{name:'生成学习草案（最多1次调用）',exact:true}).click();await page.getByText('已复用原草案，没有新增模型调用',{exact:true}).waitFor();assert.equal(calls,1);
 await page.getByRole('button',{name:'实际聊天不合适，先停用',exact:true}).click();await page.locator('textarea[name="note"]').fill('这轮依然没有回应细节');await page.getByRole('button',{name:'保存反馈',exact:true}).click();await page.getByText('已停用',{exact:true}).waitFor();assert.equal(c.catalog(key).length,0);
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
 await page.goto(`http://127.0.0.1:${server.address().port}/#/upkeep`);await page.getByText('暂未确认',{exact:true}).waitFor();await page.getByText('数据库暂不可用',{exact:true}).waitFor();assert.equal(await page.getByText('confirm 失败',{exact:true}).count(),0);assert.deepEqual(errors,[]);
 console.log('PASS classroom UI: independent page, free creation, opt-in, one paid generation, reuse, review gate, feedback pause, escaped content, mobile; audit explains deferred vs failed');
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));const rel=path.relative(os.tmpdir(),tmp);if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel))fs.rmSync(tmp,{recursive:true,force:true})}
