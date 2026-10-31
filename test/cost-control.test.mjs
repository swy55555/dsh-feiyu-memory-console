import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
function block(a,b){const start=source.indexOf(a),end=source.indexOf(b,start);assert.ok(start>=0&&end>start);return source.slice(start,end);}
const rotateCode=block('  async function maybeRotateSession(key)', '  // 控制台手动补摘要');
const key='private:1',now=1800000000000;
function fixture(extra={}){
 const st={lastIncomingAt:now-120000,unread:[]},retired=[];
 const ctx=vm.createContext({cfg:{socialV2:{context:{}}},state:{sessions:{[key]:'sid'},sessionTurns:{[key]:1}},tokenLedger:{latestInputTokens:()=>120000},
  Date:{now:()=>now},isSessionAllowedInCurrentMode:()=>true,promptQueues:new Map(),v2TurnStartAt:new Map(),collectors:new Map(),activeWaits:new Map(),pendingWakeKeys:new Set(),summaryRuns:new Map(),summaryFailures:new Map(),rotatingSessions:new Set(),
  getSocialV2State:()=>st,summarizeSession:async()=>({ok:true,id:'summary',messages:12}),retireSession:k=>retired.push(k),saveState:()=>{},log:()=>{},...extra});
 return {ctx,st,retired,rotate:vm.runInContext(rotateCode+';maybeRotateSession',ctx)};
}
test('large actual input rotates after saved summary even below wake-count threshold; disable and small contexts remain',async()=>{
 const f=fixture();assert.equal((await f.rotate(key)).ok,true);assert.deepEqual(f.retired,[key]);assert.equal(f.ctx.state.sessionTurns[key],0);
 for(const extra of [{tokenLedger:{latestInputTokens:()=>1200}},{cfg:{socialV2:{context:{autoRotate:false}}}},{isSessionAllowedInCurrentMode:()=>false},{cfg:{socialV2:{context:{rotateInputTokens:0}}}}]){
  const f=fixture(extra);assert.equal((await f.rotate(key)).ok,false);assert.equal(f.retired.length,0);
 }
});
test('rotation never interrupts active model/tool waits, unread messages, or new activity during summarization',async()=>{
 for(const extra of [{v2TurnStartAt:new Map([['sid',now]])},{collectors:new Map([['sid',{}]])},{activeWaits:new Map([[key,{}]])},{pendingWakeKeys:new Set([key])},{promptQueues:new Map([[key,{running:true}]])}]){
  const f=fixture(extra);assert.equal((await f.rotate(key)).reason,'active');assert.equal(f.retired.length,0);
 }
 const unread=fixture();unread.st.unread=[{}];assert.equal((await unread.rotate(key)).reason,'active');
 let release;const f=fixture({summarizeSession:()=>new Promise(r=>release=r)});
 const job=f.rotate(key);assert.equal((await f.rotate(key)).reason,'busy');f.st.lastIncomingAt=now;
 release({ok:true,id:'saved',messages:12});assert.equal((await job).reason,'interrupted');assert.equal(f.retired.length,0);
});
test('failed summaries back off and cannot retire a session; transient scheduling gets another check',async()=>{
 let calls=0;const f=fixture({summarizeSession:async()=>{calls++;throw Error('offline')}});
 assert.equal((await f.rotate(key)).reason,'error');assert.equal((await f.rotate(key)).reason,'backoff');assert.equal(calls,1);assert.equal(f.retired.length,0);
 const callbacks=[];let checks=0;
 const ctx=vm.createContext({cfg:{},state:{sessions:{[key]:'sid'}},Date:{now:()=>now},isSessionAllowedInCurrentMode:()=>true,log:()=>{},
  setTimeout:fn=>{callbacks.push(fn);return {unref(){}}},maybeRotateSession:async()=>({reason:++checks===1?'active':'not-enough'})});
 const schedule=vm.runInContext(block('  const rotationTimers =','  async function summarizeSession(')+';scheduleRotationCheck',ctx);
 schedule(key);schedule(key);assert.equal(callbacks.length,1);callbacks.shift()();await new Promise(r=>setImmediate(r));assert.equal(callbacks.length,1);
 callbacks.shift()();await new Promise(r=>setImmediate(r));assert.equal(callbacks.length,0);
});
test('simultaneous identical summaries share one call; conflicting manual mode does not start another',async()=>{
 let calls=0,release;const ctx=vm.createContext({summaryRuns:new Map(),summarizeSessionNow:async()=>{calls++;return new Promise(r=>release=r)}});
 const summarize=vm.runInContext(block('  async function summarizeSession(key,','  async function summarizeSessionNow(')+';summarizeSession',ctx);
 const a=summarize(key),b=summarize(key);await new Promise(r=>setImmediate(r));assert.equal(calls,1);
 assert.equal((await summarize(key,{force:true})).reason,'busy');release({ok:true});assert.equal((await a).ok,true);assert.equal((await b).ok,true);assert.equal(ctx.summaryRuns.size,0);
});
test('proactive meme OCR uses fresh recent images, not distant history; cache stays bounded without mass eviction',async()=>{
 const rows=[],cache=new Map();let calls=0;
 const ctx=vm.createContext({cfg:{},STATE_DIR:'.',MEME_DB_PATH:'.',Date:{now:()=>now},memeImageDescriptions:cache,pendingMemeCandidates:new Map(),emotionState:{},AbortController,setTimeout,clearTimeout,
  loadMemePlayConfig:()=>({enabled:true,private:true,proactive:true}),getSocialV2State:()=>({recentMessages:rows}),memeContextFor:()=>'',resolveMediaList:async()=>[{type:'image'}],
  runHeadlessPrompt:async()=>{calls++;return '图中文字'},fetch:async()=>({json:async()=>({results:[]})}),usedTitlesFromMemories:()=>[],pickMemeCandidates:()=>[],log:()=>{}});
 const run=vm.runInContext(block('  async function withMemeContext(','  function noteMemeUse(')+';withMemeContext',ctx);
 rows.push({messageId:'old',time:now-301000,media:[{kind:'image'}]});await run(key,'消息');assert.equal(calls,0);
 rows.push({messageId:'new',time:now-1000,media:[{kind:'image'}]});await run(key,'消息');await run(key,'消息');assert.equal(calls,1);
 cache.clear();for(let i=0;i<80;i++)cache.set('cache'+i,'图');await run(key,'消息');assert.equal(cache.size,80);assert.ok(cache.has('cache79'));
 cache.clear();rows.push(...Array.from({length:4},()=>({time:now,text:'新话题'})));await run(key,'消息');assert.equal(calls,2);
});
