import test from 'node:test';
import assert from 'node:assert/strict';
import { DailyMemory, memoryCandidates, parseMemoryBatch, memoryAdmission } from '../bridge/daily-memory.js';
import {parseCoverage} from '../bridge/memory-coverage.mjs';

const key = 'private:123';
const message = (id='m1',text='他说他喜欢咖啡，但我喜欢喝豆浆。') => ({id,userId:'123',text,time:Date.now()-100000});
const item = (m,quote='我喜欢喝豆浆',extra={}) => ({source_id:String(m.id),quote,kind:'preference',confidence:.99,assessment:{subject:'self',mode:'asserted',sensitive:false},relation:'independent',relation_confidence:.99,...extra});
const response = (items=[],completed=['m1']) => JSON.stringify({items,completed_source_ids:completed});
function fixture(t,{messages=[message()],extract=async()=>response(),verify=async(_prompt,messages)=>JSON.stringify({checks:messages.map(m=>({source_id:String(m.id),status:'complete',missing_quotes:[],reason:'未发现遗漏'}))}),state,request,save}={}) {
  const writes=[], prompts=[];
  let persisted;
  const d=new DailyMemory({load:()=>state||{queues:{[key]:messages}},save:s=>{persisted=structuredClone(s);save?.(s);},extract:async p=>{prompts.push(p);return extract(p);},request:async(route,body)=>{
    if(route==='/related')return {results:[]};
    if(request)return request(route,body);
    writes.push(body);return {ok:true,memory:{id:`stored-${writes.length}`}};
  },verify,allowed:()=>true,enabled:()=>true,log:()=>{},autoConfirmFor:()=>true});
  t.after(()=>{clearInterval(d.timer);if(d.saveTimer)clearTimeout(d.saveTimer);});
  return {d,writes,prompts,snapshot:()=>persisted};
}

test('unchanged extraction and independent coverage survive a transient storage failure without new model calls',async t=>{
  const m=message();let extracts=0,checks=0,writes=0;
  const {d}=fixture(t,{messages:[m],extract:async()=>{extracts++;return response([item(m)])},
    verify:async()=>{checks++;return JSON.stringify({checks:[{source_id:'m1',status:'complete',missing_quotes:[],reason:'完整'}]})},
    request:async()=>{writes++;if(writes===1)throw Error('storage temporarily offline');return {ok:true,memory:{id:'saved'}}}});
  assert.equal((await d.flush(key)).ok,false);
  assert.equal((await d.flush(key,{force:true})).ok,true);
  assert.deepEqual({extracts,checks,writes},{extracts:1,checks:1,writes:2});
  assert.equal(d.state.queues[key],undefined);
});

test('failed coverage reuses extraction but runs coverage again; uncertain verdicts are never retained',async t=>{
  let extracts=0,checks=0;
  const {d}=fixture(t,{extract:async()=>{extracts++;return response()},verify:async()=>{
    checks++;if(checks===1)throw Error('review unavailable');
    return JSON.stringify({checks:[{source_id:'m1',status:checks===2?'uncertain':'complete',missing_quotes:[],reason:'核对'}]});
  }});
  await d.flush(key);await d.flush(key,{force:true});
  assert.equal(d.state.queues[key].length,1);
  assert.equal((await d.flush(key,{force:true})).ok,true);
  assert.deepEqual({extracts,checks},{extracts:1,checks:3});
});

test('retries re-extract after original, related memory, model settings or chat scope changes',async t=>{
  for(const change of ['original','related','model','scope']) {
    const m=message();let extracts=0,related=[],model='low';
    const {d}=fixture(t,{messages:[m],extract:async()=>{extracts++;return response([item(m)])},request:async()=>{throw Error('storage offline')}});
    const request=d.request;d.request=(route,body)=>route==='/related'?Promise.resolve({results:related}):request(route,body);
    d.modelSignature=()=>model;
    await d.flush(key);
    let target=key;
    if(change==='original')m.text+=' 我也喜欢红茶';
    if(change==='related')related=[{id:'old',subject_id:'123',text:'喜欢咖啡',source_time:1}];
    if(change==='model')model='high';
    if(change==='scope'){target='group:456';d.state.queues[target]=[m];}
    await d.flush(target,{force:true});assert.equal(extracts,2,change);
  }
});

