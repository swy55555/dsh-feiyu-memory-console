import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {EmotionScopes,emotionScope} from '../bridge/emotion-scopes.mjs';
import * as emotion from '../bridge/emotion.js';
const now=Date.now();
const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
const fragment=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
function event(key,id,text='你是废物',speaker='2'){
 return {key,chatKey:key,eventId:id,messageId:id,speakerId:speaker,text,source:key==='private:1'?'owner':'private',directed:true,weight:1,at:now,recentMessages:[]};
}
test('mood is shared fully while attitude, causes and relationship conflict remain with their subject',()=>{
 const lanes=new EmotionScopes({ownerKey:'private:1',now:()=>now});
 for(const key of ['private:2','group:9']){
  const scope=emotionScope(key,'2');
  const e=event(key,'conflict-'+key);
  lanes.set(scope,emotion.applyEmotionEvent(lanes.get(scope),e,now));
  assert.ok(lanes.get(scope).dynamics.conflict>0);
  const once=lanes.sharedAt();assert.deepEqual(lanes.sharedAt(),once);
 }
 for(const [key,speaker] of [['private:1','1'],['private:3','3'],['group:9','3'],['group:9','']]){
  const view=lanes.view(key,speaker,now);
  assert.equal(view.dynamics.conflict,0);assert.equal(view.lastCause,null);assert.equal(view.triggers.length,0);
  assert.ok(view.state.valence<lanes.baseline.valence);
  assert.equal(view.state.valence,lanes.view('private:2','2',now).state.valence);
  assert.equal(view.state.arousal,lanes.view('private:2','2',now).state.arousal);
  assert.equal(view.stance,'正常交流');
  assert.equal(view.scopeInfo.moodShared,true);
  assert.deepEqual(emotion.tickEmotion(view,now).state,view.state);
  assert.deepEqual(emotion.tickEmotion(view,now).localMood,view.localMood);
  const prompt=emotion.emotionPromptLine(view,{isOwner:true});
  assert.ok(!prompt.includes('你是废物'));assert.match(prompt,/不把他人的冲突归罪于当前说话人/);
  assert.equal(emotion.emotionSummary(view).scopeInfo.isolated,true);
 }
 assert.ok(Math.abs(lanes.sharedAt(now+7200000).valence-lanes.baseline.valence)<Math.abs(lanes.sharedAt(now).valence-lanes.baseline.valence));
 lanes.set('private:2',lanes.fresh(now));lanes.set('group:9/member:2',lanes.fresh(now));
 assert.equal(lanes.view('private:1','1',now).state.valence,lanes.baseline.valence);
});
test('migration rebuilds attributable journal only and preserves personality audit; persisted lanes survive restart',()=>{
 let legacy=emotion.emptyEmotion(now);
 legacy=emotion.applyEmotionEvent(legacy,event('private:2','foreign'),now);
 legacy.drifts=[{id:'old-drift'}];legacy.lastDriftAt=now;
 let disk;
 const lanes=new EmotionScopes({ownerKey:'private:1',legacy,now:()=>now,save:x=>disk=structuredClone(x)});
 assert.equal(lanes.owner().dynamics.conflict,0);
 assert.ok(lanes.get('private:2').dynamics.conflict>0);
 assert.deepEqual(lanes.owner().drifts,legacy.drifts);
 lanes.persist();
 const restored=new EmotionScopes({ownerKey:'private:1',legacy,load:()=>disk,now:()=>now});
 assert.equal(restored.migrated,false);assert.deepEqual(restored.get('private:2'),lanes.get('private:2'));
 const unknown={...legacy,journal:null};
 assert.equal(new EmotionScopes({ownerKey:'private:1',legacy:unknown,now:()=>now}).owner().dynamics.conflict,0);
});
test('late model failure never replaces a newer event; another scope does not cancel an owner review',async()=>{
 for(const newer of [true,false]){
  const lanes=new EmotionScopes({ownerKey:'private:1',now:()=>now});
  const input=event('private:1','first','抱抱','1'), before=lanes.get('private:1');
  lanes.set('private:1',emotion.applyEmotionEvent(before,input,now));
  let finish;
  const ctx=vm.createContext({...emotion,emotionScope,emotionLanes:lanes,path,STATE_DIR:'fixture',
   cfg:{socialV2:{emotion:{appraisalModel:{enabled:true}}}},commitEmotionLane:(k,s)=>lanes.set(k,s),
   emotionRecoveryCfg:()=>({}),reserveAppraisal:()=>({ok:true,count:1}),appraisalContext:()=>({}),log:()=>{},
   runHeadlessPrompt:()=>new Promise(resolve=>finish=resolve)});
  const fn=vm.runInContext(fragment('  async function refineEmotionWithModel(','  const emotionTimer =')+';refineEmotionWithModel',ctx);
  const pending=fn(input,lanes.get('private:1').lastEvent,before);
  const key=newer?'private:1':'private:2';
  lanes.set(key,emotion.applyEmotionEvent(lanes.get(key),event(key,'second'),now+1));
  const snapshot=structuredClone(lanes.get(key));
  finish(newer?'invalid':JSON.stringify({kind:'affection',target:'character',confidence:.95,intensity:.5,evidence:['抱抱']}));
  await pending;
  assert.deepEqual(lanes.get(key),snapshot);
  if(!newer)assert.equal(lanes.get('private:1').lastEvent.review.status,'reviewed');
 }
});
test('legacy spillover is not consumed and group-wide episode prompt cannot inherit member causes',()=>{
 const take=vm.runInNewContext(fragment('  function takeSpillover()','  function emotionRecoveryCfg()')+';takeSpillover');
 assert.equal(take(),null);
 const ctx=vm.createContext({cfg:{socialV2:{emotion:{episodeRecall:{enabled:true}}}}});
 const body=fragment('  function episodeRecallBlock(key)','  function personaBlockFor(');
 const fn=vm.runInContext(body+';episodeRecallBlock',ctx);
 assert.equal(fn('group:9'),'');
});
test('sharing route denies model/agent requests and rejects destinations outside access rules',async()=>{
 const route=fragment("        if (url.pathname === '/api/memory/sharing')", "        if (req.method === 'POST' && url.pathname === '/api/memory/fact-review')");
 assert.ok(route.length>0&&route.length<4000);
 async function call(headers={},allowed=true){
  let result,calls=0;
  const ctx=vm.createContext({url:{pathname:'/api/memory/sharing'},req:{method:'POST',headers},
   readBody:async()=>({action:'grant',target_scope:'group:9'}),isSessionAllowedInCurrentMode:()=>allowed,
   memoryRequest:async()=>{calls++;return {ok:true}},sendJson:(data,status=200)=>result={data,status}});
  await vm.runInContext('(async()=>{'+route+'})()',ctx);return {...result,calls};
 }
 assert.equal((await call({'x-agent-call':'1'})).status,403);
 assert.equal((await call({'x-agent-token':'test'})).calls,0);
 assert.equal((await call({},false)).status,403);
 assert.equal((await call()).calls,1);
});
