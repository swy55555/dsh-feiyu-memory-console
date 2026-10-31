import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import http from 'node:http';import {createRequire} from 'node:module';
import {ResponsePatterns} from '../bridge/response-patterns.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.FEIYU_PLAYWRIGHT_PATH||'playwright');
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'feiyu-mind-ui-'));process.env.DSH_HOME=tmp;
const {createApiHandler}=await import('../lib/api.js');const server=http.createServer(createApiHandler());let browser;
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await chromium.launch({headless:true,...(process.env.FEIYU_BROWSER_CHANNEL?{channel:process.env.FEIYU_BROWSER_CHANNEL}:{})});
 const page=await browser.newPage({viewport:{width:1365,height:950}}),errors=[],posts=[];page.on('pageerror',e=>errors.push(e.message));
 let available=true; let emotion={state:{label:'平静',valence:.12,arousal:.32,intensity:0,nuance:'',feelings:[]}};const patterns=new ResponsePatterns({allowed:()=>true,enabled:()=>true});
 const quote='今天的回答简短清楚 <img src=x onerror=alert(1)>';
 patterns.observe('private:1',[{strategy:'concise_first',outcome:'helpful',experienceId:'',evidenceKind:'new',quote,confidence:.99}],{id:'demo',at:Date.now(),original:quote,source:'user'});
 patterns.adjust('private:1',[{kind:'response_style',instruction:'请简短一点 <img src=x onerror=alert(1)>',quote,explicit:true,confidence:.95}],{id:'request-demo',at:Date.now(),original:quote,source:'user'});
 const data={ok:true,workspace:{enabled:true,budgetChars:2400,maxItems:5,usedChars:520,selected:[{id:'demo',type:'concern',text:'明天面试，想先把路线确认好（演示）',reason:'本轮语义理解选中，尚未结束',evidenceIds:['m1']},{id:'m2',type:'emotion',text:'有一点牵挂，但不替用户下结论',reason:'来自本轮明确表达'}],deferred:[{id:'idea',type:'association',text:'周末阅读的话题',reason:'与本轮关联不足'}]},learningConfigured:false,continuityEnabled:false,patterns:patterns.view('private:1')};
 Object.assign(data,{teacherConfigured:false,teacherModel:{model:'test-teacher',effort:'low'},teacher:{enabled:false,rounds:2,queueCount:0,lessons:[],audit:[]}});
 await page.route('**/api/**',async route=>{
  const url=new URL(route.request().url()).pathname.replace(/^.*\/api/,'');let body={ok:true};
  if(url==='/version')body={ok:true,version:'0.9.1'};
  else if(url==='/overview')body={ok:true,total:0,active:0,scopes:[],recent:[],fading:[],health:{ok:true,capabilities:['emotion','persona','mind-workspace'],bridge:{ok:true}}};
  else if(url==='/emotion')body={ok:true,emotion};
  else if(url==='/continuity')body={ok:true,enabled:false,concerns:[],beliefs:[],events:[{id:'interaction',at:Date.now(),status:'understood',summary:'依据双方原话理解本轮反馈',contextMessages:2,interaction:{meaning:'用户希望这次回应更具体',boundary:'pause',contextEvidence:[{role:'assistant',quote:'刚才的回应 <img src=x onerror=alert(1)>'}]}}]};
  else if(url==='/mind'){
   if(!available){await route.fulfill({status:503,contentType:'application/json',body:'{"ok":false,"error":"offline"}'});return;}
   if(route.request().method()==='POST'){const b=route.request().postDataJSON();posts.push(b);if(typeof b.enabled==='boolean')data.workspace.enabled=b.enabled;else if(typeof b.learningEnabled==='boolean')data.learningConfigured=b.learningEnabled;else data.patterns=patterns.edit('private:1',b);}
   body=data;
  }
  await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/#/continuity`);await page.locator('.hub-landscape').waitFor();
 assert.equal(await page.locator('a[href="#/classroom"]').count(),1);
 assert.equal(await page.getByRole('button',{name:'成长课堂',exact:true}).count(),1);
 assert.equal(posts.length,0);
 await page.getByText('本轮交流理解（可修正）',{exact:true}).click();
 await page.getByText('用户希望这次回应更具体',{exact:true}).waitFor();
 assert.ok(await page.getByText(/角色：刚才的回应 <img/).isVisible());
 assert.equal(await page.locator('main img').count(),0);
 await page.getByText('中枢设置',{exact:true}).click();
 await page.getByLabel('从明确反馈学习回应倾向（试验）').check();await page.getByText(/学习开关已保存/).waitFor();assert.deepEqual(posts[0],{learningEnabled:true});
 await page.getByText('回应习惯 · 从明确反馈中学习',{exact:true}).click();
 await page.locator('.hub-adjustment').getByText('当前明确的表达要求',{exact:true}).waitFor();
 await page.getByText('短期尝试：尚未形成习惯',{exact:true}).waitFor();
 assert.equal(await page.locator('.hub-adjustment img').count(),0);
 await page.getByRole('button',{name:'撤销这条表达要求',exact:true}).click();await page.locator('.hub-adjustment').waitFor({state:'detached'});
 const strategy=page.locator('.hub-strategy').filter({has:page.getByRole('heading',{name:'先简短，再按需展开'})});
 await strategy.getByText('查看反馈依据（1）',{exact:true}).click();assert.equal(await page.locator('main img').count(),0);
 await strategy.getByRole('button',{name:'撤销这条反馈',exact:true}).click();await strategy.getByText('查看反馈依据（1）',{exact:true}).click();await strategy.getByText(/已撤销/).waitFor();
 await strategy.getByRole('button',{name:'停用此倾向'}).click();await strategy.getByRole('button',{name:'恢复此倾向'}).waitFor();await strategy.getByRole('button',{name:'恢复此倾向'}).click();
 await page.getByText('未入选参考与原因（1）',{exact:true}).click();await page.getByText('与本轮关联不足',{exact:true}).waitFor();
 await page.locator('#toasts .toast').last().waitFor({state:'hidden'});
 await page.getByText('中枢设置',{exact:true}).click();
 await page.getByText('回应习惯 · 从明确反馈中学习',{exact:true}).click();
 await page.getByText('未入选参考与原因（1）',{exact:true}).click();
 await page.getByText('接近平常状态',{exact:true}).waitFor();
 await page.locator('.hub-thought').first().focus();await page.keyboard.press('Enter');
 await page.locator('.hub-inspect').getByText('此刻照亮的线索',{exact:true}).waitFor();
 await page.getByRole('button',{name:'查看当前心境',exact:true}).click();
 await page.getByRole('button',{name:'暂停动效',exact:true}).click();
 assert.equal(await page.locator('.hub-orb-light').evaluate(e=>getComputedStyle(e).animationPlayState),'paused');
 await page.getByRole('button',{name:'开启动效',exact:true}).click();
 await page.emulateMedia({reducedMotion:'reduce'});
 assert.equal(await page.locator('.hub-orb-light').evaluate(e=>getComputedStyle(e).animationName),'none');
 await page.emulateMedia({reducedMotion:'no-preference'});
 if(process.env.FEIYU_UI_SCREENSHOT_DIR){fs.mkdirSync(process.env.FEIYU_UI_SCREENSHOT_DIR,{recursive:true});await page.locator('.mind-hub').screenshot({path:path.join(process.env.FEIYU_UI_SCREENSHOT_DIR,'hub-dark.png')});}
 await page.getByRole('button',{name:'换个明暗',exact:true}).click();if(process.env.FEIYU_UI_SCREENSHOT_DIR)await page.locator('.mind-hub').screenshot({path:path.join(process.env.FEIYU_UI_SCREENSHOT_DIR,'hub-light.png')});
 await page.getByRole('button',{name:'文字列表',exact:true}).click();assert.equal(await page.locator('.hub-budget progress').count(),0);await page.reload();await page.locator('.hub-selected').waitFor();
 await page.getByRole('button',{name:'可视化',exact:true}).click();
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
 if(process.env.FEIYU_UI_SCREENSHOT_DIR)await page.locator('.mind-hub').screenshot({path:path.join(process.env.FEIYU_UI_SCREENSHOT_DIR,'hub-mobile.png')});
 await page.setViewportSize({width:1365,height:950});
 emotion={state:{label:'愉快',valence:.5,arousal:.7,intensity:.4,nuance:'有些期待',feelings:[{label:'期待'}]}};
 await page.getByRole('button',{name:'刷新当前心绪',exact:true}).click();await page.locator('.palette-warm').waitFor();
 data.workspace.selected.push(...[
  {id:'m3',type:'memory',text:JSON.stringify({text:'喜欢雨后的空气 <img src=x onerror=alert(1)>'}),reason:'演示来源'},
  {id:'m4',type:'belief',text:'可能更喜欢安静的相处方式（待验证）',reason:'演示来源'},
  {id:'m5',type:'relation',text:JSON.stringify({currentEvidence:'谢谢你记得这件小事'}),reason:'演示来源'}]);
 await page.getByRole('button',{name:'刷新当前心绪',exact:true}).click();await page.locator('.hub-thought').nth(4).waitFor();
 assert.equal(await page.locator('.hub-thought').count(),5);
 for(const width of [1365,1101,800,390]){
  await page.setViewportSize({width,height:950});
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
  const boxes=await page.locator('.hub-thought').evaluateAll(es=>es.map(e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom}}));
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++)assert.ok(!(boxes[i].x<boxes[j].right&&boxes[i].right>boxes[j].x&&boxes[i].y<boxes[j].bottom&&boxes[i].bottom>boxes[j].y),'reference chips must not overlap');
 }
 await page.setViewportSize({width:1365,height:950});
 await page.locator('.hub-thought').nth(2).click();assert.equal(await page.locator('.hub-inspect img').count(),0);
 await page.getByRole('button',{name:'查看当前心境',exact:true}).click();
 if(process.env.FEIYU_UI_SCREENSHOT_DIR)await page.locator('.mind-hub').screenshot({path:path.join(process.env.FEIYU_UI_SCREENSHOT_DIR,'hub-warm-five.png')});
 emotion=null;data.workspace.selected=[];
 await page.getByRole('button',{name:'刷新当前心绪',exact:true}).click();await page.locator('.palette-unknown').waitFor();
 await page.locator('.hub-inspect').getByText('等待心绪',{exact:true}).waitFor();assert.equal(await page.locator('.hub-thought').count(),0);
 available=false;await page.getByRole('button',{name:'刷新当前心绪',exact:true}).click();await page.getByText(/心绪中枢暂不可用/).waitFor();assert.equal(await page.getByLabel('启用本轮关注筛选').count(),0);
 assert.deepEqual(errors,[]);console.log('mind browser OK: toggles, dependency, evidence revoke, disable/resume, escaped text, reasons, views, themes, mobile, unavailable state');
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));const rel=path.relative(os.tmpdir(),tmp);if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel))fs.rmSync(tmp,{recursive:true,force:true});}
