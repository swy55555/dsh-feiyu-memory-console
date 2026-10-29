import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import crypto from 'node:crypto';
import http from 'node:http';
import * as emotion from '../bridge/emotion.js';
import {Continuity} from '../bridge/continuity.mjs';
const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
const between=(a,b)=>{const x=source.indexOf(a),y=source.indexOf(b,x);assert.ok(x>=0&&y>x);return source.slice(x,y)};

test('actual emotion entry accepts unified appraisal and does not spend a second model call',async()=>{
  let calls=0;
  const ctx=vm.createContext({...emotion,crypto,emotionState:emotion.emptyEmotion(),emotionLast:{text:'',at:0},
    cfg:{socialV2:{emotion:{appraisalModel:{enabled:true}}}},emotionRecoveryCfg:()=>({}),recordEpisodeOutcome:()=>{},
    saveEmotionState:()=>{},maybeCreateEpisode:()=>null,maybeQueueSpillover:()=>{},log:()=>{},
    runHeadlessPrompt:()=>{calls++;throw Error('unexpected second call')}});
  const fn=vm.runInContext(between('  function noteEmotion(','  const emotionTimer =')+';noteEmotion',ctx);
  const result=await fn({text:'今天有点紧张',key:'private:1',messageId:'m1',recentMessages:[],semanticAppraisal:{kind:'user_distress',target:'user',confidence:.95,intensity:.4,evidence:['有点紧张']}});
  assert.equal(calls,0);assert.equal(result.kind,'user_distress');assert.equal(ctx.emotionState.dynamics.conflict,0);
});
test('actual context composer includes related continuity when fact recall is disabled; automatic prompts omit it',async()=>{
  let uses=0;
  const ctx=vm.createContext({crypto,cfg:{socialV2:{memoryRecall:{enabled:false},context:{enabled:false}}},
    humanContextEnabled:()=>false,noteSessionTurn:()=>{},scheduleRotationCheck:()=>{},dailyMemorySubjects:new Map(),dailyRecallQueries:new Map(),
    recordRetrievalTrace:()=>{},continuity:{prompt:(key,context)=>{uses++;context.continuity={key,eventId:'event'};return '挂念参考\n'}}});
  const fn=vm.runInContext(between('  async function withMemoryContext(','  const dailyRecallQueries')+';withMemoryContext',ctx);
  const c={allowIdleAssociation:true};assert.match(await fn('private:1','当前问题',c),/^挂念参考/);assert.equal(c.continuity.eventId,'event');
  assert.equal(await fn('private:1','自动任务',{}),'自动任务');assert.equal(uses,1);
});
test('actual console route denies agent access and preserves unrelated settings on toggle',async()=>{
  let cfg={socialV2:{association:{idleEnabled:true}}},file={ownerQQ:1,socialV2:{association:{idleEnabled:true},dailyMemory:{maxCallsPerDay:0}}},invalidated=0;
  const route=between("        if (url.pathname === '/api/continuity') {","        if (req.method === 'GET' && url.pathname === '/api/memory/idle-association')");
  async function run(headers,body,method='POST'){
    let result;
    const ctx=vm.createContext({url:{pathname:'/api/continuity'},req:{method,headers},cfg,ROOT:'test',path,
      readBody:async()=>body,readConfigObject:()=>structuredClone(file),atomicWriteJson:(_p,v)=>{file=v},
      mindWorkspaces:{invalidate:()=>{}},continuity:{snapshot:()=>({enabled:cfg.socialV2.continuity?.enabled}),invalidate:()=>invalidated++,edit:()=>{throw Error('invalid')}},
      sendJson:(data,status=200)=>result={data,status}});
    await vm.runInContext('(async()=>{'+route+'})()',ctx);return result;
  }
  assert.equal((await run({'x-agent-call':'1'},{enabled:true})).status,403);assert.equal(invalidated,0);
  assert.equal((await run({'x-agent-token':'x'},null,'GET')).status,403);
  assert.equal((await run({},{enabled:true})).status,200);assert.equal(invalidated,1);
  assert.equal(file.socialV2.dailyMemory.maxCallsPerDay,0);assert.equal(file.socialV2.association.idleEnabled,true);
  assert.equal(cfg.socialV2.continuity.enabled,true);assert.equal((await run({},{collection:'beliefs',id:'x',action:'reject'})).status,400);
});
test('host API forwards authenticated continuity calls and enforces write header',async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'feiyu-continuity-api-'));process.env.DSH_HOME=tmp;process.env.FEIYU_BRIDGE_DIR=path.join(tmp,'qq-bridge');
  fs.mkdirSync(path.join(tmp,'qq-bridge/state'),{recursive:true});fs.writeFileSync(path.join(tmp,'qq-bridge/state/console-token'),'fixture-token');
  const calls=[];const bridge=http.createServer(async(req,res)=>{let body='';for await(const b of req)body+=b;calls.push({url:req.url,token:req.headers['x-console-token'],body:body?JSON.parse(body):null});res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({ok:true,enabled:false,concerns:[],beliefs:[],events:[]}));});
  await new Promise(r=>bridge.listen(0,'127.0.0.1',r));fs.writeFileSync(path.join(tmp,'qq-bridge/config.json'),JSON.stringify({consolePort:bridge.address().port}));
  const {createApiHandler}=await import('../lib/api.js');const server=http.createServer(createApiHandler());await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{for(const s of [server,bridge]){s.closeAllConnections();await new Promise(r=>s.close(r))}const rel=path.relative(os.tmpdir(),tmp);if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel))fs.rmSync(tmp,{recursive:true,force:true})});
  const url=`http://127.0.0.1:${server.address().port}/api/continuity`;
  assert.equal((await fetch(url)).status,200);
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:'{"enabled":true}'})).status,403);
  assert.equal((await fetch(url,{method:'POST',headers:{'content-type':'application/json','x-feiyu-console':'1'},body:'{"enabled":true}'})).status,200);
  assert.equal(calls.length,2);assert.equal(calls[0].token,'fixture-token');assert.equal(calls[1].body.enabled,true);
});
test('actual dispatch records acceptance and failure separately from actual QQ send',async()=>{
  const events=[];let value={result:{ok:true}};
  const ctx=vm.createContext({reverse:new Map(),turnTraces:{cancel:()=>{},invalidate:()=>{}},continuity:{delivery:(_r,s)=>events.push(s)},api:{sessions:{prompt:async()=>{if(value instanceof Error)throw value;return value}}}});
  const fn=vm.runInContext(between('  async function dispatchTracedPrompt(','  function traceRow(')+';dispatchTracedPrompt',ctx);
  const c={continuity:{key:'private:1',eventId:'e'}};await fn({sessionId:'s'},c);value={result:{ok:false}};await fn({sessionId:'s'},c);value=Error('timeout');await assert.rejects(fn({sessionId:'s'},c));
  assert.deepEqual(events,['injected','rejected','delivery-unknown']);
});
