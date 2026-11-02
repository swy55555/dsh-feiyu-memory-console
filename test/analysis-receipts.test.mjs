import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AnalysisReceipts} from '../bridge/analysis-receipts.mjs';
import {DailyMemory} from '../bridge/daily-memory.js';
const key='private:1',ctx={key,prompt:'完整原话',sourceRevision:'v1'},model={model:'m',effort:'low'};
function fixture(t,options={}){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'analysis-receipts-')),file=path.join(dir,'receipts.db'),opened=[];
 const open=()=>{const x=new AnalysisReceipts({file,...options});opened.push(x);return x};
 t.after(()=>{for(const x of opened)try{x.close()}catch{}fs.rmSync(dir,{recursive:true,force:true})});return {open,file};}
test('successful validated results survive restart, concurrent calls share work, expiry does not slide',async t=>{
 let now=0,calls=0;const f=fixture(t,{now:()=>now,ttlMs:100}),a=f.open(),run=async()=>{calls++;return {answer:'正确'}};
 await Promise.all([a.get('extract',ctx,model,run),a.get('extract',ctx,model,run)]);assert.equal(calls,1);
 const b=f.open();now=70;await b.get('extract',ctx,model,run);assert.equal(calls,1);
 now=101;await b.get('extract',ctx,model,run);assert.equal(calls,2);
});
test('scope, original, evidence version, purpose and model changes each invalidate reuse',async t=>{
 const cache=fixture(t).open();let calls=0;const run=async()=>++calls;
 await cache.get('extract',ctx,model,run);
 for(const other of [{...ctx,key:'group:1'},{...ctx,prompt:'纠正后的原话'},{...ctx,sourceRevision:'v2'}])await cache.get('extract',other,model,run);
 await cache.get('coverage',ctx,model,run);await cache.get('extract',ctx,{...model,effort:'high'},run);assert.equal(calls,6);
});
test('unknown outcomes and interrupted receipts do not silently resubmit after restart; manual retry is explicit',async t=>{
 const f=fixture(t),a=f.open();let calls=0;
 await assert.rejects(a.get('extract',ctx,model,async()=>{calls++;throw Error('connection lost')}),{code:'ANALYSIS_OUTCOME_UNKNOWN'});
 const b=f.open();await assert.rejects(b.get('extract',ctx,model,async()=>{calls++;return 1}),{code:'ANALYSIS_OUTCOME_UNKNOWN'});assert.equal(calls,1);
 assert.equal(await b.get('extract',ctx,model,async()=>{calls++;return 1},()=>true,{retryUnknown:true}),1);assert.equal(calls,2);
 let release;const running=a.get('coverage',ctx,model,()=>new Promise(r=>release=r));
 await assert.rejects(b.get('coverage',ctx,model,async()=>{calls++;return 1}),{code:'ANALYSIS_OUTCOME_UNKNOWN'});release(1);await running;
});
test('uncertain/invalid output cannot be success; cached values are revalidated; receipts keep no prompt text',async t=>{
 const cache=fixture(t).open();let calls=0;const run=async()=>({x:++calls});
 await cache.get('extract',ctx,model,run,()=>false);await cache.get('extract',ctx,model,run);assert.equal(calls,2);
 await cache.get('extract',ctx,model,run,()=>true,{validate:v=>v.x>2});assert.equal(calls,3);
 const rows=cache.db.prepare('SELECT * FROM receipts').all();assert.equal(JSON.stringify(rows).includes(ctx.prompt),false);
});
test('actual extraction and independent coverage reuse across queue restart after storage failure',async t=>{
 const f=fixture(t);let stored,extracts=0,checks=0,writes=0;
 const message={id:'m1',userId:'1',text:'我不喜欢煎饼，我喜欢小笼包。',time:Date.now()-120000};
 const item={source_id:'m1',quote:message.text,kind:'preference',confidence:.99,assessment:{subject:'self',mode:'asserted',sensitive:false},relation:'independent',relation_confidence:.99};
 const create=()=>{const d=new DailyMemory({analysisMemo:f.open(),load:()=>stored||{queues:{[key]:[message]}},save:s=>{stored=structuredClone(s)},allowed:()=>true,enabled:()=>true,log:()=>{},sourceRevision:()=> 'v1',modelSignature:()=>model,
  extract:async()=>{extracts++;return JSON.stringify({items:[item],completed_source_ids:['m1']})},
  verify:async()=>{checks++;return JSON.stringify({checks:[{source_id:'m1',status:'complete',missing_quotes:[],reason:'完整'}]})},
  request:async(route)=>{if(route==='/related')return {results:[]};if(++writes===1)throw Error('DB unavailable');return {ok:true,memory:{id:'saved',status:'active'}}}});
  t.after(()=>{clearInterval(d.timer);clearTimeout(d.saveTimer)});return d;};
 const a=create();assert.equal((await a.flush(key)).ok,false);const b=create();assert.equal((await b.flush(key,{force:true})).ok,true);
 assert.deepEqual({extracts,checks,writes},{extracts:1,checks:1,writes:2});assert.equal(b.state.queues[key],undefined);
});
test('unknown original is held across reload while fresh messages continue without repeated calls',async t=>{
 const f=fixture(t);let stored,calls=0;
 const old={id:'old',userId:'1',text:'我喜欢小笼包。',time:Date.now()-120000};
 const create=()=>{const d=new DailyMemory({analysisMemo:f.open(),load:()=>stored||{queues:{[key]:[old]}},save:s=>stored=structuredClone(s),allowed:()=>true,enabled:()=>true,log:()=>{},
  extract:async prompt=>{calls++;if(prompt.includes('我喜欢小笼包'))throw Error('network lost');return JSON.stringify({items:[],completed_source_ids:['new']});},
  verify:async()=>JSON.stringify({checks:[{source_id:'new',status:'complete',missing_quotes:[],reason:'寒暄无需存储'}]}),request:async()=>({results:[]})});
 t.after(()=>{clearInterval(d.timer);clearTimeout(d.saveTimer)});return d;};
 const a=create();await a.flush(key);assert.equal(calls,1);
 const b=create();await b.flush();assert.equal(calls,1);
 b.state.queues[key].push({id:'new',userId:'1',text:'早上好。',time:Date.now()-120000});
 assert.equal((await b.flush()).ok,true);assert.equal(calls,2);assert.deepEqual(b.state.queues[key].map(x=>x.id),['old']);
 await b.flush();assert.equal(calls,2);assert.deepEqual(b.state.retries[key].outcomeUnknownIds,['old']);
});
test('known invalid model response permits bounded retry and does not pretend it is a success',async t=>{
 const cache=fixture(t).open();let calls=0;
 const run=async()=>{calls++;if(calls===1)throw Object.assign(Error('invalid structured output'),{outcomeKnown:true});return 'valid';};
 await assert.rejects(cache.get('extract',ctx,model,run),/invalid structured/);
 assert.equal(await cache.get('extract',ctx,model,run),'valid');assert.equal(calls,2);
});
