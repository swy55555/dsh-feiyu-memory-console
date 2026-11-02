import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {ReferenceReuse} from '../bridge/reference-reuse.mjs';
import {TurnTraces} from '../bridge/turn-traces.mjs';

const summary = '【会话摘要】' + '用户曾分享一次旅行；这是历史参考。'.repeat(20) + '\n';
const old = '【窗口前原文】' + '过去的一句话。'.repeat(35) + '\n';
const content = [{type:'text',text:summary + old + '【交流与自我】完整人格\n【心绪】温暖\n用户现在说：你好'}];
const blocks = [{id:'summary',text:summary},{id:'history',text:old}];
const entries = (sent = content) => [
  {event:{type:'user/message',seq:1,surfaceOp:'append',data:{content:sent}}},
  {event:{type:'turn/start',seq:2,data:{}}}, {event:{type:'turn/end',seq:3,data:{}}}
];
const response = events => ({result:{ok:true,value:{events}}});
const args = {sessionId:'s',key:'private:1',content,blocks,history:async()=>response(entries())};
async function seed(cache) { const p = await cache.prepare(args); assert.equal(p.savedChars,0);p.commit(true); }

test('live surface proof works without history RPC, strips text, and gaps or disconnects restore full references',async()=>{
 const cache=new ReferenceReuse();await seed(cache);
 for(const {event} of entries())cache.observe('s',event);
 assert.ok(!JSON.stringify(cache.history('s')).includes(summary));
 const reuse=await cache.prepare({...args,history:undefined});assert.ok(reuse.savedChars>0);reuse.commit(true);
 cache.observe('s',{type:'tool/result',seq:6,surfaceOp:'append',data:{message:{content:[]}}});
 const afterGap=await cache.prepare({...args,history:undefined});assert.equal(afterGap.savedChars,0);afterGap.commit(true);
 cache.clear();assert.equal((await cache.prepare({...args,history:undefined})).savedChars,0);
});

test('reuse only after accepted full reference is on the model surface; dynamic parts survive',async()=>{
  const cache=new ReferenceReuse();await seed(cache);
  const p=await cache.prepare(args);
  assert.deepEqual(p.reused,['summary','history']);assert.ok(p.savedChars>0);
  assert.ok(p.content[0].text.endsWith('【交流与自我】完整人格\n【心绪】温暖\n用户现在说：你好'));
  assert.ok(!p.content[0].text.includes(summary));p.commit(true);
  const second=await cache.prepare(args);assert.ok(second.savedChars>0);second.commit(true);
  const refresh=await cache.prepare(args);assert.equal(refresh.savedChars,0);refresh.commit(true);
});

test('changed reference, other chat, new session, process restart and explicit disable send full text',async()=>{
  for(const overrides of [
    {sessionId:'new'}, {key:'group:1'}, {enabled:false},
    {content:[{type:'text',text:summary+'修正'}],blocks:[{id:'summary',text:summary+'修正'}]}
  ]){const cache=new ReferenceReuse();await seed(cache);assert.equal((await cache.prepare({...args,...overrides})).savedChars,0);}
  assert.equal((await new ReferenceReuse().prepare(args)).savedChars,0);
});

test('expired receipts refresh; unknown or repeated block occurrences never get removed',async()=>{
  let now=0;const cache=new ReferenceReuse({now:()=>now,maxAgeMs:10});await seed(cache);now=11;
  const p=await cache.prepare(args);assert.equal(p.savedChars,0);p.commit(true);
  const duplicate=await cache.prepare({...args,content:[{type:'text',text:summary+summary}],blocks:[blocks[0]]});
  assert.equal(duplicate.savedChars,0);duplicate.commit(true);
  const unknown=await cache.prepare({...args,blocks:[{id:'emotion',text:summary}]});assert.equal(unknown.savedChars,0);
});

