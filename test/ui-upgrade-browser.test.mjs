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
  let emotionUnavailable=false, healthy=false;
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
    else if(p==='/association/idle')body={ok:true,enabled:true,affectEnabled:true,status:'waiting-topic',expiresAt:now+600000,sources:[{id:'memory-demo',text:'喜欢雨声，也喜欢安静地读书'}],nodes:[{kind:'question',topic:'下雨的周末，要不要聊聊最近读到的故事？',sourceIds:['memory-demo']}],impression:{text:'也许可以分享一段安静的阅读时光',feeling:'warmth',valence:.02,arousal:.01,expiresAt:now+600000},events:[]};
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

  healthy=true;
  data.concerns[0].title='明天的面试';data.concerns[0].detail='准备差不多了，仍在担心路上是否来得及';
  data.concerns.push({id:'c2',title:'周末去海边散步',detail:'等天气预报再决定',status:'open',expiresAt:now+2*86400000,evidence:[{at:now,messageId:'m3',quote:'周末天气好的话，我们去海边走走'}]});
  Object.assign(data.beliefs[0],{text:'也许比较在意提前做好准备',status:'tentative',confidence:.175,lastEvidenceAt:now-7*86400000,expiresAt:now+23*86400000,fading:true});
  data.beliefs.push({id:'b2',text:'也许喜欢轻松而安静的周末',status:'tentative',confidence:.35,lastEvidenceAt:now,expiresAt:now+30*86400000,evidence:[{at:now,messageId:'m3',quote:'周末天气好的话，我们去海边走走'}]});
  data.concerns.push({id:'old',title:'已经结束的演示事项',status:'closed',expiresAt:now-1,evidence:[]});
  data.events[0].summary='担心的原因从表现澄清为出行时间';data.events[0].emotion={deltaV:.014,deltaA:.022};
  await page.goto(`http://127.0.0.1:${server.address().port}/#/continuity`);
  await page.getByRole('heading',{name:'挂念与认识',exact:true}).waitFor();
  assert.equal(await page.locator('.mind-node').count(),4);
  assert.equal(await page.locator('.mind-links path').count(),0,'disabled historical view must not imply active focus');
  await page.getByLabel('启用连续事件理解（试验）').check();
  await page.locator('.mind-links path').waitFor();
  await page.getByRole('button',{name:'查看认识：也许比较在意提前做好准备',exact:true}).focus();await page.keyboard.press('Enter');
  await page.locator('.mind-detail').getByText('原话依据',{exact:true}).waitFor();
  assert.ok((await page.locator('.mind-detail').innerText()).includes('18%'));
  assert.equal(await page.locator('main img').count(),0);
  await page.getByRole('button',{name:'历史记录',exact:true}).click();assert.equal(await page.locator('.mind-node').count(),1);
  await page.getByRole('button',{name:'当前记录',exact:true}).click();
  await page.locator('#toasts .toast').waitFor({state:'hidden'});
  if(process.env.FEIYU_UI_SCREENSHOT_DIR){fs.mkdirSync(process.env.FEIYU_UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.FEIYU_UI_SCREENSHOT_DIR,'mind-dark.png'),fullPage:true})}
  await page.getByRole('button',{name:'换个明暗',exact:true}).click();await page.getByRole('heading',{name:'挂念与认识',exact:true}).waitFor();
  if(process.env.FEIYU_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.FEIYU_UI_SCREENSHOT_DIR,'mind-light.png'),fullPage:true});
  await page.getByRole('button',{name:'文字列表',exact:true}).click();await page.getByRole('heading',{name:'当前挂念',exact:true}).waitFor();
  await page.reload();await page.getByRole('heading',{name:'当前挂念',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'文字列表',exact:true}).getAttribute('aria-pressed'),'true');
  await page.getByRole('button',{name:'可视化',exact:true}).click();await page.setViewportSize({width:390,height:844});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'mobile visual overflow');
  await page.getByRole('button',{name:'查看认识：也许比较在意提前做好准备',exact:true}).click();
  assert.ok((await page.locator('.mind-detail').innerText()).includes('参考强度'));
  if(process.env.FEIYU_UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.FEIYU_UI_SCREENSHOT_DIR,'mind-mobile.png'),fullPage:true});
  assert.deepEqual(errors,[]);console.log('UI upgrade browser OK: map selection, keyboard, genuine focus, history, theme, persistent view, mobile');
}finally{
  await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));const rel=path.relative(os.tmpdir(),tmp);if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel))fs.rmSync(tmp,{recursive:true,force:true});
}
