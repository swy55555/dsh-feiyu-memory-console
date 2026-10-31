import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createTokenLedger} from '../bridge/feature-token-ledger.mjs';
import {featureKey} from '../bridge/usage-features.mjs';
import {classifyHistory, readSession} from '../scripts/audit-usage-history.mjs';
import zlib from 'node:zlib';
import {DEFAULT_PRICE_TABLE,priceUsage} from '../bridge/feature-model-prices.mjs';

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

test('rotation input uses latest individual request, survives reload and never sums session history',t=>{
 const f=fixture(t);f.add('s','private:1',f.at-500,100000,1);f.add('s','private:1',f.at,200,2);
 assert.equal(f.ledger.latestInputTokens('s'),200);assert.equal(f.ledger.latestInputTokens('missing'),0);
 assert.equal(createTokenLedger({file:f.file}).latestInputTokens('s'),200);
 f.ledger.ingestEvent({sessionId:'s',event:{type:'assistant/message',seq:3,time:f.at+100,data:{turn:2,step:1,usage:{inputTokens:500,cacheReadTokens:99000,outputTokens:700}}}});
 assert.equal(f.ledger.latestInputTokens('s'),99500);
});

test('reconnect baseline preserves known peak prices and only estimates unknown remainder',t=>{
 const table={...DEFAULT_PRICE_TABLE,peakWeekdays:[0,1,2,3,4,5,6],peakWindows:[[9,10]],peakMultiplier:3,holidays:[]};
 const f=fixture(t,{priceTable:table}),peak=Date.parse('2026-10-30T01:00:00Z'),off=Date.parse('2026-10-30T02:00:00Z');
 f.add('s','private:1',peak,10000,1);
 const known=f.ledger.summary().totals.cost;
 f.ledger.ingestBaseline({sessionId:'s',projection:{asOfSeq:1,values:{tokenUsage:{cacheMiss:10000,output:20,reasoning:10}}},at:off});
 assert.ok(Math.abs(f.ledger.summary().totals.cost-known)<1e-12);
 f.ledger.ingestBaseline({sessionId:'s',projection:{asOfSeq:2,values:{tokenUsage:{cacheMiss:11000,output:20,reasoning:10}}},at:off});
 const totals=f.ledger.summary().totals,expected=known+priceUsage({cacheMiss:1000},{at:off,table}).cost.total;
 assert.ok(Math.abs(totals.cost-expected)<1e-12);assert.ok(Math.abs(totals.cost-totals.attributedCost-totals.unattributedCost)<1e-12);
 const series=f.ledger.series({hours:24});assert.ok(Math.abs(series.totals.cost+series.offChartCost-expected)<1e-12);
 const reloaded=createTokenLedger({file:f.file,priceTable:table,now:()=>f.at}).summary().totals;
 assert.ok(Math.abs(reloaded.cost-expected)<1e-12);assert.equal(reloaded.totalTokens,totals.totalTokens);
});
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

test('reviewed history reclassifies mixed old labels and excludes only proven slang everywhere',t=>{
  const f=fixture(t), old='internal:黑话学习';
  f.add('slang',old);f.add('memory',old);f.add('unknown',old);f.add('chat','private:1');
  // Exercise cumulative-only history as well as retained per-turn samples.
  f.ledger.ingestBaseline({sessionId:'slang',projection:{asOfSeq:1,values:{tokenUsage:{cacheMiss:100,output:20}}},at:f.at});
  const before=f.ledger.summary(),raw=fs.readFileSync(f.file);
  const entries={slang:{previousKey:old,key:'excluded:legacy-slang',excluded:true,evidenceHash:'a'.repeat(64)},memory:{previousKey:old,key:featureKey('memory_extract'),excluded:false,evidenceHash:'b'.repeat(64)}};
  fs.writeFileSync(f.file+'.attribution.json',JSON.stringify({version:1,entries}));
  const ledger=createTokenLedger({file:f.file,now:()=>f.at}),s=ledger.summary({limit:1}),series=ledger.series();
  assert.equal(s.totals.totalTokens,360);assert.equal(s.plugin.totalTokens,120);
  assert.equal(s.historyAudit.excludedTokens,120);assert.equal(s.historyAudit.pending.sessions,1);
  assert.ok(Math.abs(before.totals.cost-s.totals.cost-s.historyAudit.excludedCost)<1e-12);
  assert.equal(series.totals.tokens,360);assert.equal(series.offChartTokens,0);
  assert.equal(series.buckets.reduce((n,b)=>n+b.tokens,0),360);
  assert.equal(series.features[0].label,'记忆提取');
  assert.equal(ledger.conversation('excluded:legacy-slang'),null);
  assert.equal(ledger.conversation(featureKey('memory_extract')).turns[0].key,featureKey('memory_extract'));
  assert.equal(ledger.recent().some(r=>r.sessionId==='slang'),false);
  assert.deepEqual(fs.readFileSync(f.file),raw,'review must not rewrite raw journal');
  ledger.compact();
  assert.ok(fs.readFileSync(f.file,'utf8').includes(old));
  assert.equal(createTokenLedger({file:f.file,now:()=>f.at}).summary().totals.totalTokens,360);
  fs.unlinkSync(f.file+'.attribution.json');
  assert.equal(createTokenLedger({file:f.file,now:()=>f.at}).summary().totals.totalTokens,before.totals.totalTokens,'removing correction restores all raw totals');
});