test('queue acceptance, truncated history, malformed history, failures and compaction cannot justify reuse',async()=>{
  const unsafe=[[], entries().slice(1), [{event:{type:'unknown'}}],
    [...entries(),{event:{type:'future/context-operation',seq:4}}],
    [...entries(),{event:{type:'tool/result',seq:4,surfaceOp:{op:'future'}}}],
    [...entries(),{event:{type:'compaction/start',seq:4}}],
    [...entries(),{event:{type:'user/message',seq:4,surfaceOp:{op:'replace',start:1,end:3},data:{content}}}],
    [{event:{type:'agent/inbox/spliced',seq:1,data:{inserted:[{content}]}}}],entries().reverse()];
  for(const e of unsafe){const cache=new ReferenceReuse();await seed(cache);assert.equal((await cache.prepare({...args,history:async()=>response(e)})).savedChars,0);}
  for(const history of [async()=>{throw Error('offline')},async()=>({result:{ok:false}}),()=>new Promise(()=>{})]){
    const cache=new ReferenceReuse({timeoutMs:5});await seed(cache);
    assert.equal((await cache.prepare({...args,history})).savedChars,0);
  }
});

test('an open waiting turn does not hide a surface message, old compaction before the full reference is harmless',async()=>{
  for(const events of [entries().slice(0,2),[{event:{type:'compaction/end',seq:0}},...entries()]]){
    const cache=new ReferenceReuse();await seed(cache);
    assert.ok((await cache.prepare({...args,history:async()=>response(events)})).savedChars>0);
  }
});

test('reset while history is pending and overlapping dispatch invalidate receipts',async()=>{
  const cache=new ReferenceReuse();await seed(cache);
  let resolve;const pending=cache.prepare({...args,history:()=>new Promise(r=>{resolve=r})});
  await Promise.resolve();cache.observe('s',{type:'compaction/start'});resolve(response(entries()));
  const p=await pending;assert.equal(p.savedChars,0);p.commit(true);
  assert.equal(cache.sessions.size,0);
  await seed(cache);
  const first=await cache.prepare(args);const second=await cache.prepare(args);
  assert.equal(second.savedChars,0);first.commit(true);second.commit(true);assert.equal(cache.sessions.size,0);
});

test('failed or unknown dispatch clears receipt, absent reference removes stale cache, bounded sessions',async()=>{
  const cache=new ReferenceReuse({maxSessions:2});await seed(cache);
  (await cache.prepare(args)).commit(false);assert.equal(cache.sessions.size,0);
  await seed(cache);(await cache.prepare({...args,blocks:[]})).commit(true);
  assert.equal((await cache.prepare(args)).savedChars,0);
  cache.clear();for(const sessionId of ['a','b','c'])(await cache.prepare({...args,sessionId})).commit(true);
  assert.equal(cache.sessions.size,2);assert.ok(!cache.sessions.has('a'));
});

test('real dispatch performs local read only, preserves send and attribution, rejects command receipts',async()=>{
  const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
  const start=source.indexOf('  async function dispatchTracedPrompt('),end=source.indexOf('  function traceRow(',start);
  const sent=[];let reads=0, command=false;
  const cache=new ReferenceReuse();
  const context=vm.createContext({cfg:{},referenceReuse:cache,reverse:new Map([['s','private:1']]),
    log:()=>{},turnTraces:new TurnTraces(()=>{}),api:{sessions:{
      history:async()=>{reads++;return response(entries(sent[0].content));},
      prompt:async p=>{sent.push(p);return {result:{ok:true,value:command?{command:{text:'done'}}:{accepted:true}}};}
    }}});
  const dispatch=vm.runInContext(source.slice(start,end)+';dispatchTracedPrompt',context);
  await dispatch({sessionId:'s',content},{referenceBlocks:blocks});assert.equal(reads,0);
  for(const {event} of entries(sent[0].content))cache.observe('s',event);
  await dispatch({sessionId:'s',content},{referenceBlocks:blocks});assert.equal(reads,0);
  assert.ok(sent[1].content[0].text.length<sent[0].content[0].text.length);
  command=true;await dispatch({sessionId:'s',content},{referenceBlocks:blocks});assert.equal(cache.sessions.size,0);
});
