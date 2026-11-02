import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
import {GrowthClassroom,classroomReference,classroomInstruction} from '../bridge/growth-classroom.mjs';
import {backgroundEffort} from '../bridge/background-reasoning.mjs';
import {Continuity} from '../bridge/continuity.mjs';
const key='private:1',input={action:'save',title:'自然表达',goal:'对具体分享回应一处细节，不机械给建议',when:'日常分享',scene:'今天终于忙完了',example:''};
const draft={guidance:'先回应本轮具体分享，保持自己的态度，必要时再给建议。',avoid:'不机械总结或强迫对方继续聊天。',example:'终于忙完啦。今天是哪件事最费劲？',rationale:'在示例中关注具体经历，而非替用户安排生活。',checks:['有没有回应具体内容','是否添加了不存在的经历']};
function fixture(){let disk,now=100000,calls=0;const c=new GrowthClassroom({allowed:k=>k===key,now:()=>now,save:s=>disk=structuredClone(s),load:()=>disk,generate:async()=>{calls++;return JSON.stringify(draft)},signature:()=>({model:'test',effort:'low'})});return {c,calls:()=>calls,disk:()=>disk,advance:()=>now+=61000};}
test('opt-in and explicit start; unchanged inputs reuse one draft, approval never spends tokens',async()=>{
 const f=fixture(),c=f.c;c.edit(key,input);const id=c.view(key).courses[0].id;
 assert.equal(f.calls(),0);assert.throws(()=>c.start(key,id),/开启/);c.edit(key,{action:'settings',enabled:true});c.start(key,id);await c.job;
 assert.equal(f.calls(),1);let row=c.view(key).courses[0];assert.equal(row.status,'review');assert.equal(c.catalog(key).length,0);
 c.edit(key,{action:'approve',id,revision:row.revision});assert.equal(c.catalog(key).length,1);assert.equal(f.calls(),1);
 assert.equal(c.start(key,id).reused,true);assert.equal(f.calls(),1);assert.equal(c.view('private:2').courses.length,0);
 c.edit(key,input);const second=c.view(key).courses.at(-1).id;assert.equal(c.start(key,second).reused,true);assert.equal(f.calls(),1);
});
test('manual references cost no calls; relevance, current request, scope and revision gate injection',()=>{
 const f=fixture(),c=f.c;c.edit(key,input);const id=c.view(key).courses[0].id;c.edit(key,{action:'reference',id,guidance:'先回应具体分享',avoid:''});
 c.edit(key,{action:'approve',id,revision:c.view(key).courses[0].revision});assert.equal(c.catalog(key).length,0);c.edit(key,{action:'settings',enabled:true});
 const catalog=c.catalog(key),ref=classroomReference({...catalog[0],quote:'忙完'},'终于忙完了',catalog);
 assert.equal(c.candidates(key,ref).length,1);assert.equal(c.candidates(key,ref,{currentRequest:true}).length,0);assert.equal(c.candidates(key,ref,{boundary:'stop'}).length,0);assert.equal(c.candidates('private:2',ref).length,0);
 assert.equal(classroomReference({...ref,quote:'没说过'},'终于忙完了',catalog),null);
 c.edit(key,{...input,id,goal:'新目标'});assert.equal(c.candidates(key,ref).length,0);assert.throws(()=>c.edit(key,{action:'approve',id,revision:c.view(key).courses[0].revision}));assert.equal(f.calls(),0);
 assert.equal(classroomInstruction([]),'');
});
test('late output after edit or disable is discarded; concurrent starts never duplicate calls',async()=>{
 for(const action of ['edit','disable']){const f=fixture(),c=f.c;let finish;c.generate=()=>new Promise(r=>finish=r);c.edit(key,input);const id=c.view(key).courses[0].id;c.edit(key,{action:'settings',enabled:true});c.start(key,id);assert.throws(()=>c.start(key,id),/等待/);
 if(action==='edit')c.edit(key,{...input,id,goal:'修改目标'});else c.edit(key,{action:'settings',enabled:false});finish(JSON.stringify(draft));await c.job;assert.equal(c.view(key).courses[0].draft,null);assert.equal(c.catalog(key).length,0);}
});
test('failed output never activates and is not automatically retried; persisted cooldown protects restart',async()=>{
 const f=fixture(),c=f.c;c.generate=async()=>'{bad';c.edit(key,input);const id=c.view(key).courses[0].id;c.edit(key,{action:'settings',enabled:true});c.start(key,id);await c.job;
 assert.equal(c.view(key).courses[0].status,'error');assert.throws(()=>c.start(key,id),/一分钟/);assert.equal(c.catalog(key).length,0);
 const restored=new GrowthClassroom({allowed:()=>true,load:f.disk,now:()=>100000,generate:()=>{throw Error('must not call')}});assert.throws(()=>restored.start(key,id),/一分钟/);
});
test('negative real-use feedback pauses reference; repeated approval is not skill evidence',()=>{
 const f=fixture(),c=f.c;c.edit(key,input);const id=c.view(key).courses[0].id;c.edit(key,{action:'reference',id,guidance:'通用方法',avoid:''});c.edit(key,{action:'approve',id,revision:c.view(key).courses[0].revision});c.edit(key,{action:'settings',enabled:true});
 c.edit(key,{action:'feedback',id,outcome:'unhelpful',note:'这轮还是给了无关建议'});assert.equal(c.catalog(key).length,0);assert.equal(c.view(key).courses[0].feedback[0].source,'user-entered');assert.equal(f.calls(),0);
});
test('storage failure precedes paid work and old teacher loop is absent from runtime',()=>{
 const f=fixture(),c=f.c;c.edit(key,input);const id=c.view(key).courses[0].id;c.edit(key,{action:'settings',enabled:true});c.save=()=>{throw Error('disk')};assert.throws(()=>c.start(key,id),/disk/);assert.equal(f.calls(),0);
 const src=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');assert.doesNotMatch(src,/teacherTimer|expressionTeacher\.train\(|expressionTeacher\.observe\(/);assert.equal(backgroundEffort({},'growth_classroom'),'low');
});
test('classroom management rejects agent and wrong methods, exposes only configured model name',async()=>{
 const src=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8'),a=src.indexOf("        if (url.pathname === '/api/classroom')"),b=src.indexOf("        if (url.pathname === '/api/mind')",a),route=src.slice(a,b);
 const f=fixture();async function run(method,headers={},body={}){let out;const ctx=vm.createContext({url:{pathname:'/api/classroom'},req:{method,headers},cfg:{ownerQQ:1,dsh:{model:'test-model'},socialV2:{}},backgroundEffort,growthClassroom:f.c,expressionTeacher:{view:()=>({lessons:[]})},readBody:async()=>body,mindWorkspaces:{invalidate:()=>{}},continuity:{invalidate:()=>{}},sendJson:(data,status=200)=>out={data,status}});await vm.runInContext('(async()=>{'+route+'})()',ctx);return out;}
 assert.equal((await run('POST',{'x-agent-call':'1'},input)).status,403);assert.equal((await run('DELETE')).status,405);assert.equal((await run('POST',{},input)).status,200);assert.equal((await run('GET')).data.model,'test-model');assert.equal(f.calls(),0);
});
test('course selection shares event understanding and expires with that turn; no second classifier',async()=>{
 const f=fixture(),c=f.c;c.edit(key,input);const id=c.view(key).courses[0].id;c.edit(key,{action:'reference',id,guidance:'回应具体分享',avoid:''});c.edit(key,{action:'approve',id,revision:c.view(key).courses[0].revision});c.edit(key,{action:'settings',enabled:true});
 let now=100000,calls=0;const body='今天终于忙完了',catalog=c.catalog(key);
 const continuity=new Continuity({allowed:k=>k===key,enabled:()=>true,now:()=>now,courseContext:k=>c.catalog(k),generate:async prompt=>{calls++;assert.ok(prompt.includes(id));return JSON.stringify({summary:'用户分享忙完的日常',appraisal:{kind:'neutral',target:'none',confidence:.95,intensity:0,evidence:[],feelings:[]},concerns:[],beliefs:[],focusIds:[],relationship:{kind:'none',quote:''},interaction:{intent:'share',focus:'shared_detail',boundary:'none',confidence:.95,meaning:'分享忙完这件事',quote:body,contextEvidence:[]},classroom:{...catalog[0],quote:body}})}});
 await continuity.observe(key,{text:body},continuity.begin(key,'m'));const ctx={};continuity.prompt(key,ctx);assert.equal(c.candidates(key,ctx.classroomRef).length,1);assert.equal(calls,1);assert.equal(f.calls(),0);
 now+=120001;const stale={};continuity.prompt(key,stale);assert.equal(c.candidates(key,stale.classroomRef).length,0);
 continuity.begin(key,'next');assert.equal(continuity.prompt(key,{}),'');
});

