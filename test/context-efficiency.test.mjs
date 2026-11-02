import {extras} from './bridge-test-context.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {assembleReferences} from '../bridge/reference-assembly.mjs';
import {rotationBlockers,ContextEfficiency} from '../bridge/context-efficiency.mjs';
import {buildSessionBlock,buildSummaryBlock} from '../bridge/human-context.mjs';
import {recallForCurrentContext} from '../bridge/reply-context.mjs';
const key='private:1';
test('only exact same scope, purpose and version duplicate is omitted; people, negations, time remain',()=>{
 const texts=['甲：不喜欢煎饼','甲：喜欢小笼包','乙：喜欢煎饼','甲：以前喜欢煎饼','甲：周末偶尔喝豆浆'];
 const blocks=texts.map((text,i)=>({id:'m'+i,purpose:'fact',scope:key,version:'v1',text:text+'\n'}));
 const result=assembleReferences({key,blocks:[...blocks,{...blocks[0],id:'duplicate'},{...blocks[0],id:'other-version',version:'v2'},{...blocks[0],id:'emotion',purpose:'feeling'},{id:'private',scope:'private:2',text:'private secret'}]});
 for(const text of texts)assert.ok(result.text.includes(text));
 assert.equal(result.report.decisions.filter(x=>x.reason==='exact-duplicate').length,1);
 assert.equal(result.text.includes('private secret'),false);assert.ok(result.blocks.some(x=>x.id==='emotion'));
});
test('one budget keeps complete recent utterances and required corrections; no partial sentence clipping',()=>{
 const rows=Array.from({length:30},(_,i)=>({text:`第${i}条：只在周末喝豆浆，工作日不喝。`+'细节'.repeat(100),sender:'甲',at:1700000000000+i}));
 const correction='当前纠正：之前是引用乙的话，甲没有说自己喜欢煎饼。\n';
 const original=buildSessionBlock(rows,{maxChars:6000});
 const r=assembleReferences({key,budgetChars:2400,blocks:[{id:'history',scope:key,text:original,priority:10,fit:n=>buildSessionBlock(rows,{maxChars:n})},{id:'correction',scope:key,text:correction,priority:100,required:true}]});
 assert.ok(r.text.length<=2400);assert.ok(r.text.endsWith(correction));assert.ok(r.text.includes(rows.at(-1).text));
 for(const row of rows)if(r.text.includes(row.text.slice(0,7)))assert.ok(r.text.includes(row.text));
 assert.ok(r.report.omittedChars>0);
 const over=assembleReferences({key,budgetChars:2400,blocks:[{id:'rule',scope:key,text:'不能裁剪'.repeat(1000),required:true}]});assert.equal(over.report.protectedOverflow,true);
});
test('actual bridge composer applies unified reference budget and preserves current message verbatim',async()=>{
 const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
 const start=source.indexOf('  async function withMemoryContext('),end=source.indexOf('  const dailyRecallQueries',start);
 const observations=new ContextEfficiency();
 const rows=Array.from({length:30},(_,i)=>({text:`甲说第${i}件事：不喜欢煎饼，喜欢小笼包。`+'细节'.repeat(80),sender:'甲',at:1700000000000+i}));
 const ctx=vm.createContext({...extras,assembleReferences,contextEfficiency:observations,buildSessionBlock,buildSummaryBlock,crypto,recallForCurrentContext,
   cfg:{socialV2:{memoryRecall:{enabled:false},context:{referenceBudgetChars:2400}}},mindAllowed:()=>false,
   humanContextEnabled:()=>false,noteSessionTurn:()=>{},scheduleRotationCheck:()=>{},dailyMemorySubjects:new Map(),dailyRecallQueries:new Map(),
   recordRetrievalTrace:()=>{},fetchContextBundle:async()=>({messages:rows,summaries:[]}),sessionWindowStart:()=>1,log:()=>{}});
 const compose=vm.runInContext(source.slice(start,end)+';withMemoryContext',ctx),context={};
 const current='现在纠正：我不喜欢煎饼，但喜欢小笼包。'+ '完整请求'.repeat(1000);
 const output=await compose(key,current,context);
 assert.ok(output.endsWith(current));assert.ok(output.length-current.length<=2400);
 assert.ok(context.referenceBlocks.every(b=>output.includes(b.text)));
 assert.ok(observations.view(key).assembly.omittedChars>0);
});
test('rotation diagnostics distinguish blockers without doing work; observations are chat-scoped and bounded',()=>{
 assert.deepEqual(rotationBlockers({now:120000,lastActivity:0}),[]);
 assert.deepEqual(rotationBlockers({now:120000,lastActivity:119000,turn:true,wait:true,unread:1}),['model-turn','tool-wait','unread-messages','recent-activity']);
 const d=new ContextEfficiency({now:()=>123,maxChats:2});d.record(key,'rotation',{reason:'active',blockers:['tool-wait']});
 assert.equal(d.view('private:2').rotation,undefined);const v=d.view(key);v.rotation.reason='tampered';assert.equal(d.view(key).rotation.reason,'active');
 d.record('private:2','assembly',{});d.record('group:3','assembly',{});assert.deepEqual(d.view(key),{});
});
test('actual diagnostics endpoint is management-only and has no model or write callback',async()=>{
 const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
 const start=source.indexOf("        if (req.method === 'GET' && url.pathname === '/api/context/efficiency')"),end=source.indexOf("        if (req.method === 'POST' && url.pathname === '/api/context/summarize')",start);
 const code='(async()=>{'+source.slice(start,end)+'})()';
 for(const [headers,k,status] of [[{},key,200],[{'x-agent-token':'x'},key,403],[{},'invalid',400]]){
  let result;await vm.runInNewContext(code,{req:{method:'GET',headers},url:new URL('http://local/api/context/efficiency?key='+k),sendJson:(body,code=200)=>result={body,code},contextEfficiency:{view:()=>({rotation:{reason:'active'}})},dailyMemory:{analysisMemo:{stats:()=>({states:[]})}}});
  assert.equal(result.code,status);
 }
});
