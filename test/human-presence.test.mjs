import test from 'node:test';
import assert from 'node:assert/strict';
import {automaticLightContext,parseLightNotes,applyAutomaticLight,DailyMemory} from '../bridge/daily-memory.js';
import {emptyEmotion,applyEmotionEvent,tickEmotion,emotionPromptLine} from '../bridge/emotion.js';
import {validateSemanticAppraisal,temperamentContext} from '../bridge/emotion-appraisal.mjs';
import {Continuity} from '../bridge/continuity.mjs';
const now=1800000000000;
const msg={id:'m1',userId:'123',text:'明天我想去公园，路线还没定。',time:now};
const note=(extra={})=>({source_id:'m1',quote:'明天我想去公园',topic:'确认明天去公园的路线',action:'open',target_id:'',ttlHours:12,confidence:.95,assessment:{subject:'self',mode:'asserted',sensitive:false},...extra});

test('automatic notes preserve sources, expire from original time, and duplicate or dismissed quotes never renew',()=>{
 const state={};const notes=parseLightNotes([note()],[msg]);applyAutomaticLight(state,notes,now);
 const row=state.autoTopics[0];assert.equal(row.sourceId,'m1');assert.equal(row.subjectId,'123');assert.equal(row.expiresAt,now+12*3600000);
 applyAutomaticLight(state,notes,now+10000);assert.equal(state.autoTopics.length,1);assert.equal(row.expiresAt,now+12*3600000);
 row.status='dismissed';applyAutomaticLight(state,parseLightNotes([note({source_id:'m2'})],[{...msg,id:'m2',time:now+10000}]),now+20000);
 assert.equal(automaticLightContext(state).length,0);assert.equal(row.status,'dismissed');
 const stale={};applyAutomaticLight(stale,notes,now+24*3600000);assert.equal(stale.autoTopics.length,0);assert.equal(stale.autoLightAudit[0].status,'expired');
});
test('quote attribution and target ownership are checked; exclusions cannot create personal notes',()=>{
 assert.throws(()=>parseLightNotes([note({quote:'没有说过'})],[msg]));
 assert.throws(()=>parseLightNotes([note({target_id:'someone-else'})],[msg],[{id:'someone-else',subjectId:'456'}]));
 for(const assessment of [{subject:'other',mode:'asserted',sensitive:false},{subject:'self',mode:'quoted',sensitive:false},{subject:'self',mode:'asserted',sensitive:true}]){
  const state={};applyAutomaticLight(state,parseLightNotes([note({assessment})],[msg]),now);assert.equal(state.autoTopics.length,0);
 }
});
test('completion closes the matching same-person note; late extraction cannot reopen manual dismissal',()=>{
 const state={};applyAutomaticLight(state,parseLightNotes([note()],[msg]),now);
 const id=state.autoTopics[0].id,context=automaticLightContext(state,now);
 const done={...msg,id:'done',text:'路线确认好了',time:now+1000};
 const ops=parseLightNotes([note({source_id:'done',target_id:id,quote:done.text,action:'close'})],[done],context);
 applyAutomaticLight(state,ops,now+2000);assert.equal(state.autoTopics[0].status,'closed');
 state.autoTopics[0].status='dismissed';const update=parseLightNotes([note({source_id:'later',target_id:id})],[{...msg,id:'later',time:now+3000}],context);
 applyAutomaticLight(state,update,now+4000);assert.equal(state.autoTopics[0].status,'dismissed');
});
test('real queue reuses extraction call for notes even with no durable facts, invalid notes preserve processing diagnostics',async t=>{
 let calls=0;const state={};
 const worker=new DailyMemory({load:()=>({queues:{'private:123':[msg]}}),save:()=>{},enabled:()=>true,allowed:()=>true,log:()=>{},request:async()=>({results:[]}),
 extract:async()=>{calls++;return JSON.stringify({items:[],completed_source_ids:['m1'],light_notes:[note()]})},
 verify:async()=>JSON.stringify({checks:[{source_id:'m1',status:'complete',missing_quotes:[],reason:'没有长期事实'}]}),
 lightContext:()=>[],onLightNotes:(_key,notes)=>applyAutomaticLight(state,notes,now)});
 t.after(()=>clearInterval(worker.timer));assert.equal((await worker.flush('private:123')).ok,true);assert.equal(calls,1);assert.equal(state.autoTopics.length,1);
 worker.state.queues['private:123']=[msg];worker.modelSignature=()=>({model:'changed-fixture'});worker.extract=async()=>JSON.stringify({items:[],completed_source_ids:['m1'],light_notes:[note({quote:'虚构原话'})]});
 assert.equal((await worker.flush('private:123')).ok,true);assert.match(worker.state.processing.at(-1).lightError,/近期便签/);assert.equal(state.autoTopics.length,1);
});
const feelingInput=(id,quote,kind='curiosity')=>({source:'owner',eventId:id,text:quote,appraisal:{kind:'uncertain',target:'unknown',confidence:.3,intensity:0,evidence:[],feelings:[{kind,intensity:.5,confidence:.9,reason:'分享一个新发现',evidence:quote}]}});
test('everyday feeling confidence is separate from uncertain relationship; no hostility, climate or invented baseline',()=>{
 let s=applyEmotionEvent(emptyEmotion(now),feelingInput('1','今天发现了一种新的咖啡做法'),now);
 assert.match(s.state.nuance,/好奇/);assert.equal(s.dynamics.conflict,0);assert.equal(s.relationshipSamples,0);
 assert.equal(s.state.feelings[0].eventId,'1');assert.match(emotionPromptLine(s,{isOwner:true}),/分享一个新发现/);
 assert.doesNotMatch(emotionPromptLine(s,{isOwner:false}),/新的咖啡做法/);
 const before=s.dailyFeelings.sources.curiosity.at;s=applyEmotionEvent(s,feelingInput('2','今天发现了一种新的咖啡做法'),now+60000);
 assert.equal(s.dailyFeelings.sources.curiosity.at,before);assert.ok(s.dailyFeelings.levels.curiosity<.36);
 assert.equal(tickEmotion(s,now+180*60000).state.nuance,'');
 assert.equal(validateSemanticAppraisal({...feelingInput('x','原话').appraisal,feelings:[{kind:'joy',intensity:.5,confidence:2,evidence:'原话'}]},'原话'),null);
});
test('continuity receives old feelings as context, not independent evidence',async()=>{
 let prompt='';const c=new Continuity({enabled:()=>true,allowed:()=>true,feelingContext:()=>[{kind:'curiosity',evidence:'旧原话'}],generate:async p=>{prompt=p;return JSON.stringify({summary:'普通消息',appraisal:{kind:'neutral',target:'none',confidence:.9,intensity:0,evidence:[]},concerns:[],beliefs:[],focusIds:[],relationship:{kind:'none',quote:''}})}});
 await c.observe('private:123',{text:'继续聊聊'},c.begin('private:123','m'));
 assert.match(prompt,/旧原话/);assert.match(prompt,/不能当新经历/);
});