test('global courses reuse drafts across allowed chats and reject a fourth active course',async()=>{
 let calls=0;const c=new GrowthClassroom({allowed:()=>true,generate:async()=>{calls++;return JSON.stringify(draft)}});
 c.edit(key,{action:'settings',enabled:true});c.edit(key,input);
 const first=c.view(key).courses[0].id;c.start(key,first);await c.job;
 c.edit('private:2',input);const second=c.view(key).courses.at(-1).id;
 assert.equal(c.start('private:2',second).reused,true);assert.equal(calls,1);
 for(let i=0;i<4;i++){
  c.edit(key,{...input,title:'启用上限'+i});const row=c.view(key).courses.at(-1);
  c.edit(key,{action:'reference',id:row.id,guidance:'回应具体内容',avoid:''});
  const approve=()=>c.edit(key,{action:'approve',id:row.id,revision:c.view(key).courses.at(-1).revision});
  if(i<3)approve();else assert.throws(approve,/最多启用3门/);
 }
 assert.equal(c.view(key).courses.filter(x=>x.active).length,3);assert.equal(c.catalog(key).length,3);
});
test('late generation failure cannot overwrite a newer course edit or disabled state',async()=>{
 for(const mode of ['edit','disable']){
  const f=fixture(),c=f.c;let reject;c.generate=()=>new Promise((_,r)=>reject=r);
  c.edit(key,input);c.edit(key,{action:'settings',enabled:true});const id=c.view(key).courses[0].id;
  c.start(key,id);
  if(mode==='edit')c.edit(key,{...input,id,goal:'新的目标'});else c.edit(key,{action:'settings',enabled:false});
  const before=c.view(key).courses[0];reject(Error('late failure'));await c.job;
  assert.deepEqual(c.view(key).courses[0],before);assert.equal(c.busy,false);
 }
});

