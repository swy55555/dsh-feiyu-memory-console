import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.FEIYU_PLAYWRIGHT_PATH||'playwright');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'xinji-sharing-ui-'));process.env.DSH_HOME=temp;
const {createApiHandler}=await import('../lib/api.js');const server=http.createServer(createApiHandler());let browser;
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,...(process.env.FEIYU_BROWSER_CHANNEL?{channel:process.env.FEIYU_BROWSER_CHANNEL}:{})});
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
 const scopes=[{scope:'private:1',label:'主人',kind:'private',count:1},{scope:'group:9',label:'测试群',kind:'group',count:0}];
 const row={id:'m',scope:'private:1',text:'普通偏好 <img src=x onerror=alert(1)>',status:'active',tier:'normal',importance:.5,createdAt:Date.now()};
 await page.route('**/api/**',async route=>{
  const api=new URL(route.request().url()).pathname.replace(/^.*\/api/,'');let data={ok:true};
  if(api==='/overview')data={ok:true,total:1,active:1,scopes,recent:[],fading:[],memoryShare:true,health:{ok:true,capabilities:[],bridge:{ok:true}}};
  if(api==='/library')data={ok:true,rows:[row],total:1,scopes,counts:{active:1}};
  if(api==='/version')data={ok:true,version:'0.10.1'};
  if(api==='/memory-sharing'){
   const body=route.request().postDataJSON();posts.push(body);
   data={ok:true,id:'m',scope:row.scope,text:row.text,revision:'rev',privacy:{level:'public',origin:'semantic',revision:'rev'},grants:[],blocked:[]};
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/#/library`);
 await page.getByRole('button',{name:'共享范围',exact:true}).click();
 await page.getByText(/当前：普通，可自动共享/).waitFor();
 assert.equal(await page.locator('.modal img').count(),0);
 await page.locator('select[name="policy"]').selectOption('private');await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.getByText('已保存共享范围',{exact:true}).waitFor();
 assert.deepEqual(posts.at(-1),{id:'m',scope:'private:1',action:'private',expected_hash:'rev'});
 await page.getByRole('button',{name:'共享范围',exact:true}).click();
 await page.locator('select[name="target"]').selectOption('group:9');await page.locator('select[name="targetAction"]').selectOption('revoke');await page.getByRole('button',{name:'保存',exact:true}).click();
 await page.waitForFunction(()=>!document.querySelector('select[name="target"]'));
 assert.deepEqual(posts.at(-1),{id:'m',scope:'private:1',action:'revoke',target_scope:'group:9',expected_hash:'rev'});
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'共享范围',exact:true}).click();
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));assert.deepEqual(errors,[]);
 console.log('PASS sharing UI: privacy choice, target block, revision binding, escaped text, mobile layout');
}finally{await browser?.close();await new Promise(r=>server.close(r));const rel=path.relative(os.tmpdir(),temp);if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel))fs.rmSync(temp,{recursive:true,force:true});}
