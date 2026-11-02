import assert from 'node:assert/strict';
import {test} from 'node:test';
import http from 'node:http';
import vm from 'node:vm';
import fs from 'node:fs';
import {exploreJson} from '../bridge/explore-fetch.mjs';
import {exploreConfig} from '../bridge/explore.mjs';
import {emptyTaste,recordExploration,TASTE_LIMITS} from '../bridge/taste.mjs';
import {emptyShared,proposeShared,updateShared} from '../bridge/shared-activities.mjs';
import {createApiHandler} from '../lib/api.js';
import * as exploration from '../bridge/explore.mjs';
import * as tasteModule from '../bridge/taste.mjs';
import * as selfModule from '../bridge/self-memory.mjs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {parseNarrativeOutput,storeNarrative,normalizeNarrativeState} from '../bridge/narrative.mjs';

test('cookie scope, HTTPS allowlist, redirect rejection and response failures',async()=>{
 const calls=[];const fetchImpl=async(url,options)=>{calls.push({url,...options});return new Response('{"ok":true}')};
 await exploreJson('https://api.bilibili.com/x/test',{headers:{cookie:'TEST-ONLY'},fetchImpl});
 await exploreJson('https://aisubtitle.hdslb.com/test',{headers:{cookie:'TEST-ONLY'},fetchImpl});
 assert.equal(calls[0].headers.cookie,'TEST-ONLY');assert.equal(calls[1].headers.cookie,undefined);
 assert.equal(calls[0].redirect,'error');assert.ok(calls[0].signal instanceof AbortSignal);
 for(const url of ['https://untrusted.invalid/s','http://api.bilibili.com/x','https://api.bilibili.com.evil.invalid/x','https://user@api.bilibili.com/x','https://api.bilibili.com:444/x'])await assert.rejects(exploreJson(url,{fetchImpl}));
 assert.equal(calls.length,2);
 await assert.rejects(exploreJson('https://api.bilibili.com/x',{fetchImpl:async()=>new Response('{}',{status:503})}),/HTTP 503/);
 await assert.rejects(exploreJson('https://api.bilibili.com/x',{fetchImpl:async()=>new Response('x'.repeat(2*1024*1024+1))}),/过大/);
});
test('exploration config bounds and repeated evidence remain idempotent',()=>{
 const cfg=exploreConfig({maxPagesPerRun:-7,maxCallsPerRun:NaN,timezone:'bad',quietHours:['bogus'],enabled:'yes'});
 assert.equal(cfg.maxPagesPerRun,1);assert.equal(cfg.maxCallsPerRun,3);assert.equal(cfg.timezone,'Asia/Shanghai');assert.equal(cfg.enabled,false);
 let state=emptyTaste();for(let i=0;i<20;i++)state=recordExploration(state,{topic:'合成话题',evidence:{url:'https://example.invalid/1',excerpt:'合成证据',author:'A'},now:1000+i}).state;
 assert.equal(state.topics[0].strength,.2);assert.equal(state.topics[0].evidence.length,1);
 for(let i=0;i<50;i++)state=recordExploration(state,{topic:'合成'+String(i).padStart(3,'0'),evidence:{url:'https://example.invalid/'+i,excerpt:'合成证据'}}).state;
 assert.equal(state.topics.length,TASTE_LIMITS.maxTopics);
});
test('shared activity transitions reject skipped/reversed steps and duplicate receipts',()=>{
 let state=proposeShared(emptyShared(),{title:'合成活动',now:1000}).state;const id=state.activities[0].id;
 assert.equal(updateShared(state,id,'done').ok,false);
 state=updateShared(state,id,'accepted',{},2000).state;
 assert.equal(updateShared(state,id,'accepted',{},3000).state.activities[0].acceptedAt,2000);
 state=updateShared(state,id,'done',{},4000).state;
 assert.equal(updateShared(state,id,'accepted').ok,false);
 assert.equal(updateShared(state,id,'dropped').ok,false);
});
test('DNS rebinding Host cannot reach local console exports',async()=>{
 const handler=createApiHandler();const server=http.createServer((req,res)=>handler(req,res));
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {const base='http://127.0.0.1:'+server.address().port;
  const status=await new Promise((resolve,reject)=>{const req=http.request(base+'/api/export',{headers:{host:'attacker.invalid'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end()});assert.equal(status,403);
  const page=await fetch(base+'/');assert.equal(page.status,200);
 }finally{await new Promise(r=>server.close(r));}
});
test('actual message handler requires current owner and explicit non-negated confirmation',()=>{
 const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
 const start=source.indexOf('  function checkSharedResponses('),end=source.indexOf('  const opennessTimer',start);
 let state=proposeShared(emptyShared(),{title:'合成活动',now:1000}).state;
 const ctx=vm.createContext({cfg:{ownerQQ:123},sharedState:state,activeShared:s=>s.activities.find(a=>['proposed','accepted'].includes(a.status)),initiativeAvailable:()=>true,updateShared,atomicWriteJson:()=>{},SHARED_FILE:'fixture'});
 vm.runInContext(source.slice(start,end),ctx);
 for(const text of ['不可以','还没看完','可以','好'])ctx.checkSharedResponses('private:123',{text,time:2000});
 assert.equal(ctx.sharedState.activities[0].status,'proposed');
 ctx.checkSharedResponses('private:456',{text:'一起看：接受',time:2000});assert.equal(ctx.sharedState.activities[0].status,'proposed');
 ctx.checkSharedResponses('private:123',{text:'一起看：接受',time:2000});assert.equal(ctx.sharedState.activities[0].status,'accepted');
 ctx.checkSharedResponses('private:123',{text:'一起看：完成',time:3000});assert.equal(ctx.sharedState.activities[0].status,'done');
 assert.match(source,/checkSharedResponses\(key, msg\)/);
});

test('actual exploration route respects pause, page cap, lock, and cancels stale model writes',async()=>{
 const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
 const start=source.indexOf("        if (req.method === 'POST' && url.pathname === '/api/explore/run')");
 const end=source.indexOf("        if (req.method === 'GET' && url.pathname === '/api/self-memory/status')",start);
 function fixture({paused=false,short=false,stall=false}={}){
  const calls=[],writes=[],responses=[];let release,started;const modelStarted=new Promise(r=>started=r);
  const content='完全合成的字幕，验证来源引用和暂停，不含真实数据。'.repeat(12);
  const ctx=vm.createContext({...exploration,...tasteModule,...selfModule,path,os,Date,Set,JSON,Number,String,Math,AbortSignal,
   cfg:{socialV2:{explore:{maxPagesPerRun:1}}},STATE_DIR:'fixture',exploreRunning:false,narrativeRunning:false,initiativeEpoch:0,paused,
   readJsonSafe:()=>null,fs:{readFileSync:()=>{throw Error('no fixture credential')}},log:()=>{},
   atomicWriteJson:(p,v)=>writes.push({p,v}),sendJson:(b,status=200)=>responses.push({b,status}),
   exploreJson:async input=>{const url=String(input);calls.push(url);
    if(url.includes('/search/type'))return {data:{result:[0,1,2].map(i=>({bvid:'BVfixture'+i,title:'古城街景',author:'fixture',play:50000}))}};
    if(url.includes('/nav'))return {data:{wbi_img:{img_url:'https://fixture/key.png',sub_url:'https://fixture/key.png'}}};
    if(url.includes('/view?'))return {data:{bvid:'BVfixture',title:'古城街景',desc:'合成',cid:123,owner:{name:'fixture'}}};
    if(url.includes('/player/'))return {data:{subtitle:{subtitles:[{subtitle_url:'https://aisubtitle.hdslb.com/s.json',lan:'zh-CN'}]}}};
    return {body:[{content:short?'短':content}]};
   },runHeadlessPrompt:async()=>{started();if(stall)await new Promise(r=>release=r);return JSON.stringify({impressions:[{text:'街景有建筑',quote:content.slice(0,32),kind:'impression'}]})}
  });
  vm.runInContext(`function initiativeAvailable(){return !paused;} async function route(req,url){${source.slice(start,end)}}`,ctx);
  return {ctx,calls,writes,responses,modelStarted,release:()=>release(),run:()=>ctx.route({method:'POST',headers:{}},{pathname:'/api/explore/run'})};
 }
 const paused=fixture({paused:true});await paused.run();assert.equal(paused.responses[0].status,409);assert.equal(paused.calls.length,0);
 const limited=fixture({short:true});await limited.run();assert.equal(limited.calls.filter(x=>x.includes('/view?')).length,1);assert.equal(limited.ctx.exploreRunning,false);
 const pending=fixture({stall:true});const run=pending.run();await pending.modelStarted;
 await pending.run();assert.equal(pending.responses[0].status,409);
 pending.ctx.paused=true;pending.ctx.initiativeEpoch++;pending.release();await run;
 assert.equal(pending.writes.length,0);assert.equal(pending.ctx.exploreRunning,false);
});

test('meme query failure closes SQLite and openness updates the effective reference state',()=>{
 const meme=fs.readFileSync(new URL('../bridge/meme-play.js',import.meta.url),'utf8');
 let closed=0;const ctx=vm.createContext({fs:{statSync:()=>({mtimeMs:1})},_cache:{path:'',mtime:0,rows:[]},DatabaseSync:class{prepare(){throw Error('missing table')}close(){closed++}}});
 vm.runInContext(meme.slice(meme.indexOf('function rows('),meme.indexOf('\nfunction terms('))+'; rows("fixture");',ctx);assert.equal(closed,1);
 const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
 const a=source.indexOf('  function applyOpennessDelta('),b=source.indexOf('  function checkOpennessDrift(',a);
 const state={temperament:{current:{initiative:48}},history:[],audit:[],revision:1};
 const ref={state,snapshot:()=>structuredClone(state),commit:v=>{ref.state=v}};
 const c=vm.createContext({Date,structuredClone,selfReference:ref,selfReferenceEnabled:()=>true,effectivePersonaState:()=>ref.state.temperament,PERSONA_DEFAULT_LIMITS:{},applyPersonaProposal:(p,{deltas})=>({applied:true,state:{...p,current:{initiative:p.current.initiative+deltas.initiative}}})});
 vm.runInContext(source.slice(a,b)+';applyOpennessDelta(1);',c);
 assert.equal(ref.state.temperament.current.initiative,49);assert.equal(ref.state.revision,2);
});

test('accepted narrative survives storage and reload without truncation',()=>{
 const text='我们沿着河边走到石桥，沿路看见树影和水面。'.repeat(12),now=Date.now();
 assert.ok(text.length>250&&text.length<=280);
 const parsed=parseNarrativeOutput(JSON.stringify({text,evidence:[{episodeId:'a',quote:text.slice(0,100)}]}),[{id:'a',at:now,quote:text}]);
 assert.equal(parsed.ok,true);const stored=storeNarrative(null,parsed,{now});
 assert.equal(stored.entry.text,text);assert.equal(normalizeNarrativeState(stored.state).versions[0].text,text);
});

test('actual bridge impact endpoint requires authentication and disallows wildcard CORS',async()=>{
 const src=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
 const start=src.indexOf('const server = http.createServer(async (req, res) => {')+'const server = http.createServer('.length;
 const end=src.indexOf("        if (req.method === 'POST' && url.pathname === '/api/memory/confirmation-review')",start);
 const a=src.indexOf("        if (url.pathname === '/api/emotion/impact')",end),b=src.indexOf("        if (url.pathname === '/api/labels/sync')",a);
 const day=new Date().toISOString().slice(0,10);
 const ctx={URL,Buffer,crypto,path,port:0,ROOT:'/fixture',STATE_DIR:'/fixture/state',consoleToken:'fixture-token-one-1234',socialV2:{},cfg:{ownerQQ:10001},currentMode:'reserved2',isLiveAgentToken:()=>false,
  fs:{readFileSync:()=>JSON.stringify({states:[['private:10001',{dailyImpact:{[day]:{'private:10001':{dv:.1,da:.1,events:2}}}}]]})}};
 const handler=vm.runInNewContext('('+src.slice(start,end)+src.slice(a,b)+`sendJson({ok:false},404); } catch(e){sendJson({ok:false,error:e.message},500)} })`,ctx);
 const server=http.createServer(handler);ctx.server=server;
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {const url='http://127.0.0.1:'+server.address().port+'/api/emotion/impact';
  const denied=await fetch(url,{headers:{Origin:'https://attacker.invalid'}});assert.equal(denied.status,401);assert.equal(denied.headers.get('access-control-allow-origin'),null);
  const allowed=await fetch(url,{headers:{'x-console-token':ctx.consoleToken}});assert.equal(allowed.status,200);assert.equal((await allowed.json()).owner,'private:10001');
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
