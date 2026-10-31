import test from 'node:test';
import assert from 'node:assert/strict';
import {planSetup,setupFeatures,setupRevision,setupInitialPersona,canChooseStarter,growthStatus} from '../bridge/onboarding.mjs';
import {SelfReference} from '../bridge/self-reference.mjs';
const now=1800000000000;
const persona={spec:{dimensions:[{key:'warm',label:'温度',baseline:42,band:20}]},baseline:{warm:42},current:{warm:42}};
const file={ownerQQ:123,allow:{private:[123]},dsh:{model:'keep-model'},socialV2:{dailyMemory:{maxCallsPerDay:7},association:{cooldown:99}},privateOther:'preserve'};
const features={...setupFeatures(file),self:true,continuity:true};
const ctx={origin:{freshPersona:true},state:{claims:[],queue:[]},persona,ownerAllowed:true,now};
const body=()=>({revision:setupRevision(file),features,starter:[{key:'warm',value:55}]});
test('first setup is an immutable, narrow config plan; starter seeds only new state',()=>{
 const before=structuredClone(file),next=planSetup(file,body(),ctx);
 assert.deepEqual(file,before);assert.deepEqual(next.dsh,file.dsh);assert.deepEqual(next.allow,file.allow);
 assert.equal(next.socialV2.dailyMemory.maxCallsPerDay,7);assert.equal(next.socialV2.association.cooldown,99);assert.equal(next.privateOther,'preserve');
 const seed=setupInitialPersona(persona,next.xinjiSetup,null,ctx.origin);
 assert.equal(seed.current.warm,55);assert.equal(seed.baseline.warm,55);assert.equal(persona.current.warm,42);
 let saved;const self=new SelfReference({enabled:()=>true,allowed:()=>true,initialPersona:seed,save:s=>saved=s});
 assert.equal(saved.temperament.current.warm,55);
 const again=setupInitialPersona(persona,next.xinjiSetup,saved,ctx.origin);assert.equal(again,persona);
 const restored=new SelfReference({enabled:()=>true,allowed:()=>true,initialPersona:again,load:()=>saved});assert.equal(restored.state.temperament.current.warm,55);
});
test('existing profiles, queued sources and stale persona prevent starter replacement',()=>{
 for(const state of [{temperament:{}},{queue:[{}]},{claims:[{}]},{seen:[{}]},{revision:1}]){
  assert.equal(canChooseStarter(ctx.origin,state),false);
  assert.throws(()=>planSetup(file,body(),{...ctx,state}),/已有性格/);
 }
 assert.throws(()=>planSetup(file,body(),{...ctx,origin:{freshPersona:false}}),/已有性格/);
 const next=planSetup(file,body(),ctx),changed={...persona,current:{warm:43}};
 assert.equal(setupInitialPersona(changed,next.xinjiSetup,null,ctx.origin),changed);
 assert.equal(setupInitialPersona(persona,next.xinjiSetup,null,{freshPersona:false}),persona);
});
test('stale forms, malformed dimensions, dependencies and missing permission fail before write',()=>{
 assert.throws(()=>planSetup({...file,ownerQQ:456},body(),ctx),e=>e.statusCode===409);
 assert.throws(()=>planSetup(file,{...body(),features:{...features,continuity:false}},ctx),/连续事件/);
 assert.throws(()=>planSetup(file,{...body(),features:{...features,feeling:true}},ctx),/空闲联想/);
 assert.throws(()=>planSetup(file,body(),{...ctx,ownerAllowed:false}),/私聊/);
 assert.throws(()=>planSetup(file,{...body(),features:{...features,injected:true}},ctx),/不完整/);
 for(const starter of [[],[{key:'warm',value:101}],[{key:'unknown',value:1}],[{key:'warm',value:2.5}]])assert.throws(()=>planSetup(file,{...body(),starter},ctx),/倾向/);
});
test('keeping the current starter cancels a pending choice, existing settings remain opt-in',()=>{
 const next=planSetup(file,body(),ctx);
 const reverted=planSetup(next,{revision:setupRevision(next),features,starter:null},ctx);
 assert.equal(reverted.xinjiSetup.starter,undefined);
 const existing=planSetup(file,{revision:setupRevision(file),features:setupFeatures(file),starter:null},{...ctx,origin:{freshPersona:false}});
 assert.equal(existing.socialV2.selfReference.enabled,false);assert.equal(existing.socialV2.continuity.enabled,false);
});
test('growth explains disabled, blocked, empty, accumulation, cooldown and failure honestly',()=>{
 const cfg=planSetup(file,body(),ctx),base={cfg,state:{queue:[],claims:[]},ownerAllowed:true,now};
 assert.equal(growthStatus({...base,cfg:file}).kind,'disabled');
 assert.equal(growthStatus({...base,ownerAllowed:false}).kind,'blocked');
 assert.equal(growthStatus(base).kind,'empty');
 assert.equal(growthStatus({...base,paused:true}).kind,'paused');
 assert.equal(growthStatus({...base,state:{queue:Array(11).fill({})}}).kind,'accumulating');
 assert.equal(growthStatus({...base,state:{queue:Array(12).fill({}),lastAttempt:now-1000}}).kind,'cooldown');
 assert.equal(growthStatus({...base,state:{queue:Array(12).fill({})}}).kind,'queued');
 assert.equal(growthStatus({...base,state:{queue:[{}],lastReview:{status:'failed'}}}).kind,'failed');
});
test('review failure is visible, preserves originals, and never records provider secrets',async()=>{
 let saved;const self=new SelfReference({enabled:()=>true,allowed:()=>true,now:()=>now,save:s=>saved=s,generate:async()=>{throw Error('private-provider-secret')}});
 for(let i=0;i<12;i++)self.observe('private:1',{id:String(i),at:now,source:'user',original:'独立原话 '+i});
 await assert.rejects(self.consolidate(),/private-provider-secret/);
 assert.equal(saved.lastReview.status,'failed');assert.equal(saved.queue.length,12);assert.equal(JSON.stringify(saved).includes('private-provider-secret'),false);
 self.generate=async()=>'{"changes":[]}';await self.consolidate({force:true});assert.equal(saved.lastReview.status,'complete');assert.equal(saved.queue.length,0);
});
