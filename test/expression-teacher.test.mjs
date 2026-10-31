import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';import path from 'node:path';
import {ExpressionTeacher} from '../bridge/expression-teacher.mjs';
import {backgroundEffort,reasoningView} from '../bridge/background-reasoning.mjs';
import {featureKey,featureLabel} from '../bridge/usage-features.mjs';
const DAY=86400000,key='private:1';
const passed={styleImproved:true,meaningPreserved:true,noInventedFacts:true,respectsBoundaries:true,personaPreserved:true,guidanceOnly:true,feedback:'回应了具体分享，没有新增经历'};
function fixture(){let now=40*DAY,enabled=true,saved=null;const calls=[];
 const teacher=new ExpressionTeacher({allowed:k=>k===key,enabled:()=>enabled,now:()=>now,save:s=>saved=structuredClone(s),persona:()=> '可以表达不同意见，平时会打趣',generate:async(p,stage)=>{
  calls.push({p,stage});if(stage==='teach')return JSON.stringify({sourceId:'one',quote:'我只是分享，先别给建议',intents:['share'],guidance:'先回应分享中的具体细节，是否建议按对方需要',avoid:'避免把随口分享变成任务清单',example:'这段路看起来走得挺舒服。',reason:'本人要求分享时不急着建议'});
  return JSON.stringify(stage==='practice'?{reply:'这段路走着舒服吗，听起来挺放松。'}:passed);
 }});
 const input=(id='one',quote='我只是分享，先别给建议')=>({source:{id,original:quote,at:now,source:'user',current:true},recent:[{role:'user',text:'今天在小路走了一会儿',at:now-2000},{role:'assistant',text:'建议你每天走两公里。',at:now-1000}],requests:[{kind:'response_style',explicit:true,confidence:.95,quote,instruction:'分享时先回应具体细节，不急着建议'}]});
 return {teacher,calls,input,advance:n=>now+=n,setEnabled:v=>enabled=v,get saved(){return saved},get now(){return now}};
}
test('opt-in, real correction, scope and dialogue are required; normal chat creates no paid task',async()=>{
 const f=fixture();f.setEnabled(false);assert.equal(f.teacher.observe(key,f.input()),false);assert.equal((await f.teacher.train(key)).skipped,true);
 f.setEnabled(true);assert.equal(f.teacher.observe('group:9',f.input()),false);assert.equal(f.teacher.observe(key,{...f.input(),requests:[],feedback:[]}),false);
 assert.equal(f.teacher.observe(key,{...f.input(),source:{...f.input().source,source:'assistant'}}),false);
 assert.equal(f.teacher.observe(key,{...f.input(),requests:[{...f.input().requests[0],quote:'编造原话'}]}),false);
 assert.equal(f.teacher.observe(key,{...f.input(),recent:[]}),false);await f.teacher.train(key);assert.equal(f.calls.length,0);
});
test('teacher demonstration, practice and independent check stop early; examples never enter real reply references',async()=>{
 const f=fixture();assert.equal(f.teacher.observe(key,f.input()),true);assert.equal((await f.teacher.train(key)).skipped,true);
 f.advance(6*60000);assert.deepEqual(await f.teacher.train(key),{ok:true,calls:3});assert.deepEqual(f.calls.map(c=>c.stage),['teach','practice','review']);
 const lesson=f.teacher.view(key).lessons[0];assert.equal(lesson.status,'trial');assert.equal(lesson.expiresAt,40*DAY+7*DAY);
 const candidate=f.teacher.candidates(key,'share')[0];assert.ok(candidate);assert.doesNotMatch(candidate.text,/这段路|走两公里/);
 assert.match(f.calls.at(-1).p,/可以表达不同意见/);assert.match(f.calls.at(-1).p,/不能代替用户认可/);
 assert.equal(f.teacher.candidates('private:2','share').length,0);assert.equal(f.teacher.candidates(key,'play').length,0);
 assert.equal(f.teacher.candidates(key,'share',{currentRequest:true}).length,0);assert.equal(f.teacher.candidates(key,'share',{boundary:'stop'}).length,0);
 assert.equal(f.teacher.observe(key,f.input('repeat')),false);f.advance(8*DAY);assert.equal(f.teacher.candidates(key,'share').length,0);
 assert.equal((await f.teacher.train(key)).skipped,true);assert.equal(f.calls.length,3);
});
test('failed practice retries within the selected bound and never passes itself as user evidence',async()=>{
 const f=fixture(),generate=f.teacher.generate;f.teacher.generate=async(p,stage)=>{const out=await generate(p,stage);return stage==='review'?JSON.stringify({...passed,styleImproved:false,feedback:'仍在给建议，请只回应分享'}):out};
 f.teacher.observe(key,f.input());f.advance(6*60000);assert.deepEqual(await f.teacher.train(key),{ok:false,calls:5});
 assert.deepEqual(f.calls.map(c=>c.stage),['teach','practice','review','practice','review']);assert.match(f.calls[3].p,/仍在给建议/);
 assert.equal(f.teacher.view(key).lessons[0].status,'failed');assert.equal(f.teacher.candidates(key,'share').length,0);
 f.advance(DAY);await f.teacher.train(key);assert.equal(f.calls.length,5);
 const restored=new ExpressionTeacher({allowed:k=>k===key,enabled:()=>true,load:()=>f.saved,now:()=>f.now,generate:()=>{throw Error('must not retry')}});
 assert.equal((await restored.train(key)).skipped,true);
});
test('fabricated lesson sources, malformed checks and identity guidance cannot become active references',async()=>{
 for(const failure of ['source','review','identity']){
  const f=fixture(),generate=f.teacher.generate;f.teacher.generate=async(p,stage)=>{let out=JSON.parse(await generate(p,stage));if(stage==='teach'&&failure==='source')out.quote='不同原话';if(stage==='review'&&failure==='review')delete out.respectsBoundaries;if(stage==='review'&&failure==='identity')out.guidanceOnly=false;return JSON.stringify(out)};
  f.teacher.observe(key,f.input());f.advance(6*60000);assert.equal((await f.teacher.train(key)).ok,false);assert.equal(f.teacher.candidates(key,'share').length,0);
 }
});
test('disable, newer request, edit and concurrent training cannot publish stale results or start the next call',async()=>{
 for(const reason of ['disabled','request','edit']){
  const f=fixture();let finish;f.teacher.generate=()=>new Promise(resolve=>finish=resolve);f.teacher.observe(key,f.input());f.advance(6*60000);
  const pending=f.teacher.train(key);assert.equal((await f.teacher.train(key)).skipped,true);
  if(reason==='disabled'){f.setEnabled(false);f.teacher.invalidate(key)}
  if(reason==='request')f.teacher.observe(key,{...f.input('two','这回请详细说明'),recent:[]});
  if(reason==='edit')f.teacher.invalidate(key);
  finish(JSON.stringify({skip:true}));assert.equal((await pending).calls,1);assert.equal(f.teacher.view(key).lessons.length,0);assert.equal(f.teacher.view(key).queueCount,0);
 }
});
test('persistence failure prevents a paid call; cooldown and old ledger labels remain explicit',async()=>{
 const f=fixture();f.teacher.observe(key,f.input());f.advance(6*60000);f.teacher.save=()=>{throw Error('disk')};await assert.rejects(f.teacher.train(key));assert.equal(f.calls.length,0);assert.equal(f.teacher.storageError,true);
 assert.equal(backgroundEffort({},'growth_classroom'),'low');assert.match(featureLabel(featureKey('expression_teacher')),/已停用/);assert.match(featureLabel(featureKey('style_distillation')),/已停用/);assert.ok(!reasoningView({}).modules.some(m=>m.id==='style_distillation'));
});
test('real management route persists independent opt-in and rejects invalid rounds or agent toggles',async()=>{
 const src=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8'),a=src.indexOf("        if (url.pathname === '/api/mind')"),b=src.indexOf("        if (url.pathname === '/api/continuity')",a),route=src.slice(a,b);
 let file={ownerQQ:1,socialV2:{mind:{learningEnabled:false},continuity:{enabled:true}}},cfg=structuredClone(file),invalidations=0;
 async function call(body,headers={}){let response;const ctx=vm.createContext({backgroundEffort,url:{pathname:'/api/mind'},req:{method:'POST',headers},cfg,ROOT:'fixture',path,readBody:async()=>body,readConfigObject:()=>structuredClone(file),atomicWriteJson:(_p,v)=>file=v,
  mindWorkspaces:{invalidate:()=>{},snapshot:()=>({})},continuity:{invalidate:()=>{}},responsePatterns:{view:()=>({})},expressionTeacher:{view:()=>({lessons:[]}),invalidate:()=>invalidations++},sendJson:(data,status=200)=>response={data,status}});
  await vm.runInContext('(async()=>{'+route+'})()',ctx);return response;}
 assert.equal((await call({teacherEnabled:true},{'x-agent-call':'1'})).status,403);assert.equal(file.socialV2.mind.teacherEnabled,undefined);
 assert.equal((await call({teacherRounds:4})).status,400);assert.equal((await call({teacherEnabled:true,teacherRounds:2})).status,400);assert.equal(file.socialV2.mind.learningEnabled,false);assert.equal(file.socialV2.mind.teacherEnabled,undefined);
 await call({teacherEnabled:false});assert.equal(invalidations,0);
 assert.doesNotMatch(src,/StyleDistillation|styleDistillation|pause-style/);
});
