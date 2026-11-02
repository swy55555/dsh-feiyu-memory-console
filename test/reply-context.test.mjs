import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {replyReference,allowOptionalNudges,contextualRecall,recallForCurrentContext} from '../bridge/reply-context.mjs';
import {Continuity} from '../bridge/continuity.mjs';
import {buildHumanContext} from '../bridge/human-context.mjs';
import {emotionAttribution} from '../bridge/emotion.js';
import {interactionReplyGuide} from '../bridge/interaction-context.mjs';
const interaction={intent:'feedback',focus:'repair',boundary:'none',meaning:'当前希望讨论未解决的表达问题',quote:'不要转移话题'};
const message={seq:2,messageId:'b',isSelf:false};
const args={messages:[message],latestSeq:2,current:{messageId:'b',interaction},emotion:'紧绷',preferences:[{instruction:'自然说话',quote:'别像汇报'}]};

test('references accompany the exact offered message; old pages and newer pending understanding cannot leak',()=>{
 const before=structuredClone(args),r=replyReference(args);
 assert.equal(r.status,'ready');assert.equal(r.messageSeq,2);assert.equal(r.interaction.meaning,interaction.meaning);assert.equal(r.emotion,'紧绷');assert.deepEqual(args,before);
 assert.equal(r.replyGuide,interactionReplyGuide(interaction));
 assert.deepEqual(replyReference(args),r);
 for(const patch of [{latestSeq:3},{current:{messageId:'c',interaction}},{current:null},{messages:[{...message,messageId:null}]}]){
  const stale=replyReference({...args,...patch});assert.equal(stale.status,'unavailable');assert.ok(!stale.interaction&&!stale.emotion&&!stale.requests&&!stale.replyGuide);
 }
 assert.equal(replyReference({...args,messages:[]}),undefined);
 assert.equal(replyReference({...args,messages:[{...message,isSelf:true}]}),undefined);
 assert.ok(JSON.stringify(replyReference({...args,preferences:Array(3).fill({instruction:'字'.repeat(140),quote:'字'.repeat(200)})})).length<1900);
});

test('wait references carry verified repair evidence as data and keep the whole reference bounded',()=>{
 const contextEvidence=[{id:'a',role:'assistant',quote:'你逼得我不知道怎么说了'},{id:'u',role:'user',quote:'我只是指出你的说法，不是不让你有意见'}];
 const input={...args,current:{messageId:'b',interaction:{...interaction,contextEvidence}}};
 const r=replyReference(input);assert.deepEqual(r.interaction.contextEvidence,contextEvidence);
 assert.ok(!r.replyGuide.includes(contextEvidence[0].quote));
 r.interaction.contextEvidence[0].quote='changed';assert.notEqual(contextEvidence[0].quote,'changed');
 const large=replyReference({...input,emotion:'字'.repeat(800),preferences:Array(3).fill({instruction:'字'.repeat(140),quote:'字'.repeat(200)})});
 assert.ok(JSON.stringify(large).length<1900);assert.equal(large.replyGuide,interactionReplyGuide(interaction));
 const paused=replyReference({...input,current:{messageId:'b',interaction:{...interaction,boundary:'stop'}}});assert.match(paused.replyGuide,/不要回复/);
});

test('continuity reply state expires, is invalidated by new input, and never calls a model or persists',()=>{
 let now=1000000,calls=0;
 const c=new Continuity({allowed:k=>k==='private:1',enabled:()=>true,now:()=>now,save:()=>{calls++},generate:()=>{calls++}});
 const t=c.begin('private:1','b');assert.equal(c.replyState('private:1'),null);
 t.eventId='event';t.interaction=interaction;
 const state=c.replyState('private:1');assert.equal(state.messageId,'b');state.interaction.meaning='modified';assert.notEqual(c.replyState('private:1').interaction.meaning,'modified');
 assert.equal(c.replyState('private:2'),null);now+=120001;assert.equal(c.replyState('private:1'),null);
 now-=120001;c.begin('private:1','next');assert.equal(c.replyState('private:1'),null);assert.equal(calls,0);
});

test('feedback, requests, support and boundaries suppress optional nudges without classifying words',()=>{
 for(const intent of ['feedback','support','request','disengage','uncertain'])assert.equal(allowOptionalNudges({styleIntent:intent,styleBoundary:'none'}),false);
 for(const boundary of ['pause','stop','uncertain'])assert.equal(allowOptionalNudges({styleIntent:'play',styleBoundary:boundary}),false);
 assert.equal(allowOptionalNudges({requireUnderstanding:true}),false);
 assert.equal(allowOptionalNudges({styleIntent:'play',styleBoundary:'none'}),true);
 assert.equal(allowOptionalNudges({styleIntent:'share',styleBoundary:'none'}),true);
 assert.equal(allowOptionalNudges({}),true); // Existing group path has no private interpretation.
});

