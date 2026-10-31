import test from 'node:test';
import assert from 'node:assert/strict';
import {ResponsePatterns,learningInstruction} from '../bridge/response-patterns.mjs';
import {Continuity} from '../bridge/continuity.mjs';
const DAY=86400000,key='private:123';
function fixture(){let now=30*DAY,enabled=true,saved=null;const p=new ResponsePatterns({allowed:k=>k===key,enabled:()=>enabled,now:()=>now,save:x=>saved=structuredClone(x)});return {p,advance:n=>now+=n,disable:()=>enabled=false,get saved(){return saved},get now(){return now},add:(i,patch={},source={})=>{const quote=`第${i}次对话先简短回答更合适`;p.observe(key,[{strategy:'concise_first',outcome:'helpful',experienceId:'',evidenceKind:'new',quote,confidence:.96,...patch}],{id:'m'+i,at:now,original:patch.quote||quote,source:'user',...source});}};}
test('isolated explicit feedback requires three independent days; repeat, uncertain, source and quote dedup never renew',()=>{
 const f=fixture();f.add(1);const first=f.p.view(key).evidence[0].at;
 f.advance(DAY);f.add(1);f.add(2,{evidenceKind:'repeat',experienceId:'old'});f.add(3,{evidenceKind:'uncertain'});
 assert.equal(f.p.view(key).evidence.length,1);assert.equal(f.p.view(key).evidence[0].at,first);
 f.add(4);assert.equal(f.p.view(key).strategies[1].status,'trial');assert.equal(f.p.candidates(key,'neutral').length,1);f.advance(DAY);f.add(5);assert.equal(f.p.candidates(key,'neutral').length,1);assert.equal(f.p.candidates(key,'user_distress').length,0);
 f.add(6,{outcome:'unhelpful'});assert.equal(f.p.view(key).strategies[1].status,'contradicted');assert.equal(f.p.candidates(key,'neutral').length,0);
});
test('same-day flood, ordinary no-feedback chat, assistant and synthetic lessons cannot promote',()=>{
 const f=fixture();for(let i=0;i<5;i++)f.add(i);assert.equal(f.p.view(key).strategies[1].positiveDays,1);assert.equal(f.p.view(key).strategies[1].status,'trial');assert.equal(f.p.candidates(key,'neutral').length,1);
 const before=f.p.view(key).evidence.length;f.add(10,{}, {source:'assistant'});f.add(11,{}, {source:'simulation'});f.add(12,{}, {current:false});f.add(13,{confidence:.5});f.add(14,{}, {original:'今天有点累'});
 f.p.observe(key,[],{id:'plain',at:f.now,original:'今天聊得挺久',source:'user'});assert.equal(f.p.view(key).evidence.length,before);
 assert.match(learningInstruction([]),/说自己累/);assert.match(learningInstruction([]),/不同日期重述同一件事也不是new/);
});
test('revocation tombstones survive restart; disable/resume and fading prevent unwanted prompt influence',()=>{
 const f=fixture();for(let i=0;i<3;i++){f.add(i);f.advance(DAY);}
 assert.equal(f.p.candidates(key,'neutral').length,1);f.p.edit(key,{action:'disable',id:'concise_first'});assert.equal(f.p.candidates(key,'neutral').length,0);
 f.p.edit(key,{action:'resume',id:'concise_first'});assert.equal(f.p.candidates(key,'neutral').length,1);
 const evidence=f.p.view(key).evidence[0];f.p.edit(key,{action:'revoke',id:evidence.id});f.add(0);assert.equal(f.p.view(key).evidence.length,3);assert.equal(f.p.view(key).strategies[1].status,'trial');
 const loaded=new ResponsePatterns({allowed:k=>k===key,enabled:()=>true,now:()=>f.now,load:()=>f.saved});assert.equal(loaded.view(key).evidence[0].revoked,true);assert.equal(loaded.view('group:123').evidence.length,0);
 f.advance(31*DAY);assert.equal(f.p.view(key).strategies[1].status,'fading');f.disable();assert.equal(f.p.context(key),null);
});
test('malformed operations and storage problems are bounded and observable',()=>{
 const f=fixture();f.add(1,{strategy:'unbounded-invented-trait'});f.add(2,{quote:'x'.repeat(201)});f.add(3,{confidence:Infinity});assert.equal(f.p.view(key).evidence.length,0);
 for(let i=0;i<100;i++)f.add(i);assert.equal(f.p.view(key).evidence.length,96);assert.equal(f.p.view(key).capacity,true);assert.ok(f.p.view(key).audit.length<=80);
 const p=new ResponsePatterns({allowed:()=>true,enabled:()=>true,load:()=>{throw Error('disk')}});assert.equal(p.view(key).storageError,true);
});

