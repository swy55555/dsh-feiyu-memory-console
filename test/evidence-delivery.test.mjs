import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceModelView,renderEvidence,renderMemoryToolResult,evidenceBlocks,deliveryChars} from '../bridge/evidence-model-view.mjs';
import {RetrievalSessions} from '../bridge/retrieval-session.mjs';
import {assembleReferences} from '../bridge/reference-assembly.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
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
const pair=(a='q',b='a',size=40)=>[record(a,'What food do you like?'),record(b,'Meat. '+ 'x'.repeat(size))].map(r=>({...r,retrieval:{contextVersions:[a,b]}}));
test('new group fits as a whole or contributes no records, including item limits',async()=>{
 for(const options of [{maxItems:1},{maxChars:500}]){
  const s=new RetrievalSessions({request:async()=>({results:pair('q','a',800)})});
  const r=await s.search({key,turn:1,query:'food',...options});assert.equal(r.records.length,0);
 }
 const s=new RetrievalSessions({request:async()=>({results:pair()})});
 const r=await s.search({key,turn:1,query:'food'});assert.equal(r.records.length,2);
 const blocks=evidenceBlocks(r,key);assert.equal(blocks.length,1);assert.equal(r.stats.contextChars,blocks[0].text.length);
 assert.equal(blocks[0].recordIds.length,2);
});
test('already delivered anchor can be completed once without recharging or duplicating it',async()=>{
 const s=new RetrievalSessions({request:async(_,b)=>({results:b.anchors.length?[pair()[1]]:[record('q')]})});
 const a=await s.search({key,turn:1,query:'first'});
 const b=await s.search({key,turn:1,query:'food',anchors:[a.records[0].ref],delivery:'manual'});
 assert.equal(b.records.length,1);assert.equal(b.records[0].id,'a');assert.deepEqual(b.records[0].contextRefs,[a.records[0].ref]);
 assert.equal(b.stats.records,2);assert.equal(b.stats.contextChars,a.outputChars+b.modelText.length);
});
test('foreign, revoked, missing or malformed companions fail closed for the complete group',async()=>{
 for(const bad of [{scope:'group:2'},{contract:{scope:key,rootIds:['a'],state:'revoked'}}]){
  const rows=pair();rows[1]={...rows[1],...bad};
  const s=new RetrievalSessions({request:async()=>({results:rows})});assert.equal((await s.search({key,turn:1,query:'x'})).records.length,0);
 }
 for(const rows of [[pair()[0]],[{...record(),retrieval:{contextVersions:'bad'}}]]){
  const s=new RetrievalSessions({request:async()=>({results:rows})});assert.equal((await s.search({key,turn:1,query:'x'})).records.length,0);
 }
});
test('overlapping group metadata is treated atomically rather than leaking one pair',async()=>{
 const rows=[...pair('q','a'),{...record('last'),retrieval:{contextVersions:['a','last']}}];
 const s=new RetrievalSessions({request:async()=>({results:rows})});
 assert.equal((await s.search({key,turn:1,query:'x',maxItems:2})).records.length,0);
});
test('outer reference assembly keeps or drops the whole pair and refunds the same unit',async()=>{
 const s=new RetrievalSessions({request:async()=>({results:pair('q','a',1200)})});
 const r=await s.search({key,turn:1,query:'food'});assert.equal(r.records.length,2);
 const blocks=evidenceBlocks(r,key);
 const assembled=assembleReferences({key,budgetChars:2400,blocks:[{id:'required',scope:key,text:'r'.repeat(1600),required:true,priority:100},...blocks]});
 assert.ok(!assembled.text.includes('What food'));assert.ok(!assembled.text.includes('Meat.'));
 // Even a partial release request revokes the entire pending automatic unit.
 s.releaseUndelivered(key,1,[r.records[0].id]);assert.equal(s.sessions.get(key).count,0);assert.equal(s.sessions.get(key).chars,0);
 for(const item of r.records)assert.equal((await s.search({key,turn:1,query:'again',anchors:[item.ref]})).status,'invalid-anchor');
});
test('actual bridge assembly maps grouped blocks back to every record and refunds omitted groups',async()=>{
 const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
 const start=source.indexOf('    const assembled=(parts)=>{'),end=source.indexOf('    const contextEmotionView',start);
 assert.ok(start>0&&end>start);
 for(const keep of [false,true]){
  const sessions=new RetrievalSessions({request:async()=>({results:pair('q','a',1200)})});
  const evidence=await sessions.search({key,turn:1,query:'food'});
  const ctx=vm.createContext({key,context:{},cfg:{socialV2:{context:{referenceBudgetChars:keep?8000:2400}}},
   contextBundle:{messages:[],summaries:[]},initialEvidence:evidence,initialEvidenceSeq:1,deliveredEvidence:[],assemblyReport:null,
   sessionBlock:'',summaryBlock:'',promptText:'CURRENT REQUEST',buildSessionBlock:()=>'',buildSummaryBlock:()=>'',
   evidenceBlocks,assembleReferences,retrievalSessions:sessions});
  const output=vm.runInContext(source.slice(start,end)+";assembled([{id:'required',text:'r'.repeat(1600),required:true,priority:100}])",ctx);
  assert.ok(output.endsWith('CURRENT REQUEST'));assert.equal(ctx.deliveredEvidence.length,keep?2:0);
  assert.equal(sessions.sessions.get(key).count,keep?2:0);
  assert.equal(sessions.sessions.get(key).chars,keep?evidence.outputChars:0);
 }
});
test('actual MCP handler forwards the budgeted text verbatim and uses no extra wrapper',async()=>{
 const source=fs.readFileSync(new URL('../bridge/mcp-snowluma-safe.js',import.meta.url),'utf8');
 const start=source.indexOf('      const params=new URLSearchParams({key,query});');
 const end=source.indexOf('    } catch (error)',start);assert.ok(start>0&&end>start);
 for(const modelText of ['',renderMemoryToolResult({status:'matched',records:[record()]})]){
  const data={ok:true,memory:{status:'matched'},modelText};
  const ctx=vm.createContext({key,query:'food',anchors:[],token:'synthetic',URLSearchParams,agentApi:async()=>data,serializeModelData});
  const result=await vm.runInContext('(async()=>{'+source.slice(start,end)+'})()',ctx);
  assert.equal(result.content.map(c=>c.text).join(''),modelText);
 }
});