test('feedback defers contextless old instructions without deleting records or relying on a phrase list',()=>{
 const rows=[{id:'a',text:'任意旧许可',sourceContextStatus:'unavailable'},{id:'b',text:'有上下文',sourceContextStatus:'matched'}];
 assert.deepEqual(recallForCurrentContext(rows,{styleIntent:'feedback'}),[rows[1]]);
 assert.equal(recallForCurrentContext(rows,{styleIntent:'share'}),rows);assert.equal(rows.length,2);
});

test('source context verifies exact same-chat speaker and quote; shared records never fetch source chat',async()=>{
 const row={id:'m',scope:'private:1',subject_id:'1',score:.9,text:'当时允许开玩笑',memory_kind:'experience',evidence:{sourceId:'s',sourceText:'骂我就好',sourceTime:1000000}};
 let calls=0;
 const request=async(route,body)=>{calls++;assert.equal(route,'/messages');assert.equal(body.key,'private:1');return {messages:[{message_id:'p',user_id:'1',text:'我们开玩笑呢',at:999000,is_self:0},{message_id:'s',user_id:'1',text:'骂我就好',at:1000000,is_self:0},{message_id:'n',user_id:'1',text:'认真说事情时别这样',at:1001000,is_self:0}]}};
 const [result,shared]=await contextualRecall('private:1',[row,{...row,id:'shared',scope:'group:3',shared:true}],request);
 assert.equal(calls,1);assert.equal(result.sourceQuote,'骂我就好');assert.equal(result.sourceContextStatus,'matched');assert.equal(result.sourceContext.length,3);assert.ok(!shared.sourceContext);
 const context=buildHumanContext({key:'private:1',subjectId:'1',searchRows:[result],options:{maxChars:2400}});assert.ok(context.includes('我们开玩笑呢'));assert.ok(context.includes('认真说事情时别这样'));
 assert.ok(!row.sourceContext);
 const wrong=await contextualRecall('private:1',[row],async()=>({messages:[{message_id:'s',user_id:'2',text:'骂我就好',at:1000000}]}));assert.equal(wrong[0].sourceContextStatus,'source-not-matched');assert.ok(!wrong[0].sourceQuote);
 const failed=await contextualRecall('private:1',[row],async()=>{throw Error('offline')});assert.equal(failed[0].sourceContextStatus,'unavailable');assert.ok(!failed[0].sourceContext);
});

test('actual bridge wrapper denies cross-chat relay and uses only matching emotion event',()=>{
 const src=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');const start=src.indexOf('  function responseReferenceV2('),end=src.indexOf('  function noteModelMessagesV2(',start);
 const ctx=vm.createContext({replyReference,emotionAttribution,agentTokenOk:(k,t)=>k==='private:1'&&t==='owner',mindWorkspaceEnabled:k=>k==='private:1',continuity:{replyState:()=>args.current},cfg:{ownerQQ:'1',socialV2:{}},emotionViewFor:()=>({latestEventId:'private:1/1/b',state:{displayLabel:'紧绷',feelings:[],intensity:.2},stance:'正常交流'}),responsePatterns:{enabled:()=>true,view:()=>({adjustments:args.preferences})}});
 const fn=vm.runInContext(src.slice(start,end)+';responseReferenceV2',ctx),st={lastUnreadSeq:2};
 assert.equal(fn('private:1',st,[message],'other'),undefined);assert.equal(fn('private:2',st,[message],'owner'),undefined);
 const r=fn('private:1',st,[message],'owner');assert.equal(r.status,'ready');assert.ok(r.emotion.includes('紧绷'));
 assert.equal(fn('private:1',{lastUnreadSeq:3},[message],'owner').status,'unavailable');
 assert.ok(src.includes('replyReference: responseReferenceV2(key, st, newMessages'));
 assert.equal((src.match(/replyReference: responseReferenceV2\(key, st, messages/g)||[]).length,2);
 assert.equal((src.match(/if \(allowOptionalNudges\(traceContext\)\)/g)||[]).length,2);
});

test('feedback omits unscoped lightweight impressions but keeps stored notes and ordinary rendering',()=>{
 const src=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8'),start=src.indexOf('  function formatMemoryV2('),end=src.indexOf('  function appendMemoryV2(',start);
 const fn=vm.runInNewContext(src.slice(start,end)+';formatMemoryV2',{automaticLightContext:()=>[]});
 const st={activeTopics:[{text:'以前的许可：随便怼',lastMentionAt:Date.now()}]};const before=structuredClone(st);
 assert.ok(!fn(st,{feedback:true}).includes('随便怼'));assert.ok(fn(st).includes('随便怼'));assert.deepEqual(st,before);
});
