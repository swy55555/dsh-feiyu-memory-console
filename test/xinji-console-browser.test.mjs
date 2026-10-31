import fs from 'node:fs';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.FEIYU_PLAYWRIGHT_PATH||'playwright');
const html=fs.readFileSync(new URL('../bridge/xinji-console.html',import.meta.url),'utf8');
const version=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url),'utf8')).version;
const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/html; charset=utf-8'});res.end(html)});
let browser;
try {
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,...(process.env.FEIYU_BROWSER_CHANNEL?{channel:process.env.FEIYU_BROWSER_CHANNEL}:{})});
 const page=await browser.newPage({viewport:{width:1440,height:1080},colorScheme:'light'}),errors=[],writes=[];
 let offline=false;
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.route('**/api/**',async route=>{
  const u=new URL(route.request().url()),name=u.pathname;
  if(offline&&name==='/api/status'){await route.abort();return}
  if(route.request().method()!=='GET')writes.push({path:name,body:route.request().postDataJSON()});
  let body={ok:true};
  if(name==='/api/status')body={ok:true,dshReady:true,engineName:'心迹',runtimeVersion:version,mode:'reserved2',role:'自我参考',roleMode:'active',ownerQQ:'10001',allowGroups:[],allowPrivate:['10001'],activity:'心迹已启动。\nQQ 通信适配已就绪。',snowluma:{connected:true,online:true,good:true,lastPacketAt:Date.now(),status:'online'}};
  if(name==='/api/sessions')body={ok:true,sessions:[]};
  if(name==='/api/pending')body={ok:true,pending:[]};
  if(name==='/api/whitelist')body={ok:true,allow:{groups:[],private:['10001']},deny:{group:[],private:[]},ownerQQ:'10001'};
  if(name==='/api/presets')body={ok:true,presets:[{id:'qq-chat-v2',trust:'user'}]};
  if(name==='/api/preset/sim-prompt')body={ok:true,preset:'qq-chat-v2',content:'完整自然表达规则（测试数据）：直接回应当前话题，保留必要细节。',warnings:[]};
  if(name==='/api/socialV2/config')body={ok:true,config:{enabled:true,agentPreset:'qq-chat-v2',tools:{}}};
  if(name==='/api/security')body={ok:true,security:{interceptNotify:true},stateDir:{hardened:true}};
  if(name==='/api/voice/list')body={ok:true,voices:[]};
  if(name==='/api/socialV2/activity'||name==='/api/socialV2/tool-log')body={ok:true,entries:[],items:[],activity:[],logs:[]};
  await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto(`http://127.0.0.1:${server.address().port}/#overview`);
 await page.getByText('v'+version,{exact:true}).waitFor();
 assert.equal(await page.locator('.xinji-welcome').isVisible(),true);
 assert.equal(await page.locator('.journey-link').count(),3);
 assert.equal(await page.locator('.journey-link').last().getAttribute('href'),'http://127.0.0.1:3080/dsh-feiyu-memory/#/library');
 assert.equal(await page.locator('#statusText').textContent(),'DSH 已连接');
 const screenshots=process.env.FEIYU_UI_SCREENSHOTS;
 if(screenshots){fs.mkdirSync(screenshots,{recursive:true});await page.screenshot({path:path.join(screenshots,'xinji-light.png'),animations:'disabled'})}
 await page.locator('#motionToggle').click();assert.equal(await page.locator('html').getAttribute('data-motion'),'off');
 await page.reload();await page.locator('#runtimeVersion').filter({hasText:version}).waitFor();assert.equal(await page.locator('html').getAttribute('data-motion'),'off');
 const views=['overview','sessions','persona','social-v2','social-v1','usage','access','operations','reference'];
 for(const view of views){await page.locator('#mainNav [data-view="'+view+'"]').click();assert.equal(await page.locator('#mainNav [aria-current="page"]').getAttribute('data-view'),view);assert.equal(await page.locator('[data-page]:visible').evaluateAll(rows=>rows.every(x=>x.dataset.page===location.hash.slice(1))),true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),view)}
 await page.locator('#mainNav [data-view="access"]').click();await page.locator('#wlGroups').fill('20001, 20002');
 await page.locator('#mainNav [data-view="persona"]').click();await page.locator('#mainNav [data-view="access"]').click();
 assert.equal(await page.locator('#wlGroups').inputValue(),'20001, 20002');
 assert.equal(writes.length,0,'presentation controls must not change configuration');
 const ids=await page.locator('[id]').evaluateAll(rows=>rows.map(r=>r.id));assert.equal(new Set(ids).size,ids.length);
 await page.locator('#mainNav [data-view="overview"]').click();await page.locator('#themeToggle').click();assert.equal(await page.locator('html').getAttribute('data-theme'),'dark');
 if(screenshots)await page.screenshot({path:path.join(screenshots,'xinji-dark.png'),animations:'disabled'});
 await page.setViewportSize({width:390,height:844});
 for(const view of views){await page.locator('#navToggle').click();await page.locator('#mainNav [data-view="'+view+'"]').click();assert.equal(await page.locator('#navToggle').getAttribute('aria-expanded'),'false');assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2),'mobile '+view)}
 await page.locator('#navToggle').click();await page.keyboard.press('Escape');assert.equal(await page.locator('#navToggle').getAttribute('aria-expanded'),'false');assert.equal(await page.locator('#navToggle').evaluate(el=>el===document.activeElement),true);
 await page.locator('#navToggle').click();await page.locator('#mainNav [data-view="overview"]').click();
 if(screenshots)await page.screenshot({path:path.join(screenshots,'xinji-mobile.png'),fullPage:true,animations:'disabled'});
 await page.emulateMedia({reducedMotion:'reduce'});await page.waitForFunction(()=>document.getElementById('motionToggle').disabled);assert.equal(await page.locator('.halo').first().evaluate(el=>getComputedStyle(el).animationName),'none');
 offline=true;await page.locator('#refreshConsole').click();await page.locator('#connectionAlert').waitFor();assert.match(await page.locator('#statusText').textContent(),/连接中断/);assert.match(await page.locator('#statusText').getAttribute('class'),/offline/);
 assert.equal(await page.locator('#metricDsh').textContent(),'连接中断');
 assert.deepEqual(errors,[]);assert.equal(writes.length,0);
 offline=false;await page.locator('#navToggle').click();await page.locator('#mainNav [data-view="access"]').click();
 await page.locator('#wlGroups').fill('20001, 20002');await page.locator('#wlSave').click();
 await page.waitForFunction(()=>document.getElementById('wlGroups').value==='');
 assert.equal(writes.length,1);assert.equal(writes[0].path,'/api/whitelist');assert.deepEqual(writes[0].body.allow.groups,[20001,20002]);
 console.log('Xinji UI passed: 9 routes, light/dark, 390px, persisted motion, reduced motion, keyboard navigation, preserved drafts, version, empty/offline states, mocked whitelist save; no live writes.');
} finally {await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
