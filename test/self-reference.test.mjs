import {test} from 'node:test';
import assert from 'node:assert/strict';
import {SelfReference,SELF_FOUNDATION,selfReferencePrompt} from '../bridge/self-reference.mjs';
import {seedTemperament,growTemperament} from '../bridge/self-temperament.mjs';
const DAY=86400000,now=1800000000000;
function setup(){let time=now,saved;const ref=new SelfReference({allowed:k=>k==='private:1',enabled:()=>true,now:()=>time,save:s=>saved=s,generate:async()=>'{"changes":[]}'});return {ref,setTime:v=>time=v,saved:()=>saved};}
const row={id:'u1',at:now,text:'你认真听我说话的时候很好，不用总是嘴硬。'};
const op=(id='',extra={})=>({id,action:'upsert',category:'trait',text:'我正在学着认真倾听，不必总用嘴硬回应。',evidence:[{id:'u1',quote:'不用总是嘴硬'}],experience:'对倾听和嘴硬的反馈',confidence:.98,...extra});
test('only original owner messages enter queue; repeated words do not renew',()=>{const {ref}=setup();assert.equal(ref.observe('group:1',{id:'a',at:now,original:row.text,source:'user'}),false);assert.equal(ref.observe('private:1',{id:'a',at:now,original:row.text,source:'assistant'}),false);assert.equal(ref.observe('private:1',{id:'a',at:now,original:row.text,source:'user'}),true);assert.equal(ref.observe('private:1',{id:'b',at:now+1,original:row.text,source:'user'}),false);});
test('invalid evidence and stale results are atomic',()=>{const {ref}=setup();assert.throws(()=>ref.apply({changes:[op(),op('',{text:'另一条',evidence:[{id:'fake',quote:'不存在'}]})]},[row]));assert.equal(ref.state.claims.length,0);assert.throws(()=>ref.apply({changes:[op()]},[row],99));});
test('private data never enters another chat; time fades without erasing',()=>{const {ref,setTime}=setup();ref.apply({changes:[op()]},[row]);assert.match(ref.render('private:1'),/认真倾听/);assert.equal(ref.render('group:1').includes('认真倾听'),false);setTime(now+31*DAY);assert.equal(ref.view().claims[0].status,'fading');setTime(now+91*DAY);assert.equal(ref.view().claims[0].status,'dormant');assert.equal(ref.render('private:1').includes('认真倾听'),false);assert.equal(ref.state.claims.length,1);});
test('repeat experience and exact source do not advance expiry',()=>{const {ref}=setup();ref.apply({changes:[op()]},[row]);const id=ref.state.claims[0].id;ref.apply({changes:[op(id)]},[{...row,at:now+DAY}]);assert.equal(ref.state.claims[0].lastEvidenceAt,now);ref.apply({changes:[op(id,{evidence:[{id:'u2',quote:'你上次听我说话'}]})]},[{id:'u2',text:'你上次听我说话这件事我又说了一遍',at:now+DAY}]);assert.equal(ref.state.claims[0].lastEvidenceAt,now);});
test('multiple independent days support a revisable reference',()=>{const {ref,setTime}=setup();ref.apply({changes:[op()]},[row]);const id=ref.state.claims[0].id;for(let i=1;i<3;i++){setTime(now+i*DAY);const r={id:'n'+i,at:now+i*DAY,text:'这次第'+i+'件事你认真听很好'};ref.apply({changes:[op(id,{evidence:[{id:r.id,quote:r.text}],experience:'第'+i+'件独立经历'})]},[r]);}assert.equal(ref.view().claims[0].status,'supported');});
test('retraction and restore create history without changing source records',()=>{const {ref}=setup();ref.apply({changes:[op()]},[row]);ref.retract(ref.state.claims[0].id);assert.equal(ref.view().claims[0].status,'retracted');ref.restore(1);assert.equal(ref.view().claims[0].status,'tentative');assert.equal(ref.state.revision,3);assert.equal(row.text,'你认真听我说话的时候很好，不用总是嘴硬。');});
test('automatic batches back off; failure retains queue',async()=>{const {ref,setTime}=setup();for(let i=0;i<12;i++)ref.observe('private:1',{id:'n'+i,at:now,original:'新的具体交流 '+i,source:'user'});let calls=0;ref.generate=async()=>{calls++;throw Error('network');};await assert.rejects(ref.consolidate());assert.equal(ref.state.queue.length,12);await ref.consolidate();assert.equal(calls,1);setTime(now+7*3600000);ref.generate=async()=>'{"changes":[]}';await ref.consolidate();assert.equal(ref.state.queue.length,0);});
test('foundation is separate from profile data and does not prescribe a biological backstory',()=>{assert.match(SELF_FOUNDATION,/不编造现实肉身/);assert.match(selfReferencePrompt({claims:[]},[row]),/不是给用户画像/);});

const initial={spec:{dimensions:[{key:'warm',label:'温度',desc:'冷到暖',baseline:42,band:20}]},current:{warm:42},baseline:{warm:42}};
test('three independent days grow one point, not three; repetitions and cooldown cannot grow again',()=>{
 let p=seedTemperament(initial);
 const evidence=i=>({op:{dimensionDeltas:{warm:1},action:'upsert',confidence:.95,experience:'独立经历'+i},evidence:[{id:'e'+i,fp:'fp'+i,at:now+i*DAY}]});
 for(let i=0;i<3;i++)p=growTemperament(p,[evidence(i)],now+i*DAY);
 assert.equal(p.current.warm,43);assert.equal(p.history.length,1);
 for(let i=0;i<3;i++)p=growTemperament(p,[evidence(i)],now+10*DAY);
 assert.equal(p.current.warm,43);assert.equal(p.receipts.length,3);
 for(let i=3;i<6;i++)p=growTemperament(p,[evidence(i)],now+i*DAY);
 assert.equal(p.current.warm,43);p=growTemperament(p,[],now+10*DAY);assert.equal(p.current.warm,44);
 assert.equal(initial.current.warm,42);
});
test('joint persistence failure is atomic; edits invalidate pending model results; restore retains consumed evidence',()=>{
 let fail=false;const ref=new SelfReference({enabled:()=>true,allowed:k=>k==='private:1',initialPersona:initial,save:()=>{if(fail)throw Error('disk');},now:()=>now});
 const proposal={changes:[op('',{dimensionDeltas:{warm:1}})]};fail=true;
 assert.throws(()=>ref.apply(proposal,[row]),/disk/);assert.equal(ref.state.claims.length,0);assert.equal(ref.state.temperament.receipts.length,0);
 fail=false;ref.apply(proposal,[row]);assert.match(ref.render('private:1'),/缓慢变化的性格/);assert.doesNotMatch(ref.render('group:1'),/缓慢变化的性格/);
 ref.editTemperament([{key:'warm',current:50,baseline:48,band:10}],'修正起点',1);
 assert.throws(()=>ref.apply(proposal,[row],1),/过期/);assert.equal(ref.state.temperament.current.warm,50);
 ref.restore(1);assert.equal(ref.state.temperament.current.warm,42);assert.equal(ref.state.temperament.receipts.length,1);
 assert.throws(()=>ref.editTemperament([{key:'warm',current:90,baseline:40,band:10}],'越界',ref.state.revision),/无效/);
});
test('malformed dimension proposal cannot partially save valid text',()=>{
 const ref=new SelfReference({enabled:()=>true,allowed:()=>true,initialPersona:initial});
 assert.throws(()=>ref.apply({changes:[op('',{dimensionDeltas:{warm:99}})]},[row]),/无效/);assert.equal(ref.state.claims.length,0);
});
