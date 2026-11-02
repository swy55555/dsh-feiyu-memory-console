import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';import {DatabaseSync} from 'node:sqlite';
import {ChatClarifications,clarificationInstruction} from '../bridge/chat-clarification.mjs';import {SourceValidity} from '../bridge/source-validity.mjs';import {Continuity} from '../bridge/continuity.mjs';import {DailyMemory} from '../bridge/daily-memory.js';
const key='private:1',ctx={scope:key,id:'new',text:'刚才那句我去杭州是说错的，整句不算。',version:'new-version',candidates:[{id:'old',text:'我明天去杭州',version:'old-version',revision:0}]};
const proposal=()=>({kind:'whole_retraction',targetId:'old',quote:ctx.text,oldQuote:ctx.candidates[0].text,speaker:'self',mode:'asserted',coverage:'entire',explicit:true,confidence:.99});
test('real original-write helper returns the existing request and local submit carries its required header',async()=>{
 const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');const take=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
 let calls=0,finish;const context=vm.createContext({memvecHeaders:extra=>({'content-type':'application/json','x-memvec-token':'fixture-token',...extra}),cfg:{socialV2:{}},AbortSignal,fetch:async()=>{calls++;await new Promise(r=>finish=r);return {ok:true,arrayBuffer:async()=>new ArrayBuffer(0)}}});
 const persist=vm.runInContext(take('  function persistMessageToMemvec(','  // ── 会话摘要')+';persistMessageToMemvec',context);
 const job=persist(key,{id:'new',userId:'1',text:ctx.text,time:Date.now()},'private');assert.equal(typeof job.then,'function');assert.equal(calls,1);finish();assert.equal(await job,true);assert.equal(calls,1);
 const options=[];context.fetch=async(url,opt)=>{options.push(opt);return {ok:true,json:async()=>({ok:true})}};
 const request=vm.runInContext(take('  async function memoryRequest(','  // 无工具的一次性后台')+';memoryRequest',context);
 await request('/sources/clarification/apply',{});await request('/related',{});assert.equal(options[0].headers['x-source-correction'],'1');assert.equal(options[1].headers['x-source-correction'],undefined);
 assert.match(source,/if\(chatClarifications.enabled\(key\)\)await memorySourceStored/);
});
test('only full, literal, same-context whole retraction reaches local submit; other meanings preserve source',async()=>{
 let calls=0;const c=new ChatClarifications({enabled:()=>true,candidates:()=>ctx,request:async(route,body)=>{calls++;assert.equal(route,'/sources/clarification/apply');assert.equal(body.targetVersion,'old-version');return {ok:true,status:'applied',paused:1}}});
 for(const patch of [{targetId:'invented'},{quote:'整句不算'},{oldQuote:'去杭州'},{mode:'quoted'},{mode:'hypothetical'},{mode:'joke'},{speaker:'other'},{coverage:'partial'},{confidence:.9},{explicit:false}])assert.equal((await c.apply(ctx,{...proposal(),...patch})).status,'rejected');
 for(const kind of ['partial_correction','time_change','uncertain'])assert.equal((await c.apply(ctx,{...proposal(),kind})).status,'preserved');
 assert.equal((await c.apply(ctx,proposal(),()=>false)).status,'skipped');assert.equal(calls,0);assert.equal((await c.apply(ctx,proposal())).status,'applied');assert.equal(calls,1);
 assert.equal(clarificationInstruction(null),'');assert.doesNotMatch(clarificationInstruction(ctx),/我明天去杭州/);assert.match(clarificationInstruction(ctx),/partial_correction/);
});
test('one event understanding call produces optional correction; switch and newer input prevent submission',async()=>{
 let modelCalls=0,submits=0,enabled=true;
 const clarification=new ChatClarifications({enabled:()=>enabled,candidates:()=>ctx,request:async()=>{submits++;return {ok:true,status:'applied',paused:2}}});
 const neutral={summary:'用户纠正旧话',appraisal:{kind:'neutral',target:'none',confidence:.95,intensity:0,evidence:[]},concerns:[],beliefs:[],focusIds:[],relationship:{kind:'none',quote:''},clarification:proposal()};
 const c=new Continuity({enabled:()=>true,allowed:()=>true,clarifications:clarification,generate:async prompt=>{modelCalls++;assert.match(prompt,/可选 clarification/);return JSON.stringify(neutral)}});
 await c.observe(key,{text:ctx.text,speakerId:'1',dialogue:[]},c.begin(key,'new'));assert.equal(modelCalls,1);assert.equal(submits,1);assert.equal(c.snapshot(key).events.at(-1).clarification.status,'applied');
 assert.equal(await c.observe(key,{text:ctx.text,speakerId:'1'},c.begin(key,'new')),null);assert.equal(modelCalls,1);
 enabled=false;assert.equal(clarification.context(key,{},[]),null);assert.equal((await clarification.apply(ctx,proposal())).status,'skipped');assert.equal(submits,1);
});
test('local submit failure is recorded once, never loops or starts another model',async()=>{
 let calls=0;const c=new ChatClarifications({enabled:()=>true,candidates:()=>ctx,request:async()=>{calls++;throw Error('timeout')}});assert.equal((await c.apply(ctx,proposal())).status,'unavailable');assert.equal(calls,1);
});
test('unknown HTTP outcome can reconcile durable receipt for undo without resubmitting',async()=>{
 let calls=0,committed=false,state='revoked';const c=new ChatClarifications({enabled:()=>true,candidates:()=>ctx,request:async()=>{calls++;throw Error('response lost')},receipt:()=>committed?{status:'applied',sourceVersion:'old-version',paused:0,correctionRevision:1}:null,lookup:()=>({state,revision:state==='revoked'?1:2})});
 const result=await c.apply(ctx,proposal());assert.equal(c.view(result).status,'unavailable');committed=true;assert.equal(c.view(result).canUndo,true);assert.equal(c.view(result).status,'applied');state='restored';assert.equal(c.view(result).canUndo,false);assert.equal(calls,1);
});
test('candidate collection uses complete stored same-author originals and local revisions only',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'clarify-')),file=path.join(dir,'db');const db=new DatabaseSync(file),v=new SourceValidity({file});const now=Date.now();
 try{
  db.exec('CREATE TABLE source_corrections(source_version TEXT,scope TEXT,event_id TEXT,state TEXT,revision INTEGER); CREATE TABLE originals(key TEXT,message_id TEXT,user_id TEXT,is_self INTEGER,source_truncated INTEGER,text TEXT,at REAL,source_version TEXT); CREATE VIEW evidence_source_lookup AS SELECT * FROM originals;');
  const add=(id,body,at,subject='1',self=0)=>db.prepare('INSERT INTO originals VALUES(?,?,?, ?,0,?,?,?)').run(key,id,subject,self,body,at,id+'-version');
  add('new',ctx.text,now);add('old',ctx.candidates[0].text,now-10000);add('other','别人的话',now-5000,'2');add('assistant','自己编的',now-4000,'1',1);
  const input={speakerId:'1',messageId:'new',text:ctx.text};const recent=[{id:'old',role:'user',text:ctx.candidates[0].text},{id:'other',role:'user',text:'别人的话'},{id:'assistant',role:'assistant',text:'自己编的'}];
  assert.deepEqual(v.clarificationCandidates(key,input,recent).candidates.map(x=>x.id),['old']);assert.equal(v.clarificationCandidates(key,{...input,speakerId:'2'},recent),null);
  assert.equal(v.clarificationCandidates(key,input,[{...recent[0],truncated:true}]),null);assert.equal(v.clarificationCandidates(key,input,[{...recent[0],text:'改过原话'}]),null);
  db.prepare("INSERT INTO source_corrections VALUES('old-version',?,'event','revoked',1)").run(key);assert.equal(v.clarificationCandidates(key,input,recent),null);
 }finally{v.close();db.close();fs.rmSync(dir,{recursive:true,force:true})}
});
test('withdrawn queued originals are kept without extraction calls; undo makes them eligible again',async()=>{
 let blocked=true,extracts=0,checks=0;const d=new DailyMemory({enabled:()=>true,allowed:()=>true,load:()=>null,save:()=>{},log:()=>{},sourceBlocked:()=>blocked,request:async()=>({results:[]}),extract:async()=>{extracts++;return JSON.stringify({items:[],completed_source_ids:['old']})},verify:async()=>{checks++;return JSON.stringify({checks:[{source_id:'old',status:'complete',missing_quotes:[],reason:'完整'}]})}});
 try{d.feed(key,{id:'old',userId:'1',text:'旧原话',time:Date.now()-100000});assert.equal((await d.flush(key)).reason,'source-paused');assert.equal(extracts,0);assert.equal(checks,0);assert.equal(d.state.queues[key].length,1);assert.equal(d.state.processing.at(-1).status,'source-paused');
 blocked=false;const r=await d.flush(key);assert.equal(r.ok,true);assert.equal(extracts,1);assert.equal(checks,1);
 }finally{clearInterval(d.timer);clearTimeout(d.saveTimer)}
});