function exerciseFixture(){
 const f=fixture(),c=f.c;c.edit(key,{action:'settings',enabled:true});c.edit(key,input);
 const id=c.view(key).courses[0].id;c.edit(key,{action:'reference',id,guidance:'合成练习参考',avoid:''});
 return {...f,id};
}
const exerciseOutput=method=>method==='selfQuiz'?JSON.stringify({scenario:'合成题目',answer:'合成回答'}):'合成回答';

test('exercises discard late results after disable, re-enable, edits, pause or permission revocation',async()=>{
 for(const method of ['homeworkAnswer','selfQuiz'])for(const change of ['disable','re-enable','edit','pause','permission']){
  const {c,id}=exerciseFixture();let finish;c.generate=()=>new Promise(r=>finish=r);
  const job=c[method](key,id,'合成情景');assert.equal(c.busy,true);
  if(change==='edit')c.edit(key,{...input,id,goal:'修改后的新目标'});
  else if(change==='pause')c.edit(key,{action:'pause',id});
  else if(change==='permission')c.allowed=()=>false;
  else{c.edit(key,{action:'settings',enabled:false});if(change==='re-enable')c.edit(key,{action:'settings',enabled:true});}
  const before=structuredClone(c.state),rejected=assert.rejects(job,/变化|允许/);
  finish(exerciseOutput(method));await rejected;
  assert.deepEqual(c.state,before,method+' '+change);assert.equal(c.busy,false);
 }
});

test('course generation, homework and self quiz share one busy lock in every direction',async()=>{
 for(const first of ['start','homeworkAnswer','selfQuiz']){
  const {c,id}=exerciseFixture();let finish,calls=0;c.generate=()=>{calls++;return new Promise(r=>finish=r)};
  const started=c[first](key,id,'合成情景'),job=first==='start'?c.job:started;
  assert.equal(c.view(key).busy,true);
  assert.throws(()=>c.start(key,id),/已有/);
  await assert.rejects(c.homeworkAnswer(key,id,'重复情景'),/已有/);
  await assert.rejects(c.selfQuiz(key,id),/已有/);
  assert.equal(calls,1);finish(first==='start'?JSON.stringify(draft):exerciseOutput(first));await job;
  assert.equal(c.busy,false);
 }
});

test('exercise model, parse and persistence errors release the lock without partial writes',async()=>{
 for(const method of ['homeworkAnswer','selfQuiz'])for(const failure of ['model','parse','save']){
  const {c,id}=exerciseFixture(),save=c.save,before=structuredClone(c.state);
  c.generate=async()=>{if(failure==='model')throw Error('模拟模型离线');return failure==='parse'?'':exerciseOutput(method)};
  if(failure==='save')c.save=()=>{throw Error('模拟保存失败')};
  await assert.rejects(c[method](key,id,'合成情景'));assert.deepEqual(c.state,before);assert.equal(c.busy,false);
  c.save=save;c.generate=async()=>exerciseOutput(method);
  const result=await c[method](key,id,'重试情景');assert.ok(result.itemId);assert.equal(c.state.courses[0].homework.length,1);assert.equal(c.storageError,false);
 }
});

test('successful exercises preserve response fields and keep at most thirty ungraded records',async()=>{
 for(const method of ['homeworkAnswer','selfQuiz']){
  const {c,id}=exerciseFixture();c.generate=async()=>exerciseOutput(method);
  let result;for(let i=0;i<32;i++)result=await c[method](key,id,'合成情景'+i);
  const rows=c.state.courses[0].homework;assert.equal(rows.length,30);assert.equal(rows.at(-1).id,result.itemId);
  assert.equal(rows.at(-1).scenario,result.scenario);assert.equal(rows.at(-1).answer,result.answer);assert.equal(rows.at(-1).score,null);
  assert.equal(rows.at(-1).selfMade===true,method==='selfQuiz');assert.equal(c.busy,false);
 }
});