test('exclusions cover compacted totals; invalid or stale corrections never remove unrelated usage',t=>{
  const f=fixture(t,{maxLines:1}),old='internal:黑话学习';
  f.add('slang',old, f.at-2,100,1);f.add('slang',old,f.at-1,100,2);
  const entry={previousKey:old,key:'excluded:legacy-slang',excluded:true,evidenceHash:'a'.repeat(64)};
  const file=f.file+'.attribution.json';fs.writeFileSync(file,JSON.stringify({version:1,entries:{slang:entry}}));
  let ledger=createTokenLedger({file:f.file,now:()=>f.at});
  assert.equal(ledger.summary().historyAudit.excludedTokens,240);
  assert.equal(ledger.series().offChartTokens,0);assert.equal(ledger.series().totals.tokens,0);
  ledger=createTokenLedger({file:f.file,resolveKey:()=> 'private:1',now:()=>f.at});
  assert.equal(ledger.summary().totals.totalTokens,240);
  fs.writeFileSync(file,JSON.stringify({version:1,entries:{slang:{...entry,evidenceHash:''}}}));
  ledger=createTokenLedger({file:f.file,now:()=>f.at});
  assert.equal(ledger.summary().totals.totalTokens,240);assert.ok(ledger.summary().historyAudit.error);
});

test('historical attribution requires trusted workspace, exact entry templates and a single purpose',()=>{
  const home=path.resolve('synthetic-home'),meta={type:'session',cwd:path.join(home,'qq-bridge/state/memory-agent'),agentPreset:'qq-memory'};
  const msg=text=>({type:'user/message',data:{message:{content:[{type:'text',text}]}}});
  const extract=msg('你是无工具的记忆整理器。下面是合成材料');
  assert.equal(classifyHistory([meta,extract],home).key,featureKey('memory_extract'));
  assert.equal(classifyHistory([{...meta,cwd:home},extract],home).key,undefined);
  assert.equal(classifyHistory([meta,extract,msg('你是角色的短程话题联想器，没有工具。')],home).key,undefined);
  assert.equal(classifyHistory([meta,extract,msg('未知任务')],home).key,undefined);
  const slang={...meta,cwd:path.join(home,'qq-bridge/state/slang-agent'),agentPreset:'qq-chat'};
  assert.equal(classifyHistory([slang,msg('你是一个群聊黑话学习器。合成数据'),msg('你是群聊黑话研究员。合成数据')],home).excluded,true);
  assert.equal(classifyHistory([slang,extract],home).excluded,undefined);
});

test('audit reads all concatenated zstd frames rather than just the metadata frame',t=>{
  const f=fixture(t),file=f.file+'.zstd';
  fs.writeFileSync(file,Buffer.concat([{type:'session'},{type:'turn/start'},{type:'turn/end'}].map(r=>zlib.zstdCompressSync(Buffer.from(JSON.stringify(r)+'\n')))));
  assert.deepEqual(readSession(file).map(r=>r.type),['session','turn/start','turn/end']);
});