test('retry cache expires without extending on reuse and is lost on restart',async t=>{
  const m=message();let calls=0,now=1000;
  const {d,snapshot}=fixture(t,{messages:[m],extract:async()=>{calls++;return response([item(m)])},request:async()=>{throw Error('offline')}});
  d.analysisMemo.now=()=>now;d.analysisMemo.ttlMs=100;
  await d.flush(key);now=1090;await d.flush(key,{force:true});assert.equal(calls,1);
  now=1101;await d.flush(key,{force:true});assert.equal(calls,2);
  const next=fixture(t,{state:snapshot(),extract:async()=>{calls++;return response([item(m)])},request:async()=>{throw Error('offline')}});
  await next.d.flush(key,{force:true});assert.equal(calls,3);
});

test('invalid/truncated JSON and legacy empty arrays never acknowledge queued messages',async t=>{
  for(const output of ['{invalid','{"items":[', '[]','{}','null']) {
    const {d,writes}=fixture(t,{extract:async()=>output});
    assert.equal((await d.flush(key)).ok,false);
    assert.equal(d.state.queues[key].length,1);assert.equal(writes.length,0);
    assert.equal(d.state.okCalls,0);assert.ok(d.state.retries[key].nextAt>Date.now());
  }
});
test('explicit completed empty response is a successful no-memory decision',async t=>{
  const {d,writes}=fixture(t);const result=await d.flush(key);
  assert.equal(result.ok,true);assert.equal(result.messages,1);assert.equal(d.state.queues[key],undefined);assert.equal(writes.length,0);
});
test('all entries validated before writes and completion',async t=>{
  const m=message();const {d,writes}=fixture(t,{extract:async()=>response([item(m),{...item(m),quote:'原文里不存在'}])});
  assert.equal((await d.flush(key)).ok,false);assert.equal(writes.length,0);assert.equal(d.state.queues[key].length,1);
});
test('invalid completion ids and missing assessments are retryable',async t=>{
  assert.throws(()=>parseMemoryBatch(response([],['unknown']),[message()]));
  assert.throws(()=>parseMemoryBatch(response([],['m1','m1']),[message()]));
  const m=message();const {d}=fixture(t,{extract:async()=>response([item(m,undefined,{assessment:undefined})])});
  assert.equal((await d.flush(key)).ok,false);assert.equal(d.state.queues[key].length,1);
});
test('mixed reported speech and quotation punctuation do not discard an asserted self fact',()=>{
  for(const text of ['他说他喜欢咖啡，但我喜欢喝豆浆。','她说“咖啡好喝”，但我喜欢喝豆浆。','假如他来了就请他喝茶，但我喜欢喝豆浆。']) {
    const m=message('m1',text);const rows=memoryCandidates(JSON.stringify([item(m)]),[m],Date.now(),[]);
    assert.equal(rows.length,1);assert.equal(rows[0].confirmed,true);
  }
});
test('third-party, quoted, hypothetical, joke and sensitive spans do not become personal facts',()=>{
  const m=message();
  for(const assessment of [{subject:'other',mode:'asserted',sensitive:false},...['quoted','hypothetical','joke'].map(mode=>({subject:'self',mode,sensitive:false})),{subject:'self',mode:'asserted',sensitive:true}]) {
    assert.deepEqual(memoryCandidates(JSON.stringify([item(m,undefined,{assessment})]),[m],Date.now(),[],{autoConfirm:true}),[]);
  }
});
test('uncertain attribution cannot auto-confirm or auto-replace even for owner',()=>{
  const m=message();const [row]=memoryCandidates(JSON.stringify([item(m,undefined,{assessment:{subject:'uncertain',mode:'uncertain',sensitive:false},relation:'replace',explicit_update:true,update_evidence:'我喜欢喝豆浆'})]),[m],Date.now(),[],{autoConfirm:true});
  assert.equal(row.confirmed,false);assert.equal(row.relation,'uncertain');
});
test('four facts from separate messages all survive',async t=>{
  const messages=Array.from({length:4},(_,i)=>message(`m${i}`,`我喜欢第${i}种饮料`));
  const {d,writes}=fixture(t,{messages,extract:async()=>response(messages.map(m=>item(m,m.text)),messages.map(m=>m.id))});
  assert.equal((await d.flush(key)).ok,true);assert.equal(writes.length,4);assert.equal(d.state.queues[key],undefined);
});
test('same-message continuation survives restart and skips already processed facts',async t=>{
  const quotes=Array.from({length:15},(_,i)=>`我喜欢第${i}种饮料`);const m=message('m1',quotes.join('，'));
  const first=fixture(t,{messages:[m],extract:async()=>response(quotes.slice(0,12).map(q=>item(m,q)),[])});
  const r=await first.d.flush(key);assert.equal(r.pending,1);assert.equal(first.writes.length,12);
  const second=fixture(t,{state:first.snapshot(),extract:async()=>response([item(m,quotes[0]),...quotes.slice(12).map(q=>item(m,q))])});
  assert.equal((await second.d.flush(key)).ok,true);assert.equal(second.writes.length,3);
  assert.ok(second.prompts[0].includes('previously_processed'));assert.equal(second.d.state.queues[key],undefined);assert.equal(second.d.state.progress[key],undefined);
});
test('partial source acknowledgements retain other input messages',async t=>{
  const messages=[message(),message('m2','我喜欢红茶')];const {d}=fixture(t,{messages});
  await d.flush(key);assert.deepEqual(d.state.queues[key].map(m=>m.id),['m2']);
});
test('storage failure preserves queue and checkpoints successful writes for retry',async t=>{
  const m=message('m1','我喜欢喝豆浆，我喜欢红茶');let calls=0;
  const rows=[item(m),item(m,'我喜欢红茶')];
  const {d}=fixture(t,{messages:[m],extract:async()=>response(rows),request:async()=>{calls++;if(calls===2)return {ok:false};return {ok:true,memory:{id:'stored'}};}});
  assert.equal((await d.flush(key)).ok,false);assert.equal(d.state.queues[key].length,1);assert.deepEqual(d.state.progress[key].m1,['我喜欢喝豆浆']);
  assert.equal((await d.flush(key,{force:true})).ok,true);assert.equal(calls,3);assert.equal(d.state.queues[key],undefined);
});
test('failure backs off but allows explicit retry; no-progress response cannot clear queue',async t=>{
  let calls=0;const {d}=fixture(t,{extract:async()=>{calls++;return response([],[]);}});
  assert.equal((await d.flush(key)).ok,false);assert.equal((await d.flush(key)).reason,'retry-backoff');assert.equal(calls,1);
  await d.flush(key,{force:true});assert.equal(calls,2);assert.equal(d.state.queues[key].length,1);
});
test('a backing-off chat does not starve another chat',async t=>{
  const second='private:456';const {d}=fixture(t,{state:{queues:{[key]:[message()],[second]:[message('m2','我喜欢红茶')]},retries:{[key]:{nextAt:Date.now()+60000}}},extract:async()=>response([],['m2'])});
  const result=await d.flush();assert.equal(result.scope,second);assert.equal(d.state.queues[key].length,1);
});
test('oversized pending messages do not starve another chat',async t=>{
  const second='private:456';const {d}=fixture(t,{state:{queues:{[key]:[message('long','长'.repeat(12001))],[second]:[message('m2','我喜欢红茶')]}},extract:async()=>response([],['m2'])});
  const result=await d.flush();assert.equal(result.scope,second);assert.equal(d.state.queues[key].length,1);
});

