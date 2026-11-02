import assert from 'node:assert/strict';import http from 'node:http';import {createRequire} from 'node:module';import {createApiHandler} from '../lib/api.js';
const {chromium}=createRequire(import.meta.url)(process.env.FEIYU_PLAYWRIGHT_PATH||'playwright');
const server=http.createServer(createApiHandler());let browser;
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,channel:'msedge'});
 const page=await browser.newPage({viewport:{width:1100,height:900}}),errors=[],calls=[];page.on('pageerror',e=>errors.push(e.message));let revoked=false,fail=false;
 await page.route('**/api/**',async route=>{
  const req=route.request(),u=new URL(req.url()),p=u.pathname.replace(/^.*\/api/,'');let data={ok:true};
  if(p==='/overview')data={ok:true,ownerQQ:'1',scopes:[{scope:'private:1',label:'测试私聊'}],recent:[],fading:[],health:{ok:true,capabilities:[]}};
  if(p==='/library')data={ok:true,total:1,rows:[{id:'r1',scope:'private:1',text:'用户曾说：只在周末喝咖啡',status:'active',tier:'normal',memoryKind:'experience',sourceId:'m1',subjectId:'1',sourceText:'只在周末喝咖啡',sourceTime:Date.now(),createdAt:Date.now(),importance:.5,strength:10,recall:.9}]};
  if(p.startsWith('/source-correction/')){
   assert.equal(req.method(),'POST');assert.equal(req.headers()['x-feiyu-console'],'1');const body=req.postDataJSON();assert.equal(body.scope,'private:1');assert.equal(body.id,'r1');calls.push(p);
   if(p.endsWith('/prepare'))data={ok:true,state:revoked?'revoked':'valid',sourceVersion:'v1',revision:'r1',correctionRevision:1,reason:'此前说错',count:1,targets:[{kind:'memory',text:'<script>测试文本不会执行</script>'}]};
   if(p.endsWith('/apply')){assert.equal(body.sourceVersion,'v1');assert.equal(body.revision,'r1');assert.ok(body.reason);if(fail)data={ok:false,error:'来源或相关记忆已变化，请重新预览'};else{revoked=true;data={ok:true,paused:1}}}
   if(p.endsWith('/undo')){assert.equal(body.correctionRevision,1);revoked=false;data={ok:true,restored:0,skipped:1}}
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/#/library?scope=private:1&status=active`);
 await page.getByText('查看记忆来源',{exact:true}).first().click();assert.equal(calls.length,0);
 const toggle=page.getByText('原话说错了：撤回依据或查看撤销',{exact:true});await toggle.click();await page.getByText('记忆：<script>测试文本不会执行</script>',{exact:true}).waitFor();
 const apply=page.getByRole('button',{name:'撤回这句原话的依据资格',exact:true});assert.equal(await apply.isDisabled(),true);
 await page.getByLabel('撤回来源的原因').fill('原话的条件说错了');assert.equal(await apply.isDisabled(),true);await page.getByRole('checkbox',{name:'我确认要撤回整句原话的依据资格，而非只改一条记忆'}).check();
 fail=true;await apply.click();await page.locator('.source-correction [role=status]').filter({hasText:'已变化'}).waitFor();assert.equal(revoked,false);
 await toggle.click();await toggle.click();await page.getByLabel('撤回来源的原因').fill('原话的条件说错了');await page.getByRole('checkbox',{name:'我确认要撤回整句原话的依据资格，而非只改一条记忆'}).check();
 await page.locator('.source-correction').screenshot({path:process.env.FEIYU_CORRECTION_SCREENSHOT||'../source-correction-panel.png'});
 fail=false;await apply.click();await page.locator('.source-correction [role=status]').filter({hasText:'已暂停 1 条'}).waitFor();
 await toggle.click();await toggle.click();await page.getByRole('button',{name:'撤销这次来源纠正',exact:true}).click();await page.locator('.source-correction [role=status]').filter({hasText:'1 条已有后续修改'}).waitFor();
 assert.deepEqual(errors,[]);assert.equal(revoked,false);console.log('PASS correction editor: explicit whole-source action, version conflict, literal text, undo preserving later edits, no live calls');
}finally{await browser?.close();await new Promise(r=>server.close(r));}
