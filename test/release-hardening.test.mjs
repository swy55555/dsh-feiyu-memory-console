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
import * as ownerModule from '../bridge/owner-interest.mjs';
import * as frameModule from '../bridge/explore-frames.mjs';
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
 function fixture({paused=false,short=false,stall=false,audience='none',maxCallsPerRun=3,failAudience=false,viewFrames=false,linked=false,choice=2,suggest=true,requested='BV1234567890',reviewChoice,probe,maxPerDay=2,startingBudget,startingFocus,searchMode,agentTopic='',agentKey='private:1'}={}){
  const calls=[],writes=[],responses=[];let release,started;const modelStarted=new Promise(r=>started=r);
  const content='完全合成的字幕，验证来源引用和暂停，不含真实数据。'.repeat(12);
  const inbox=ownerModule.inboxState(null);
  if(linked)ownerModule.enqueueShare(inbox,{ref:'BV1234567890',title:'露营折布',suggest});
  const ctx=vm.createContext({...exploration,...ownerModule,...frameModule,...tasteModule,...selfModule,path,os,Date,Set,JSON,Number,String,Math,AbortSignal,
   cfg:{ownerQQ:linked?'1':null,socialV2:{explore:{ownerInfluence:linked,viewFrames,maxPagesPerRun:1,maxCallsPerRun,maxPerDay,maxCostPerDay:1},voice:{ffmpegPath:'fixture-only'}}},STATE_DIR:'fixture',exploreRunning:false,narrativeRunning:false,initiativeEpoch:0,paused,currentMode:'reserved2',agentTokenOk:(key,token)=>token==='valid',v2SessionAllowed:()=>true,v2ToolEnabled:()=>true,
   readBody:async()=>({ref:requested,question:'这段验证什么？',key:agentKey,topic:agentTopic}),interestFile:()=>'fixture/interests',readShareInbox:()=>structuredClone(inbox),editShareInbox:f=>f(inbox),readJsonSafe:(p,fallback)=>p.endsWith('explore.json')&&(startingBudget||startingFocus)?{dailyBudget:startingBudget,focus:startingFocus}:fallback,fs:{readFileSync:()=>{throw Error('no fixture credential')}},log:()=>{},
   atomicWriteJson:(p,v)=>writes.push({p,v}),sendJson:(b,status=200)=>responses.push({b,status}),
   exploreJson:async input=>{const url=String(input);calls.push(url);
    if(url.includes('/search/type'))return {data:{result:[0,1,2].map(i=>({bvid:'BVfixture'+(url.includes('page=2')?'second':'first')+i,title:searchMode==='filtered-first'&&!url.includes('page=2')?'古城建筑网课':'古城街景',author:'fixture',play:50000}))}};
    if(url.includes('/nav'))return {data:{wbi_img:{img_url:'https://fixture/key.png',sub_url:'https://fixture/key.png'}}};
    if(url.includes('/view?'))return {data:{bvid:linked?'BV1234567890':'BVfixture',title:'古城街景',desc:'合成',aid:321,cid:123,owner:{name:'fixture'}}};
    if(url.includes('/dm/list.so')){if(failAudience)throw Error('offline');return '<i><d p="2">观众试验句</d></i>';}
    if(url.includes('/player/'))return {data:{subtitle:{subtitles:[{subtitle_url:'https://aisubtitle.hdslb.com/s.json',lan:'zh-CN'}]}}};
    return {body:[{from:1,to:4,content:short?'短':content}]};
   },fetchFrames:async()=>[1,2,3].map(at=>({at,image:{data:String(at)}})),
   runHeadlessPrompt:async (prompt,timeout,images)=>{started();if(prompt.startsWith('空闲时'))return JSON.stringify({choice,topic:'露营'});if(images?.length){assert.equal(images.length,3);assert.ok(!prompt.includes('字幕初判示例'));return JSON.stringify({status:probe?.status||'observed',seen:probe?.seen||'测试画面观察'});}if(prompt.includes('观众试验句')||prompt.startsWith('现在你怎么理解'))return JSON.stringify({choice:probe?.choice??1,outcome:probe?.outcome||'none',after:'现在有另一种具体解释',evidence:probe?.evidence});if(stall)await new Promise(r=>release=r);return JSON.stringify({audience,...(probe?{provisional:{before:probe.before??'字幕初判示例',quote:probe.quote||content.slice(0,12)}}:{}),...(reviewChoice?{note:{topic:'程序',detail:'来源验证',quote:content.slice(0,20)},personalReview:{decision:reviewChoice,topic:'来源验证',anchor:'验证来源',reason:'我想再看看具体如何核验出处。'}}:{}),answerQuote:'验证来源引用和暂停',frame:{kind:'action',cue:1,question:'哪边翻过来？',a:'左边翻过来',b:'右边翻过来'},impressions:[{text:'街景有建筑',quote:content.slice(0,32),kind:'impression'}]})}
  });
  vm.runInContext(`function initiativeAvailable(){return !paused;} async function route(req,url){${source.slice(start,end)}}`,ctx);
  return {ctx,inbox,calls,writes,responses,modelStarted,release:()=>release(),run:(headers={})=>ctx.route({method:'POST',headers},{pathname:'/api/explore/run'})};
 }
 const fallback=fixture({searchMode:'filtered-first'});
 await fallback.run();
 assert.ok(fallback.responses.at(-1).b.entry.ok);
 assert.equal(fallback.calls.filter(url=>url.includes('/search/type')).length,2);
 assert.ok(fallback.calls.some(url=>url.includes('page=2')));
 for(const [enabled,limit,expected] of [[true,2,true],[true,1,false],[false,2,false]]){
  const f=fixture({viewFrames:enabled,maxCallsPerRun:limit,audience:'danmaku'});await f.run();
  const entry=f.responses.at(-1).b.entry;assert.equal(Boolean(entry?.frameReview),expected);
  if(expected){assert.equal(entry.calls,2);assert.equal(entry.frameReview.status,'observed');assert.equal(entry.audience,undefined);
   assert.ok(!JSON.stringify(f.writes.filter(w=>!w.p.endsWith('explore.json'))).includes('测试画面观察'));
   assert.match(exploration.recentExploreRecap({runs:[entry]},'你上次看的视频画面里有什么？'),/测试画面观察/);}
 }
 for(const [options,expectedCalls,changed] of [
  [{viewFrames:true,probe:{seen:'撑杆逐节抽出，篷布还张着',outcome:'revised',evidence:'撑杆逐节抽出'}},3,true],
  [{audience:'danmaku',maxCallsPerRun:2,probe:{outcome:'noticed',before:'',evidence:'观众试验句'}},2,true],
  [{audience:'danmaku',linked:true,probe:{outcome:'question',evidence:'观众试验句'}},3,true],
  [{audience:'danmaku',probe:{choice:0,outcome:'noticed',evidence:'观众试验句'}},2,false],
  [{audience:'danmaku',probe:{outcome:'noticed',evidence:'另一条观众发言'}},2,false],
  [{viewFrames:true,probe:{outcome:'none'}},3,false],
  [{viewFrames:true,probe:{outcome:'question',evidence:'画面观察'}},3,true],
  [{viewFrames:true,probe:{status:'unresolved',outcome:'revised'}},2,false],
  [{viewFrames:true,probe:{outcome:'revised',evidence:'不存在的材料'}},3,false],
  [{viewFrames:true,probe:{quote:'字幕没有这句话',outcome:'revised'}},2,false],
  [{viewFrames:true,maxCallsPerRun:2,probe:{outcome:'revised'}},2,false],
  [{viewFrames:true,linked:true,probe:{outcome:'revised'}},3,false]
 ]){
  const f=fixture(options);await f.run();
  const entry=f.responses.at(-1).b.entry;
  assert.equal(entry.calls,expectedCalls);assert.equal(Boolean(entry.reflection),changed);
  if(changed){
   assert.ok(!f.writes.some(w=>w.p.endsWith('taste.json')));
   assert.equal(entry.reflection.evidence,options.probe.evidence);
   assert.equal(entry.reflection.outcome,options.probe.outcome);
   assert.match(exploration.recentExploreRecap({runs:[entry]},'上次视频看完后想法有变化吗？'),/现在有另一种具体解释/);
   assert.doesNotMatch(exploration.recentExploreRecap({runs:[entry]},'上次视频看完后想法有变化吗？',{selfItems:[{sourceUrl:entry.video.url,sourceState:'invalid'}]}),/字幕初判示例/);
  }
 }
 for(const [args,expected] of [[{},'read'],[{short:true},'pending'],[{choice:0},'pending'],[{suggest:false},'read']]){
  const f=fixture({linked:true,...args});await f.run();const entry=f.responses.at(-1).b.entry;
  assert.equal(f.inbox.items[0].status,expected,JSON.stringify(f.responses));
  assert.equal(f.inbox.offers.length,args.suggest===false?0:1);
  assert.equal(f.calls.some(u=>u.includes('/search/type')),false);
  assert.ok(!f.writes.some(w=>w.p.endsWith('taste.json')));
  if(expected==='read'){assert.equal(entry.basis,'owner-share');assert.equal(entry.calls,2);assert.ok(entry.writes.length);}
  else assert.ok(!entry.ok);
 }
 const directed={'x-shiguang-read':'1'};
 for(const [options,status] of [[{choice:0},200],[{linked:false},409],[{paused:true},409],[{requested:'not-in-inbox'},404]]){
  const f=fixture({linked:true,...options});await f.run(directed);const result=f.responses.at(-1);
  assert.equal(result.status,status);
  if(status===200){assert.equal(result.b.entry.basis,'owner-request');assert.equal(result.b.entry.answerQuote,'验证来源引用和暂停');
   assert.equal(result.b.entry.calls,1);assert.equal(f.inbox.offers.length,0);assert.equal(f.inbox.items[0].status,'read');
   assert.ok(!f.calls.some(u=>u.includes('/search/type')));assert.ok(!f.writes.some(w=>w.p.endsWith('taste.json')));
  }else assert.equal(f.calls.length,0);
 }
 for(const headers of [{},directed]){
  for(const decision of ['add','undecided','pass']){
   const f=fixture({linked:true,reviewChoice:decision});await f.run(headers);
   const entry=f.responses.at(-1).b.entry;assert.equal(entry.personalReview.decision,decision);
   const write=f.writes.find(w=>w.p.endsWith('taste.json'));
   assert.equal(Boolean(write),decision==='add');
   if(write){assert.equal(write.v.topics[0].topic,'来源验证');assert.equal(write.v.topics[0].strength,.08);}
   assert.equal(entry.calls,headers===directed?1:2);
  }
 }
 const agent=fixture({linked:true});await agent.run({...directed,'x-agent-call':'1'});assert.equal(agent.responses.at(-1).status,403);
 const ownerTopic=fixture({linked:true,agentTopic:'耐阴绿植',startingFocus:{topic:'建筑漫游',runsLeft:1,updatedAt:Date.now()}});
 await ownerTopic.run({'x-agent-call':'1','x-agent-token':'valid'});
 const topicEntry=ownerTopic.responses.at(-1).b.entry;
 assert.equal(topicEntry.ok,true);assert.equal(topicEntry.basis,'owner-topic');assert.equal(topicEntry.topic,'耐阴绿植');
 assert.ok(topicEntry.writes.length>0);assert.ok(ownerTopic.writes.some(w=>w.p.endsWith('self-memory.json')));
 assert.ok(!ownerTopic.writes.some(w=>w.p.endsWith('taste.json')));
 assert.equal(ownerTopic.writes.find(w=>w.p.endsWith('explore.json')).v.focus?.topic,'建筑漫游');
 for(const options of [{agentTopic:'耐阴绿植',agentKey:'private:2'},{agentTopic:'<script>坏话题</script>'},{agentTopic:'耐阴绿植'}]){
  const f=fixture({linked:options.agentKey!=='private:2',...options});
  await f.run({'x-agent-call':'1','x-agent-token':options.agentKey==='private:2'?'valid':'wrong'});
  assert.equal(f.responses.at(-1).status,403);assert.equal(f.calls.length,0);
 }
 const invalidTopic=fixture({linked:true,agentTopic:'<script>坏话题</script>'});await invalidTopic.run({'x-agent-call':'1','x-agent-token':'valid'});
 assert.equal(invalidTopic.responses.at(-1).status,400);assert.equal(invalidTopic.calls.length,0);
 const missing=fixture({linked:true,short:true});await missing.run(directed);assert.equal(missing.responses.at(-1).b.entry.reason,'no-readable-content');assert.notEqual(missing.inbox.items[0].status,'read');
 const today=new Date().toLocaleDateString('en-CA');
 for(const [limit,cost,expected] of [[null,.99,200],[20,.99,429],[null,1,429]]){
  const f=fixture({maxPerDay:limit,startingBudget:{day:today,runsToday:250,costToday:cost}});
  await f.run();assert.equal(f.responses.at(-1).status,expected);
  if(expected===429){assert.equal(f.calls.length,0);assert.equal(f.responses.at(-1).b.code,cost===1?'daily-cost':'daily-runs');}
 }
 const focused=fixture({short:true,startingFocus:{topic:'建筑漫游',runsLeft:1,updatedAt:Date.now()}});
 await focused.run();
 assert.equal(focused.responses.at(-1).b.entry.reason,'no-readable-content');
 assert.equal(focused.writes.find(w=>w.p.endsWith('explore.json')).v.focus,null);
 assert.equal(exploration.normalizeExplore({focus:{topic:'建筑漫游',runsLeft:1},runs:[{ok:false,basis:'focus',topic:'建筑漫游'}]}).focus,null);
 const paused=fixture({paused:true});await paused.run();assert.equal(paused.responses[0].status,409);assert.equal(paused.calls.length,0);
 const limited=fixture({short:true});await limited.run();assert.equal(limited.calls.filter(x=>x.includes('/view?')).length,1);assert.equal(limited.ctx.exploreRunning,false);
 const pending=fixture({stall:true});const run=pending.run();await pending.modelStarted;
 await pending.run();assert.equal(pending.responses[0].status,409);
 pending.ctx.paused=true;pending.ctx.initiativeEpoch++;pending.release();await run;
 assert.equal(pending.writes.length,0);assert.equal(pending.ctx.exploreRunning,false);
 for(const [options,status,numCalls] of [[{},undefined,1],[{audience:'danmaku',maxCallsPerRun:1},undefined,1],[{audience:'danmaku',failAudience:true},'unavailable',1],[{audience:'danmaku'},'read',2]]){
  const f=fixture(options);await f.run();const entry=f.responses.at(-1).b.entry;assert.ok(entry.ok);assert.equal(entry.calls,numCalls);
  assert.equal(entry.audience?.status,status);assert.equal(f.calls.filter(u=>u.includes('/dm/list.so')).length,status?1:0);
  assert.ok(!JSON.stringify(f.writes.filter(w=>!w.p.endsWith('explore.json'))).includes('观众试验句'));
  if(status==='read')assert.equal(entry.audience.noticed,1);
 }
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

test('unlimited rounds retain daily spend after history eviction and reload',()=>{
 const now=Date.UTC(2026,10,4,4),conf=exploreConfig({enabled:true,maxPerDay:null,maxCostPerDay:1});
 assert.equal(conf.maxPerDay,null);assert.equal(exploreConfig({}).maxPerDay,2);
 const decide=budget=>exploration.exploreDecision({conf,budget,goals:{curiosity:1},now});
 assert.equal(decide({runsToday:99999,costToday:.99}).run,true);
 let state={runs:[{at:now,cost:.2}]};
 for(let i=0;i<400;i++)state=exploration.recordRun(state,{at:now+i,cost:.002});
 state=exploration.normalizeExplore(JSON.parse(JSON.stringify(state)));
 assert.equal(state.runs.length,200);assert.deepEqual(exploration.budgetState(state,now),{runsToday:401,costToday:1});
 assert.equal(decide(exploration.budgetState(state,now)).reason,'daily-cost');
 assert.deepEqual(exploration.budgetState(state,now+86400000),{runsToday:0,costToday:0});
});
