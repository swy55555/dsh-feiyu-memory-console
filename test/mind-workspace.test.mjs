import test from 'node:test';
import assert from 'node:assert/strict';
import {MindWorkspace} from '../bridge/mind-workspace.mjs';
import {IdleAssociations} from '../bridge/idle-association.mjs';
const key='private:123';
const memory=(id,score=.8,text='历史表述 '+id)=>({id,type:'memory',score,text,evidenceIds:[id]});
test('bounded selection preserves whole statements, provenance, highest-ranked duplicates and type quotas',()=>{
 const w=new MindWorkspace({allowed:k=>k===key,enabled:()=>true,budgetChars:1200});w.begin(key,'m');
 const rows=[memory('a',.4),memory('a',.95),memory('b'),memory('c'),{id:'belief',type:'belief',score:.5,text:'只是可能的理解'},memory('huge',1,'条件'.repeat(1000)),{id:'low',type:'concern',score:.1,text:'无关'}];
 const result=w.compose(key,rows,{continuityMessageId:'m'}),s=w.snapshot(key);
 assert.ok(result.text.length<=1200);assert.equal(result.selected.find(r=>r.id==='a').score,.95);assert.equal(result.selected.filter(r=>r.type==='memory').length,2);
 assert.match(result.text,/待验证认识/);assert.match(result.text,/计划不代表已经发生/);assert.ok(s.deferred.some(r=>r.id==='huge'&&r.reason.includes('预算')));assert.ok(s.deferred.some(r=>r.id==='low'));
 assert.equal(s.usedChars,result.text.length);assert.equal(w.compose('group:123',rows,{continuityMessageId:'m'}).text,'');
});
test('new messages, reset, expiry, missing id and access revocation never expose stale workspace',()=>{
 let t=1,allowed=true;const w=new MindWorkspace({allowed:()=>allowed,enabled:()=>true,now:()=>t});
 w.begin(key,'old');assert.equal(w.compose(key,[memory('a')]).text,'');w.compose(key,[memory('a')],{continuityMessageId:'old'});
 t+=300001;assert.equal(w.snapshot(key).stale,true);assert.equal(w.snapshot(key).selected.length,0);
 w.begin(key,'new');assert.equal(w.compose(key,[memory('b')],{continuityMessageId:'old'}).text,'');w.compose(key,[memory('b')],{continuityMessageId:'new'});
 allowed=false;assert.equal(w.snapshot(key).selected.length,0);allowed=true;w.invalidate();assert.equal(w.compose(key,[memory('a')],{continuityMessageId:'new'}).text,'');
});
test('budget-deferred idle idea is retained; later selection consumes once; expiry forbids commit',async()=>{
 let t=1000000;const source={id:'a',text:'喜欢雨声',source_time:10,subject_id:'123'};
 const idle=new IdleAssociations({allowed:k=>k===key,enabled:()=>true,now:()=>t,request:async()=>({results:[source]}),generate:async()=>JSON.stringify({useful:true,kind:'question',topic:'雨声适合搭配阅读吗？',sourceIds:['a'],continue:false})});
 idle.note(key,'下雨了');t+=120001;await idle.tick();
 const context={deferIdleConsumption:true,continuityMessageId:'m'};const text=await idle.take(key,[source],context);
 const w=new MindWorkspace({allowed:()=>true,enabled:()=>true,maxItems:1});w.begin(key,'m');
 const a={id:context.idleAssociation.ideaId,type:'association',text,score:.4};
 assert.equal(w.compose(key,[memory('priority',1),a],context).selected[0].id,'priority');assert.ok(idle.states.get(key).ready);
 assert.equal(w.compose(key,[a],context).selected[0].id,a.id);assert.equal(idle.commit(context.idleAssociation),true);assert.equal(idle.commit(context.idleAssociation),false);
 t+=1800001;idle.note(key,'雨还在下');t+=120001;await idle.tick();const c={deferIdleConsumption:true};await idle.take(key,[source],c);t+=600001;assert.equal(idle.commit(c.idleAssociation),false);
});
