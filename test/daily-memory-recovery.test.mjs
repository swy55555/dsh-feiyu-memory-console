import test from 'node:test';
import assert from 'node:assert/strict';
const source='../bridge/daily-memory.js';
const {DailyMemory,parseMemoryBatch}=await import(source);
test('An unrelated failed batch must not release another batch before its backoff expires',async()=>{
 const base=Date.parse('2023-05-08T13:56:00+08:00');let at=base;
 const oldNow=Date.now;Date.now=()=>at;
 const calls=[];
 const daily=new DailyMemory({load:()=>null,save:()=>{},log:()=>{},allowed:()=>true,enabled:()=>true,
  batchSize:24,groupMaxCallsPerDay:0,maxCallsPerDay:0,
  request:async()=>({results:[]}),extract:async prompt=>{
   calls.push({at:at-base,ids:[...prompt.matchAll(/"id":"(m\d+)"/g)].map(m=>m[1])});
   throw Error('Controlled invalid model response');
  }});
 clearInterval(daily.timer);
 try{
  for(let i=0;i<48;i++)daily.feed('group:99999999',{id:'m'+i,userId:'111',sender:'Test',text:'My hobby is painting.',time:base});
  for(const t of [0,15000,31000,46000]){at=base+t;await daily.flush();}
  const batchB=calls.filter(c=>c.ids.includes('m24'));
  assert.equal(batchB[0].at,15000);
  assert.equal(batchB.filter(c=>c.at<75000).length,1,'Batch B was retried before its 60-second backoff expired');
  assert.equal(daily.state.queues['group:99999999'].length,48,'Failures must not drop originals');
  // A newer, independent batch remains eligible while older failures are held.
  for(let i=48;i<72;i++)daily.feed('group:99999999',{id:'m'+i,userId:'111',sender:'Test',text:'I also enjoy drawing.',time:at});
  at=base+60000;await daily.flush();
  assert.ok(calls.at(-1).ids.includes('m48'));
  assert.ok(!calls.at(-1).ids.includes('m0'));
 }finally{Date.now=oldNow;clearInterval(daily.timer);daily.flushSave();}
});
test('Oversize extraction is distinguished from a missing completion receipt and never truncated',()=>{
 assert.throws(()=>parseMemoryBatch(JSON.stringify({items:Array.from({length:13},()=>({})),completed_source_ids:[]}),[]),
  e=>e.code==='MEMORY_BATCH_TOO_LARGE'&&e.message.includes('13'));
 assert.throws(()=>parseMemoryBatch('{"items":[]}',[]),/完整处理回执/);
});
test('Oversize extraction shrinks later batches, survives reload, and only completes verified originals',async()=>{
 const base=Date.parse('2023-05-08T13:56:00+08:00');let at=base,persisted;
 const oldNow=Date.now;Date.now=()=>at;
 const sizes=[],key='group:99999999';
 const config={load:()=>persisted?structuredClone(persisted):null,save:s=>{persisted=structuredClone(s);},log:()=>{},allowed:()=>true,enabled:()=>true,
  batchSize:8,groupMaxCallsPerDay:0,maxCallsPerDay:0,request:async()=>({results:[]}),
  extract:async prompt=>{const ids=[...prompt.matchAll(/"id":"(m\d+)"/g)].map(m=>m[1]);sizes.push(ids.length);
   return JSON.stringify({items:ids.length>2?Array.from({length:13},()=>({})):[],completed_source_ids:ids});},
  verify:async(_prompt,messages)=>JSON.stringify({checks:messages.map(m=>({source_id:m.id,status:'complete',missing_quotes:[],reason:'No durable facts'}))})};
 let daily=new DailyMemory(config);clearInterval(daily.timer);
 try{
  for(let i=0;i<8;i++)daily.feed(key,{id:'m'+i,userId:'111',sender:'Test',text:'Hello there.',time:base});
  assert.equal((await daily.flush(key)).ok,false);assert.equal(daily.state.queues[key].length,8);
  at=base+31000;assert.equal((await daily.flush(key)).ok,false);assert.equal(daily.state.queues[key].length,8);
  daily.flushSave();daily=new DailyMemory(config);clearInterval(daily.timer);
  for(const t of [92000,108000,124000,140000]){at=base+t;assert.equal((await daily.flush(key)).ok,true);}
  assert.deepEqual(sizes,[8,4,2,2,2,2]);assert.equal(daily.state.queues[key],undefined);
 }finally{Date.now=oldNow;clearInterval(daily.timer);daily.flushSave();}
});
