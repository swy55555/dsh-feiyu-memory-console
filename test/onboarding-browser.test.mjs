import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import crypto from 'node:crypto';import vm from 'node:vm';import assert from 'node:assert/strict';import {createRequire} from 'node:module';
import {setupFeatures,setupRevision,canChooseStarter,planSetup,growthStatus} from '../bridge/onboarding.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.FEIYU_PLAYWRIGHT_PATH||'playwright');
const html=fs.readFileSync(new URL('../bridge/xinji-console.html',import.meta.url),'utf8'),source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
const start=source.indexOf('const server = http.createServer(async (req, res) => {')+'const server = http.createServer('.length,end=source.indexOf("        if (req.method === 'POST' && url.pathname === '/api/memory/confirmation-review')",start);
const dims=['warm','initiative','clingy','stability','playful','proud'],labels=['温度','主动','黏人','情绪稳定','玩心','嘴硬'];
const persona={spec:{dimensions:dims.map((key,i)=>({key,label:labels[i],desc:'低 ↔ 高',baseline:50,band:20}))},baseline:Object.fromEntries(dims.map(k=>[k,50])),current:Object.fromEntries(dims.map(k=>[k,50]))};
let file={ownerQQ:1,allow:{private:[1]},dsh:{provider:'fixture',model:'fixture'},socialV2:{}},writes=0,storageFail=false;
const context={URL,Buffer,AbortSignal,crypto,path,port:0,ROOT:'/fixture',consoleToken:'fixture-token-one-1234',socialV2:{},cfg:structuredClone(file),currentMode:'reserved2',isLiveAgentToken:()=>false,fs:{readFileSync:()=>html},
 setupFeatures,setupRevision,canChooseStarter,planSetup,growthStatus,setupOrigin:{freshPersona:true},selfReference:{state:{claims:[],queue:[]}},personaState:persona,effectivePersonaState:()=>persona,
 readConfigObject:()=>structuredClone(file),atomicWriteJson:(name,next)=>{if(storageFail)throw Error('disk write failed');writes++;file=structuredClone(next)},mindAllowed:()=>true,dshReady:true,dshPresetIds:['qq-memory'],snowlumaHealthSnapshot:()=>({connected:true,good:true}),fetch:async()=>({ok:true,json:async()=>({ok:true})})};
const handler=vm.runInNewContext('('+source.slice(start,end)+`
 sendJson({ok:true,dshReady:true,runtimeVersion:'onboarding-fixture',allow:{groups:[],private:[]},sessions:[],pending:[],presets:[],config:{},security:{},voices:[],entries:[],items:[],logs:[]});
 } catch(e){sendJson({ok:false,error:e.message},e.statusCode||500)}
})`,context);
const server=http.createServer(handler);context.server=server;context.setTimeout=setTimeout;context.clearTimeout=clearTimeout;let browser;
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`,headers={'x-console-token':context.consoleToken,'content-type':'application/json'};
 assert.equal((await fetch(base+'/api/onboarding')).status,401);
 const get=()=>fetch(base+'/api/onboarding',{headers}).then(r=>r.json()),post=body=>fetch(base+'/api/onboarding',{method:'POST',headers,body:JSON.stringify(body)});
 let report=await get();assert.equal(report.starterEligible,true);assert.equal(writes,0);
 storageFail=true;assert.equal((await post({revision:report.revision,features:report.features,starter:null})).status,500);assert.equal(file.xinjiSetup,undefined);storageFail=false;
 // Concurrent config changes must be rejected rather than overwritten.
 file.extra='changed elsewhere';assert.equal((await post({revision:report.revision,features:report.features,starter:null})).status,409);assert.equal(file.extra,'changed elsewhere');
 browser=await chromium.launch({headless:true,...(process.env.FEIYU_BROWSER_CHANNEL?{channel:process.env.FEIYU_BROWSER_CHANNEL}:{})});
 const page=await browser.newPage({viewport:{width:1365,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(token=>localStorage.setItem('consoleToken',token),context.consoleToken);
 await page.goto(base+'/#overview');await page.locator('#setupGrowthStatus').filter({hasText:'尚未开启'}).waitFor();
 await page.locator('#setupOpen').click();await page.locator('#setupDialog').waitFor();assert.equal(writes,0);
 await page.locator('#setupNext').click();await page.locator('#setupRecommended').click();await page.locator('#setupPreset').selectOption('balanced');
 assert.equal(await page.locator('#setupDimensions input').count(),6);
 await page.locator('#setupFeature-continuity').uncheck();await page.locator('#setupNext').click();await page.locator('#setupError').filter({hasText:'需要勾选'}).waitFor();
 await page.locator('#setupFeature-continuity').check();await page.locator('#setupNext').click();assert.equal(writes,0);
 const out=process.env.FEIYU_UI_SCREENSHOTS;if(out){fs.mkdirSync(out,{recursive:true});await page.screenshot({path:path.join(out,'onboarding-review.png'),animations:'disabled'})}
 await page.locator('#setupNext').click();await page.locator('#setupDone').waitFor();assert.equal(writes,1);assert.equal(file.socialV2.selfReference.enabled,true);assert.equal(context.cfg.socialV2.selfReference,undefined);assert.equal(file.xinjiSetup.starter.find(r=>r.key==='proud').value,35);assert.deepEqual(context.selfReference.state,{claims:[],queue:[]});
 await page.locator('#setupDone').click();await page.locator('#setupGrowthStatus').filter({hasText:'等待重启'}).waitFor();
 // Existing-user case: show accumulation, never permit starter reset.
 context.cfg=structuredClone(file);context.setupOrigin={freshPersona:false};context.selfReference.state={temperament:{current:{warm:66}},claims:[],queue:[{id:'source-1'}]};
 const before=structuredClone(context.selfReference.state);await page.reload();await page.locator('#setupGrowthStatus').filter({hasText:'1/12'}).waitFor();
 await page.locator('#setupOpen').click();await page.locator('#setupNext').click();assert.equal(await page.locator('#setupPreset').count(),0);assert.match(await page.locator('#setupStarter').textContent(),/保留已有/);
 await page.locator('#setupClose').click();await page.locator('#themeToggle').click();await page.setViewportSize({width:390,height:844});
 await page.locator('#setupOpen').click();await page.locator('#setupNext').click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+2));
 assert.ok(await page.locator('#setupDialog').evaluate(el=>el.scrollWidth<=el.clientWidth+2));
 if(out)await page.screenshot({path:path.join(out,'onboarding-mobile.png'),animations:'disabled'});
 await page.keyboard.press('Escape');assert.equal(await page.locator('#setupDialog').count(),0);assert.equal(await page.locator('#setupOpen').evaluate(el=>el===document.activeElement),true);
 assert.deepEqual(context.selfReference.state,before);assert.equal(writes,1);assert.deepEqual(errors,[]);
 report=await get();assert.equal((await post({revision:report.revision,features:report.features,starter:persona.spec.dimensions.map(d=>({key:d.key,value:50}))})).status,409);
 console.log('Onboarding passed: real auth/endpoint, stale forms, failed writes, no side effects from inspection, first-use choices, dependency validation, review-before-save, deferred activation, existing-state protection, mobile/dark layout and keyboard close.');
}finally{await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r))}
