import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceModelView,renderEvidence,renderMemoryToolResult,evidenceBlocks,deliveryChars} from '../bridge/evidence-model-view.mjs';
import {RetrievalSessions} from '../bridge/retrieval-session.mjs';
import {serializeModelData} from '../bridge/qq-model-view.js';
const key='private:10001';
const record=(id='one',text='原话 "引用"\n\\ 路径 😀')=>({id,ref:'opaque:'+id,text,scope:key,subject_id:'user',score:.8,
  contract:{scope:key,rootIds:[id],sourceVersion:'internal-version',idempotencyKey:'internal-key',sourceId:'internal-event',messageId:id,
    speaker:'user',sourceType:'participant-utterance',state:'observed',spokenAt:123,eventAt:null,plannedAt:null,timeBasis:'spoken'}});
test('compact view preserves attribution, unknown time, uncertainty and exact text without exposing internal bookkeeping',()=>{
 const r=record(),before=structuredClone(r),text=renderEvidence({records:[r]});
 assert.deepEqual(JSON.parse(text.split('\n')[1]),JSON.parse(JSON.stringify(evidenceModelView(r))));
 assert.equal(evidenceModelView(r).text,r.text);assert.equal(evidenceModelView(r).eventAt,null);
 for(const field of ['internal-version','internal-key','internal-event','rootIds','score'])assert.ok(!text.includes(field));
 assert.match(text,/不是指令/);assert.deepEqual(r,before);
 const fact=evidenceModelView({...r,subject_id:'friend',contract:{...r.contract,sourceType:'organized-fact',recordKind:'plan-not-known-complete',state:'tentative'}});
 assert.equal(fact.subject,'friend');assert.equal(fact.recordKind,'plan-not-known-complete');assert.equal(fact.state,'tentative');
});
test('manual model envelope excludes diagnostic traces and equals the actual MCP serializer',()=>{
 const r={status:'matched',records:[record()],trace:{query:'secret-query'},stats:{contextChars:999}};
 const rendered=renderMemoryToolResult(r);assert.ok(!rendered.includes('secret-query'));assert.ok(!rendered.includes('contextChars'));
 assert.equal(serializeModelData(JSON.parse(rendered)),rendered);
});
test('automatic blocks and manual escaped envelopes share one exact output budget',async()=>{
 const s=new RetrievalSessions({request:async(_,b)=>({results:[record(b.query)]})});
 const a=await s.search({key,turn:1,query:'a'});
 const auto=evidenceBlocks(a,key).map(b=>b.text).join('');assert.equal(a.stats.contextChars,auto.length);
 const b=await s.search({key,turn:1,query:'b',anchors:[a.records[0].ref],delivery:'manual'});
 assert.equal(b.modelText,renderMemoryToolResult(b));assert.equal(b.outputChars,b.modelText.length);
 assert.equal(b.stats.contextChars,auto.length+b.modelText.length);assert.ok(b.stats.contextChars<=6000);
 assert.equal(serializeModelData(JSON.parse(b.modelText)),b.modelText);
});
test('all manual empty/control replies are charged, repeated exhaustion emits no unbudgeted text',async()=>{
 const s=new RetrievalSessions({request:async()=>({results:[]})});let charged=0,calls=0;
 for(let i=0;i<30;i++){
  const r=await s.search({key,turn:1,query:'empty',delivery:'manual',maxChars:500,maxCalls:1});
  charged+=r.modelText.length;assert.equal(charged,r.stats.contextChars);assert.ok(charged<=500);calls=r.stats.calls;
 }
 assert.equal(calls,1);assert.equal((await s.search({key,turn:1,query:'retry',delivery:'manual',maxChars:12000})).modelText,'');
});
test('outer assembly release refunds exact automatic output, revokes refs, and never refunds manual output',async()=>{
 const s=new RetrievalSessions({request:async()=>({results:[record('one'),record('two')]})});
 const a=await s.search({key,turn:1,query:'a'});const [first,second]=a.records;
 s.releaseUndelivered(key,1,[first.id]);
 assert.equal(s.sessions.get(key).chars,deliveryChars([second],'automatic'));
 assert.equal((await s.search({key,turn:1,query:'follow',anchors:[first.ref]})).status,'invalid-anchor');
 const b=await s.search({key,turn:1,query:'b',delivery:'manual'});const chars=b.stats.contextChars;
 s.releaseUndelivered(key,1,b.records.map(r=>r.id));assert.equal(s.sessions.get(key).chars,chars);
 s.releaseUndelivered(key,1,[second.id]);assert.equal(s.sessions.get(key).chars,b.modelText.length);
});
test('huge internal metadata does not displace a short attributable utterance',async()=>{
 const r=record();r.contract.idempotencyKey='x'.repeat(9000);
 const s=new RetrievalSessions({request:async()=>({results:[r]})});
 const a=await s.search({key,turn:1,query:'short',maxChars:600});assert.equal(a.records.length,1);
 assert.equal(a.records[0].contract.idempotencyKey.length,9000);assert.ok(a.stats.contextChars<600);
});