test('queue persistence error does not leave the worker permanently busy',async t=>{
  const {d}=fixture(t,{save:()=>{throw Error('disk unavailable');}});
  assert.equal((await d.flush(key)).ok,false);assert.equal(d.busy,false);assert.equal(d.state.queues[key].length,1);
});

test('admission has no content vocabulary gate and preserves participation boundaries',()=>{
  const text='每天不泡一壶，总感觉少点什么';
  assert.equal(memoryAdmission('private:456',text).queue,true);
  assert.equal(memoryAdmission('group:1',text,{directedAtSelf:true}).queue,true);
  assert.equal(memoryAdmission('group:1',text).queue,false);
  assert.equal(memoryAdmission('group:1',text,{policy:'semantic'}).queue,true);
  assert.equal(memoryAdmission('group:1',text,{policy:'off',directedAtSelf:true}).queue,false);
  assert.equal(memoryAdmission('private:456',text,{enabled:false}).queue,false);
});
test('independent coverage catches missing facts and resumes with exact hints',async t=>{
  const m=message('m1','我喜欢喝豆浆。我习惯晨跑。');let round=0;
  const {d,writes,prompts}=fixture(t,{messages:[m],extract:async()=>response([item(m,round?'我习惯晨跑':'我喜欢喝豆浆')]),verify:async()=>JSON.stringify({checks:[{source_id:'m1',status:round++?'complete':'missing',missing_quotes:round===1?['我习惯晨跑']:[],reason:'对照原话'}]})});
  const first=await d.flush(key);assert.equal(first.pending,1);assert.equal(d.state.processing[0].status,'partial');
  assert.deepEqual(d.state.coverageHints[key].m1,['我习惯晨跑']);
  await d.flush(key,{force:true});assert.equal(writes.length,2);assert.equal(d.state.queues[key],undefined);
  assert.ok(prompts[1].includes('missing_quotes'));assert.equal(d.state.processing[0].coverage,'complete');
});
test('failed or incomplete coverage never acknowledges a completed extraction',async t=>{
  for(const output of ['bad json','{"checks":[]}']) {
    const {d,writes}=fixture(t,{extract:async()=>response([item(message())]),verify:async()=>output});
    assert.equal((await d.flush(key)).ok,false);assert.equal(d.state.queues[key].length,1);assert.equal(writes.length,0);
    assert.equal(d.state.processing[0].status,'retrying');
  }
});
test('uncertain coverage retains message and prevents auto confirmation',async t=>{
  const {d,writes}=fixture(t,{extract:async()=>response([item(message())]),verify:async()=>JSON.stringify({checks:[{source_id:'m1',status:'uncertain',missing_quotes:[],reason:'归属需核对'}]})});
  await d.flush(key);assert.equal(d.state.queues[key].length,1);assert.equal(writes[0].confirmed,false);assert.equal(writes[0].relation,'uncertain');assert.equal(d.state.processing[0].status,'review-needed');
});

