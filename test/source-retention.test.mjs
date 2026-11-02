import test from 'node:test';import assert from 'node:assert/strict';
import {sourceOwners,SourceRetention} from '../bridge/source-retention.mjs';
const ref={id:'event-a',quote:'周末喝咖啡'},scope='private:1';
const snapshot=()=>sourceOwners(scope,{self:{version:1,claims:[{id:'c',evidence:[ref]}],history:[]},continuity:{version:1,chats:[[scope,{concerns:[{id:'c',evidence:[ref]}],beliefs:[]}],['private:2',{concerns:[{id:'secret',evidence:[{id:'s',quote:'PRIVATE'}]}]}]]}});
test('registry separates scopes and owner kinds; malformed states cannot become empty success',()=>{
 const s=snapshot();assert.equal(s.owners.length,2);assert.doesNotMatch(JSON.stringify(s),/PRIVATE|secret/);
 assert.ok(s.owners.every(o=>o.refs[0].subject==='1'&&o.refs[0].namespace==='event'));
 assert.throws(()=>sourceOwners(scope,{self:{version:2,claims:[]}}));
 assert.throws(()=>sourceOwners('group:1',{}));
 assert.deepEqual(sourceOwners(scope,{}).completeKinds,[]);
});
test('same snapshot reuses successful retention; restart keeps receipts; no model API exists',async()=>{
 let saved,calls=0;const opts={snapshot,save:s=>saved=s,request:async(_p,b)=>{calls++;return {ok:true,matched:b.owners[0].refs.length,unavailable:0,mismatch:0};}};
 const first=new SourceRetention(opts);assert.equal((await first.tick()).matched,2);
 assert.equal((await first.tick()).skipped,true);
 assert.equal((await new SourceRetention({...opts,load:()=>saved}).tick()).skipped,true);assert.equal(calls,2);
 assert.equal(saved.scopes[scope].result.modelCalls,0);
});
test('missing file never releases that kind; complete empty state retires only known absent owners',async()=>{
 let state=snapshot(),saved,calls=[];
 const worker=new SourceRetention({snapshot:()=>state,save:s=>saved=s,request:async(_p,b)=>{calls.push(b);return {ok:true,matched:b.owners[0].refs.length,unavailable:0,mismatch:0};}});
 await worker.tick();state=sourceOwners(scope,{});await worker.tick();assert.equal(calls.length,2);
 state=sourceOwners(scope,{self:{version:1,claims:[]}});await worker.tick();
 assert.equal(calls.at(-1).owners[0].release,true);assert.equal(calls.at(-1).owners[0].kind,'self-reference');
 assert.equal(saved.scopes[scope].known.length,1);
});
test('state change during registration prevents retirement; unavailable originals retry locally',async()=>{
 let now=0,changed=false,calls=0;const worker=new SourceRetention({now:()=>now,snapshot:()=>changed?sourceOwners(scope,{self:{version:1,claims:[]}}):snapshot(),request:async()=>{calls++;changed=true;return {ok:true,matched:0,unavailable:1,mismatch:0};}});
 assert.equal((await worker.tick()).changedDuringSync,true);
 assert.equal(calls,2);
 changed=false;
 const retry=new SourceRetention({now:()=>now,snapshot,request:async(_p,b)=>({ok:true,matched:0,unavailable:b.owners[0].refs.length,mismatch:0})});
 assert.equal((await retry.tick()).unavailable,2);assert.equal((await retry.tick()).skipped,true);
 now=600001;assert.equal((await retry.tick()).unavailable,2);
});
test('large evidence sets are chunked below local HTTP limit',async()=>{
 const refs=Array.from({length:96},(_,i)=>({namespace:'event',id:String(i),subject:'1',quote:'字'.repeat(2000)}));let requests=0;
 const s={scope,owners:[{kind:'belief',id:'b',refs}],completeKinds:['belief']};
 const worker=new SourceRetention({snapshot:()=>s,request:async(_p,b)=>{assert.ok(Buffer.byteLength(JSON.stringify(b))<65536);requests++;return {ok:true,matched:b.owners[0].refs.length,unavailable:0,mismatch:0};}});
 assert.equal((await worker.tick()).matched,96);assert.ok(requests>1);
});
test('invalid receipt does not crash bridge construction or authorize writes',async()=>{
 const worker=new SourceRetention({snapshot,load:()=>({version:99}),save:()=>assert.fail('must not replace invalid receipt'),request:()=>assert.fail('must not write sources')});
 await assert.rejects(()=>worker.tick(),/invalid source-retention receipt/);
});
test('unknown acknowledgement is not cached as a successful retention',async()=>{
 let calls=0,now=0;const worker=new SourceRetention({snapshot,now:()=>now,request:async()=>{calls++;return {ok:true};}});
 await assert.rejects(()=>worker.tick(),/rejected/);now=61000;await assert.rejects(()=>worker.tick(),/rejected/);assert.equal(calls,2);
});
