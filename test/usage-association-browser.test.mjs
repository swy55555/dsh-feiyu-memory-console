// Isolated UI fixtures: no live bridge, credentials, QQ calls or paid model calls.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createRequire} from 'node:module';
import {emptyEmotion} from '../bridge/emotion.js';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.FEIYU_PLAYWRIGHT_PATH || 'playwright');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'feiyu-usage-ui-'));
process.env.DSH_HOME=tmp;
const {createApiHandler}=await import('../lib/api.js');
const server=http.createServer(createApiHandler());
let browser;
try {
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.FEIYU_BROWSER_CHANNEL?{channel:process.env.FEIYU_BROWSER_CHANNEL}:{})});
  const page=await browser.newPage({viewport:{width:1365,height:1000}});
  const errors=[], posts=[], periods=[];
  page.on('pageerror',e=>errors.push(e.message));
  const now=Date.now(), feature={key:'internal:可塑性记忆:idle_association',label:'空闲联想',cost:24,tokens:12000,totalTokens:12000,steps:1205,buckets:{cacheMiss:10000,output:2000,reasoning:1000}};
  await page.route('**/api/**',async route=>{
    const u=new URL(route.request().url()), p=u.pathname.replace(/^.*\/api/,'');
    let body={ok:true};
    if(p==='/overview')body={...body,active:1,total:1,candidate:0,scopes:[],recent:[],fading:[],idleAssociation:true,idleAffect:false,health:{ok:true,capabilities:['emotion'],bridge:{ok:true}}};
    else if(p==='/context/keys')body={...body,keys:[]};
    else if(p==='/usage')body={...body,tokens:{symbol:'¥',totals:{cost:48,totalTokens:24000},features:[feature],conversations:[]}};
    else if(p==='/usage/series') {
      const hours=Number(u.searchParams.get('hours'));periods.push(hours);const span=hours*3600000, bucketMs=span/48;
      body={...body,series:{featureAccountingVersion:1,from:now-span,to:now,bucketMs,features:[feature],buckets:Array.from({length:48},(_,i)=>({t:now-span+i*bucketMs,cost:1,pluginCost:.5,pluginTokens:250}))}};
    } else if(p==='/association/idle') {
      if(route.request().method()==='POST')posts.push(route.request().postDataJSON());
      body={...body,status:'waiting-topic',expiresAt:now+600000,nodes:[{kind:'question',topic:'<img src=x onerror=alert(1)> 雨天看什么书？'}],sources:[{text:'喜欢雨声'}],events:[{at:now,status:'waiting-topic'},{at:now-500,status:'injected',topics:['雨天读书']}]};
    } else if(p==='/emotion')body={...body,emotion:{...emptyEmotion(now),subjective:{text:'也许最近忙，我有一点担心',valence:-.02,arousal:.01,expiresAt:now+600000}}};
    else if(p==='/episodes')body={...body,items:[]};
    await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(url+'/#/cost');
  await page.getByRole('heading',{name:'所选时段 · 功能花费'}).waitFor();
  assert.equal(await page.locator('[title*="总 ¥"]').count(),48);
  await page.getByText('总 ¥48.00 · 可塑性记忆 ¥24.00',{exact:true}).waitFor();
  for(const name of ['7 天','30 天']) {
    const response=page.waitForResponse(r=>r.url().includes('/usage/series?'));
    await page.getByRole('button',{name,exact:true}).click();await response;
    assert.equal(await page.locator('[title*="总 ¥"]').count(),48);
  }
  assert.deepEqual(periods,[24,168,720]);
  await page.goto(url+'/#/overview');
  await page.getByLabel('允许联想产生轻微主观感受（试验）').check();
  await page.getByText('已开启轻微主观感受',{exact:true}).waitFor();
  assert.deepEqual(posts,[{affectEnabled:true}]);
  await page.getByRole('button',{name:'查看联想去向',exact:true}).click();
  await page.getByText('本轮不相关，继续暂存',{exact:true}).waitFor();
  assert.ok(await page.getByText(/不代表实际表达/).count());
  assert.equal(await page.locator('.modal img').count(),0);
  await page.getByRole('button',{name:'知道了',exact:true}).click();
  await page.goto(url+'/#/emotion');
  await page.getByRole('heading',{name:'联想带来的主观感受'}).waitFor();
  await page.getByText('也许最近忙，我有一点担心（未确认）',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  if(process.env.FEIYU_UI_SCREENSHOT)await page.screenshot({path:process.env.FEIYU_UI_SCREENSHOT,fullPage:true});
  console.log('usage/association browser OK: 48 buckets, 24h/7d/30d, independent toggle, escaped audit, subjective emotion');
} finally {
  await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));
  const rel=path.relative(os.tmpdir(),tmp);if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel))fs.rmSync(tmp,{recursive:true,force:true});
}
