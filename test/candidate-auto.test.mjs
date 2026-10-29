import test from 'node:test'
import assert from 'node:assert/strict'
import {CandidateAuto,validateCandidateVerdict} from '../lib/candidate-auto.js'
const row={id:'a',text:'喜欢茶',scope:'private:1',subject_id:'1',source_text:'我喜欢茶',source_id:'m1'}
test('evidence gate rejects guessed, mismatched, incomplete and low confidence verdicts',()=>{
 const context={revision:'r',candidate:{id:'a',quote:'我喜欢茶'}},v={id:'a',revision:'r',evidence:'我喜欢茶',supported:true,speakerMatches:true,literal:true,current:true,confidence:.96}
 assert.equal(validateCandidateVerdict(v,context),true)
 for(const patch of [{revision:'stale'},{evidence:'喜欢茶'},{speakerMatches:false},{literal:false},{current:false},{supported:false},{confidence:.8},{confidence:NaN}])assert.equal(validateCandidateVerdict({...v,...patch},context),false)
})
test('one page per tick, disabled does nothing, ambiguity is not re-reviewed, changed evidence can retry',async()=>{
 let calls=0,now=1000,saved;const w=new CandidateAuto({load:()=>null,save:s=>saved=structuredClone(s),list:async()=>[row],step:async()=>{calls++;return {status:'manual',reason:'原话不足'}},now:()=>now})
 await w.tick();assert.equal(calls,0);w.setEnabled(true);await w.tick();await w.tick();now+=86400000;await w.tick();assert.equal(calls,1)
 const next={...row,source_text:'我现在明确说，我喜欢茶'};w.list=async()=>[next];await w.tick();assert.equal(calls,2)
 const restarted=new CandidateAuto({load:()=>saved,save:()=>{},list:async()=>[next],step:async()=>{calls++}});await restarted.tick();assert.equal(calls,2)
})
test('switch off invalidates an in-flight result and overlapping ticks never spawn extra work',async()=>{
 let finish,calls=0;const w=new CandidateAuto({load:()=>({enabled:true}),save:()=>{},list:async()=>[row],step:async(r,valid)=>{calls++;await new Promise(resolve=>finish=resolve);assert.equal(valid(),false);return {status:'confirmed'}}})
 const pending=w.tick();await new Promise(r=>setImmediate(r));await w.tick();assert.equal(calls,1);w.setEnabled(false);finish();await pending;assert.equal(w.snapshot().records.length,0)
})
test('errors back off while pending pages resume, unavailable storage prevents model calls',async()=>{
 let now=1000,calls=0;const w=new CandidateAuto({load:()=>({enabled:true}),save:()=>{},list:async()=>[row],step:async()=>{calls++;throw Error('offline')},now:()=>now})
 await w.tick();await w.tick();assert.equal(calls,1);now+=600000;await w.tick();assert.equal(calls,2)
 const bad=new CandidateAuto({load:()=>({enabled:true}),save:()=>{throw Error('disk')},list:async()=>[row],step:async()=>calls++});await bad.tick();assert.equal(calls,2);assert.ok(bad.snapshot().error)
})
import {candidateEvidenceContext} from '../lib/candidate-auto.js'
test('evidence review uses the original quote, never the extracted statement as its own proof',()=>{
 const prepared={context:{scope:'private:1',revision:'r',candidate:{id:'a',text:'喜欢煎饼',quote:'喜欢煎饼'}},evidence:{id:'a',text:'喜欢煎饼',quote:'我不喜欢煎饼',sourceId:'m',subjectId:'1'}};
 const context=candidateEvidenceContext(prepared);assert.equal(context.candidate.quote,'我不喜欢煎饼');assert.equal(context.candidate.text,'喜欢煎饼');
 assert.throws(()=>candidateEvidenceContext({context:prepared.context}));
 assert.throws(()=>candidateEvidenceContext({...prepared,evidence:{...prepared.evidence,id:'different'}}));
})
