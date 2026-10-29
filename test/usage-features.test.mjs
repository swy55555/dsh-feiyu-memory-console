import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTokenLedger} from '../bridge/feature-token-ledger.mjs';
import {featureKey} from '../bridge/usage-features.mjs';

function fixture(t, options={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'feiyu-usage-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'usage.jsonl'), at=1793257200123, keys=new Map();
  const ledger=createTokenLedger({file,resolveKey:id=>keys.get(id),now:()=>at,...options});
  const add=(id,key,time=at-1000,tokens=100,seq=1)=>{
    if(key)keys.set(id,key);
    return ledger.ingestEvent({sessionId:id,event:{type:'assistant/message',seq,time,data:{turn:1,step:seq,usage:{inputTokens:tokens,outputTokens:20,reasoningTokens:10}}}});
  };
  return {ledger,add,file,at,keys};
}
test('all feature totals survive conversation pagination and restart; reasoning is not counted twice',t=>{
  const f=fixture(t);
  for(let i=0;i<70;i++) f.add(`chat-${i}`,`private:${i}`,undefined,10000);
  f.add('idle',featureKey('idle_association'));
  f.add('old','internal:可塑性记忆');
  const first=f.ledger.summary({limit:1});
  assert.equal(first.conversations.length,1);
  assert.equal(first.features.length,2);
  assert.equal(first.plugin.totalTokens,240);
  assert.equal(first.features.find(f=>f.key==='internal:可塑性记忆').label,'历史未分项');
  f.keys.clear();f.add('idle',null,f.at,50,2);
  f.ledger.compact();
  const after=createTokenLedger({file:f.file,now:()=>f.at}).summary({limit:1});
  assert.equal(after.plugin.totalTokens,310);
  assert.equal(after.features.find(f=>f.key===featureKey('idle_association')).steps,2);
  assert.equal(after.totals.totalTokens,first.totals.totalTokens+70);
});
test('24h/7d/30d use exact windows and all samples, not the latest 1000 turns',t=>{
  const f=fixture(t), hour=3600000, key=featureKey('coverage_check');
  for(let i=0;i<1205;i++) f.add(`batch-${i}`,key,f.at-23*hour-i);
  f.add('week',key,f.at-6*24*hour);
  f.add('month',key,f.at-29*24*hour);
  f.add('outside',key,f.at-30*24*hour-1);
  f.add('future',key,f.at+1);
  for(const [hours,count] of [[24,1205],[168,1206],[720,1207]]) {
    const s=f.ledger.series({hours,at:f.at,maxBuckets:48});
    assert.equal(s.from,f.at-hours*hour);assert.equal(s.to,f.at);
    assert.equal(s.plugin.steps,count);assert.equal(s.totals.steps,count);
    assert.equal(s.features[0].steps,count);
    assert.equal(s.buckets.reduce((n,b)=>n+b.pluginTokens,0),count*120);
    assert.ok(Math.abs(s.buckets.reduce((n,b)=>n+b.pluginCost,0)-s.plugin.cost)<1e-9);
    assert.ok(s.buckets.length>=29);
  }
});
test('replayed usage stays idempotent; retries stay separately billable',t=>{
  const f=fixture(t);f.add('a',featureKey('emotion_review'));
  f.add('a',featureKey('emotion_review'));
  assert.equal(f.ledger.summary().plugin.totalTokens,120);
  f.ledger.ingestEvent({sessionId:'a',event:{type:'llm/retry-started',seq:2,time:f.at,data:{turn:1,step:1}}});
  f.ledger.ingestEvent({sessionId:'a',event:{type:'assistant/message',seq:3,time:f.at,data:{turn:1,step:1,usage:{inputTokens:100,outputTokens:20}}}});
  assert.equal(f.ledger.summary().plugin.totalTokens,240);
});
test('evicted detail is disclosed while cumulative feature amount is preserved',t=>{
  const f=fixture(t,{maxLines:3});
  for(let i=0;i<8;i++)f.add(`s${i}`,featureKey('fact_review'),f.at-10000+i);
  assert.equal(f.ledger.summary().plugin.totalTokens,960);
  const s=f.ledger.series();assert.equal(s.detailLimited,true);assert.equal(s.plugin.tokens,360);
  assert.ok(s.offChartTokens>=600);
});

test('snapshot-covered samples and later snapshots never double-count compacted usage',t=>{
  const f=fixture(t,{maxLines:3}), key=featureKey('memory_extract');
  for(let i=1;i<=5;i++)f.add('s',key,f.at-10000+i,100,i);
  assert.equal(f.ledger.summary().plugin.totalTokens,600);
  f.ledger.ingestBaseline({sessionId:'s',projection:{asOfSeq:5,values:{tokenUsage:{cacheMiss:500,output:100}}},at:f.at});
  assert.equal(f.ledger.summary().plugin.totalTokens,600);
  for(let i=6;i<=8;i++)f.add('s',key,f.at-10000+i,100,i);
  assert.equal(f.ledger.summary().plugin.totalTokens,960);
  f.ledger.compact();
  assert.equal(createTokenLedger({file:f.file}).summary().plugin.totalTokens,960);
});