test('unchanged uncertainty backs off across reload, changed model resets delay and no facts are acknowledged',async t=>{
 const {d}=fixture(t,{verify:async()=>JSON.stringify({checks:[{source_id:'m1',status:'uncertain',missing_quotes:[],reason:'尚不确定'}]})});
 await d.flush(key);assert.equal(d.state.retries[key].uncertainAttempts,1);
 assert.equal((await d.flush(key)).reason,'retry-backoff');
 await d.flush(key,{force:true});assert.equal(d.state.retries[key].uncertainAttempts,2);
 const {d:loaded}=fixture(t,{state:structuredClone(d.state),verify:d.verify});
 await loaded.flush(key,{force:true});assert.equal(loaded.state.retries[key].uncertainAttempts,3);assert.ok(loaded.state.retries[key].nextAt-Date.now()>470000);
 loaded.modelSignature=()=>({model:'different'});await loaded.flush(key,{force:true});assert.equal(loaded.state.retries[key].uncertainAttempts,1);
   assert.ok(loaded.state.retries[key].nextAt-Date.now()<=120000);
 assert.equal(loaded.state.queues[key].length,1);assert.equal(loaded.state.processing[0].status,'review-needed');
});

test('uncertain old messages wait without blocking fresh messages or losing the old retry state',async t=>{
 const {d}=fixture(t,{extract:async(_p)=>response([],d.state.queues[key].filter(m=>m.id!=='m1'||!d.state.retries[key]).map(m=>m.id)),
  verify:async(_p,msgs)=>JSON.stringify({checks:msgs.map(m=>({source_id:m.id,status:m.id==='m1'?'uncertain':'complete',missing_quotes:[],reason:'核对'}))})});
 await d.flush(key);const nextAt=d.state.retries[key].nextAt;
 d.feed(key,message('m2','我今天看了一场电影。'));await d.flush(key);
 assert.deepEqual(d.state.queues[key].map(m=>m.id),['m1']);assert.equal(d.state.retries[key].nextAt,nextAt);
 assert.equal(d.state.processing.find(r=>r.id==='m2').status,'checked');assert.equal((await d.flush(key)).reason,'retry-backoff');
});
test('coverage rejects invented evidence, duplicate ids and contradictory completion',()=>{
  for(const checks of [[{source_id:'m1',status:'missing',missing_quotes:['编造'],reason:''}], [{source_id:'m1',status:'complete',missing_quotes:['我喜欢喝豆浆'],reason:''}]]) assert.throws(()=>parseCoverage(JSON.stringify({checks}),[message()]));
});
test('status distinguishes checked chatter from stored candidates and survives reload',async t=>{
  const checked=fixture(t);await checked.d.flush(key);assert.equal(checked.snapshot().processing[0].status,'checked');
  const extracted=fixture(t,{extract:async()=>response([item(message())])});await extracted.d.flush(key);assert.equal(extracted.snapshot().processing[0].status,'pending-confirmation');
  const loaded=fixture(t,{state:extracted.snapshot()});assert.equal(loaded.d.state.processing[0].evidence[0].memories.length,1);
});
