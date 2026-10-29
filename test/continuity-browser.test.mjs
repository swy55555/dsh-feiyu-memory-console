import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createRequire} from 'node:module';
import {emptyEmotion} from '../bridge/emotion.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.FEIYU_PLAYWRIGHT_PATH||'playwright');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'feiyu-continuity-ui-'));process.env.DSH_HOME=tmp;
const {createApiHandler}=await import('../lib/api.js');const server=http.createServer(createApiHandler());let browser;
try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,...(process.env.FEIYU_BROWSER_CHANNEL?{channel:process.env.FEIYU_BROWSER_CHANNEL}:{})});
  const page=await browser.newPage({viewport:{width:1365,height:950}}),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
  let emotionUnavailable=true, healthy=false;
  const now=Date.now(),data={ok:true,enabled:false,focus:['c'],relation:{trust:.5,familiarity:0,tension:0},
    concerns:[{id:'c',title:'明天的面试 <img src=x onerror=alert(1)>',detail:'还不知道结果',status:'open',expiresAt:now+86400000,evidence:[{at:now,messageId:'m1',quote:'明天面试，有点紧张'}]}],
    beliefs:[{id:'b',text:'可能担心赶不上车',status:'tentative',evidence:[{at:now,messageId:'m2',quote:'是怕赶不上车'}],revisions:[{at:now,text:'也许担心面试表现'}]}],
    events:[{id:'e',status:'understood',summary:'用户澄清担心原因',at:now,appraisal:{kind:'user_distress',target:'user',evidence:['怕赶不上车']},relation:{quote:'',delta:{trust:0,familiarity:0,tension:0}},changes:[]}]};
  await page.route('**/api/**',async route=>{
    const p=new URL(route.request().url()).pathname.replace(/^.*\/api/,'');let body={ok:true};
    if(p==='/overview')body={...body,active:0,total:0,scopes:[],recent:[],fading:[],health:{ok:true,capabilities:healthy?['queue-limit','persona','emotion','graph']:[],bridge:{ok:true}}};
    else if(p==='/version')body={ok:true,version:JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version};
    else if(p==='/emotion'){
      if(emotionUnavailable){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'测试桥接暂时离线'})});return}
      body={ok:true,emotion:emptyEmotion()};
    }
    else if(p==='/episodes')body={ok:true,items:[]};
    else if(p==='/persona'){await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({ok:false,error:'测试未声明能力'})});return}
    else if(p==='/context/keys')body={...body,keys:[]};
    else if(p==='/continuity'){
      if(route.request().method()==='POST'){
        const b=route.request().postDataJSON();posts.push(b);
        if(typeof b.enabled==='boolean')data.enabled=b.enabled;
        else data[b.collection].find(x=>x.id===b.id).status=b.action==='pause'?'paused':b.action==='close'?'closed':'rejected';
      }
      body=data;
    }
    await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/#/continuity`);
  await page.getByRole('button',{name:'文字列表',exact:true}).click();
  await page.getByRole('heading',{name:'当前挂念',exact:true}).waitFor();
  assert.equal(await page.locator('main img').count(),0);
  assert.ok(await page.getByRole('button',{name:/^性格/}).isVisible());
  assert.ok(await page.getByRole('button',{name:'情绪',exact:true}).isVisible());
  await page.getByRole('button',{name:'情绪',exact:true}).click();
  await page.getByText(/读不到情绪状态：测试桥接暂时离线/).waitFor();
  emotionUnavailable=false;await page.getByRole('button',{name:'重试读取情绪',exact:true}).click();
  await page.getByText(/读不到情绪状态/).waitFor({state:'hidden'});
  assert.ok(await page.getByRole('button',{name:/^性格/}).isVisible());
  await page.getByRole('button',{name:'当前心绪',exact:true}).click();
  await page.getByLabel('启用连续事件理解（试验）').check();await page.getByText('当前心绪已更新',{exact:true}).waitFor();
  assert.deepEqual(posts[0],{enabled:true});
  await page.getByText('查看原话依据',{exact:true}).first().click();await page.getByText(/消息 m1：明天面试/).waitFor();
  await page.getByText('修正前的理解',{exact:true}).click();await page.getByText(/也许担心面试表现/).waitFor();
  await page.getByRole('button',{name:'暂不聊这件事',exact:true}).click();await page.getByText(/暂不聊 ·/).waitFor();
  await page.getByRole('button',{name:'这个理解不对',exact:true}).click();await page.getByText(/已否定 · 独立原话/).waitFor();
  assert.deepEqual(posts.slice(1),[{collection:'concerns',id:'c',action:'pause'},{collection:'beliefs',id:'b',action:'reject'}]);
  assert.deepEqual(errors,[]);
  if(process.env.FEIYU_UI_SCREENSHOT){
    healthy=true;data.focus=[];data.concerns[0].title='明天的面试（演示数据）';
    Object.assign(data.beliefs[0],{status:'tentative',confidence:.175,lastEvidenceAt:now-7*86400000,expiresAt:now+23*86400000,fading:true});
    await page.reload();await page.getByRole('heading',{name:'明天的面试（演示数据）',exact:true}).waitFor();
    await page.screenshot({path:process.env.FEIYU_UI_SCREENSHOT,fullPage:true});
  }
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'mobile should not overflow');
  console.log('continuity browser OK: route, opt-in, costs, evidence, revisions, pause/reject, escaped text, responsive layout');
}finally{
  await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));const rel=path.relative(os.tmpdir(),tmp);if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel))fs.rmSync(tmp,{recursive:true,force:true});
}