test('temperament context uses only stable bounded dimensions, never transient mood or generated narrative',()=>{
 const p={spec:{dimensions:[{key:'warm',label:'温暖',desc:'冷到暖'},{key:'missing',label:'未知'}]},baseline:{warm:60},current:{warm:99},narrative:'不能作为新证据'};
 assert.deepEqual(temperamentContext(p),[{trait:'温暖',description:'冷到暖',baseline:60}]);assert.deepEqual(temperamentContext(null),[]);
});

test('explicit resolution settles its feeling, unrelated chat does not erase it',()=>{
 const initial=applyEmotionEvent(emptyEmotion(now),feelingInput('concern','明天面试有点紧张','concern'),now);
 const ordinary=applyEmotionEvent(initial,{source:'owner',eventId:'ordinary',text:'看下这段代码',appraisal:{kind:'neutral',target:'none',confidence:.95,intensity:0,evidence:[],feelings:[]}},now+1000);
 assert.match(ordinary.state.nuance,/牵挂/);
 const resolved=applyEmotionEvent(ordinary,{source:'owner',eventId:'resolved',text:'面试已经通过了，不用担心',appraisal:{kind:'neutral',target:'none',confidence:.95,intensity:0,evidence:[],feelings:[{kind:'concern',action:'settle',intensity:0,confidence:.95,evidence:'面试已经通过了，不用担心',reason:'明确完成了挂念的事'},{kind:'relief',intensity:.5,confidence:.95,evidence:'面试已经通过了',reason:'得到明确好结果'}]}},now+2000);
 assert.doesNotMatch(resolved.state.nuance,/牵挂/);assert.match(resolved.state.nuance,/安心/);assert.equal(resolved.relationshipSamples,0);
});