test('real event-understanding hook shares one call and ignores superseded or invalid learning',async()=>{
 let calls=0,prompt='',release;
 const p=new ResponsePatterns({allowed:k=>k===key,enabled:()=>true});
 const quote='这次先简短回答很有帮助';
 const event={summary:'用户评价回应方式',appraisal:{kind:'neutral',target:'none',confidence:.95,intensity:0,evidence:[]},concerns:[],beliefs:[],focusIds:[],relationship:{kind:'none',quote:''},learning:[{strategy:'concise_first',outcome:'helpful',experienceId:'',evidenceKind:'new',quote,confidence:.99}]};
 const c=new Continuity({allowed:k=>k===key,enabled:()=>true,learningContext:k=>p.context(k),onLearning:(k,ops,source)=>p.observe(k,ops,source),generate:async s=>{calls++;prompt=s;return JSON.stringify(event)}});
 await c.observe(key,{text:quote},c.begin(key,'one'));assert.equal(calls,1);assert.match(prompt,/可选 learning/);assert.equal(p.view(key).evidence.length,1);
 c.generate=async()=>new Promise(r=>release=r);const pending=c.observe(key,{text:quote},c.begin(key,'two'));await new Promise(r=>setImmediate(r));c.invalidate();release(JSON.stringify(event));await pending;assert.equal(p.view(key).evidence.length,1);
 c.generate=async()=>JSON.stringify({...event,learning:[{...event.learning[0],quote:'不存在的原话'}]});
 const result=await c.observe(key,{text:'今天再聊聊'},c.begin(key,'three'));assert.ok(result);assert.equal(p.view(key).evidence.length,1);
});

test('moderate confidence permits only a temporary trial, never accumulates long-term votes',()=>{
 const f=fixture();f.add(0,{confidence:.8});assert.equal(f.p.view(key).strategies[1].status,'trial');
 assert.equal(f.p.candidates(key,'neutral').length,1);assert.equal(f.p.view(key).strategies[1].positiveDays,0);
 f.advance(2*DAY+1);assert.equal(f.p.candidates(key,'neutral').length,0);
 for(let i=1;i<5;i++){f.add(i,{confidence:.8});f.advance(DAY);}
 assert.notEqual(f.p.view(key).strategies[1].status,'active');assert.equal(f.p.view(key).strategies[1].positiveDays,0);
 f.add(10,{outcome:'unhelpful',confidence:.8});assert.equal(f.p.candidates(key,'neutral').length,0);
 f.add(11,{confidence:.5});assert.match(f.p.view(key).audit.at(-1).reason,/0.75/);
});

test('explicit expression requests can enter this turn without training habits, and newer requests supersede older ones',()=>{
 const f=fixture(),quote='请说短一点，别讲大道理';
 const op={kind:'response_style',instruction:'简短自然地表达',quote,explicit:true,confidence:.95};
 const source={id:'a',at:f.now,original:quote,source:'user'};
 f.p.adjust(key,[op],source);const first=f.p.view(key).adjustments[0];
 assert.equal(f.p.candidates(key,'neutral')[0].type,'preference');assert.equal(f.p.view(key).evidence.length,0);
 f.advance(1000);f.p.adjust(key,[op],{...source,id:'copy',at:f.now});assert.equal(f.p.view(key).adjustments[0].expiresAt,first.expiresAt);
 f.p.adjust('group:123',[op],source);assert.equal(f.p.view('group:123').evidence.length,0);
 f.p.adjust(key,[{...op,quote:'不是原话'}],{...source,id:'bad',at:f.now});assert.equal(f.p.view(key).adjustments.length,1);
 const quote2='这次展开说，详细一点';f.p.adjust(key,[{...op,instruction:'详细说明',quote:quote2}],{...source,id:'b',at:f.now,original:quote2});
 assert.equal(f.p.view(key).adjustments.length,1);assert.equal(f.p.view(key).adjustments[0].instruction,'详细说明');
 const loaded=new ResponsePatterns({allowed:k=>k===key,enabled:()=>true,now:()=>f.now,load:()=>f.saved});
 loaded.edit(key,{action:'dismiss-adjustment',id:loaded.view(key).adjustments[0].id});assert.equal(loaded.candidates(key,'neutral').length,0);
 f.advance(DAY);assert.equal(f.p.candidates(key,'neutral').length,0);
});

test('invalid feedback records a specific reason without inventing an accepted experience',()=>{
 const f=fixture();f.add(1,{experienceId:undefined});assert.equal(f.p.view(key).evidence.length,0);assert.match(f.p.view(key).audit.at(-1).reason,/独立经历/);
 f.add(2,{quote:'不在原话里'}, {original:'今天有点累'});assert.match(f.p.view(key).audit.at(-1).reason,/引用/);
});
