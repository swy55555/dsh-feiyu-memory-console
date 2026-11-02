import assert from 'node:assert/strict';import http from 'node:http';import {createRequire} from 'node:module';import {createApiHandler} from '../lib/api.js';
const {chromium}=createRequire(import.meta.url)(process.env.FEIYU_PLAYWRIGHT_PATH||'playwright');const server=http.createServer(createApiHandler());let browser;
try{await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,channel:'msedge'});const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));let enabled=true,undone=false,posts=[];
const data=()=>({ok:true,enabled:true,clarificationsEnabled:enabled,concerns:[],beliefs:[],relation:{trust:.5,familiarity:0,tension:0},events:[{id:'e',at:Date.now(),status:'source-clarification',summary:'已依据本轮澄清暂停旧来源',clarification:{status:'applied',scope:'private:1',sourceVersion:'v1',correctionRevision:1,paused:0,canUndo:!undone,currentState:undone?'restored':'revoked'}}]});
await page.route('**/api/**',async route=>{const req=route.request(),p=new URL(req.url()).pathname.replace(/^.*\/api/,'');let value={ok:true};
if(p==='/overview')value={ok:true,scopes:[],recent:[],fading:[],health:{ok:true}};
if(p==='/continuity'){if(req.method()==='POST'){assert.equal(req.headers()['x-feiyu-console'],'1');enabled=req.postDataJSON().clarifications;posts.push(p)}value=data()}
if(p==='/source-correction/undo'){assert.equal(req.headers()['x-feiyu-console'],'1');assert.deepEqual(req.postDataJSON(),{scope:'private:1',sourceVersion:'v1',correctionRevision:1});undone=true;posts.push(p);value={ok:true,restored:0,skipped:0}}
if(p==='/emotion')value={ok:true,emotion:{}};
await route.fulfill({contentType:'application/json',body:JSON.stringify(value)});
});
await page.goto(`http://127.0.0.1:${server.address().port}/#/continuity`);
const toggle=page.getByRole('checkbox',{name:'复用本轮理解，处理明确的整句澄清',exact:true});await toggle.waitFor();assert.equal(await toggle.isChecked(),true);await toggle.uncheck();await page.getByText('当前心绪已更新',{exact:true}).waitFor();assert.equal(enabled,false);
await page.getByRole('heading',{name:'自动澄清记录',exact:true}).waitFor();const undo=page.getByRole('button',{name:'撤销这次自动澄清',exact:true});await undo.click();await page.getByText(/当时暂停 0 条记忆或摘要 · 已撤销/).waitFor();assert.equal(await page.getByRole('button',{name:'撤销这次自动澄清',exact:true}).count(),0);
assert.deepEqual(posts,['/continuity','/source-correction/undo']);assert.deepEqual(errors,[]);console.log('PASS clarification UI: optional control, automatic action undo even with zero memory cards, no live writes/model calls');
}finally{await browser?.close();await new Promise(r=>server.close(r))}
