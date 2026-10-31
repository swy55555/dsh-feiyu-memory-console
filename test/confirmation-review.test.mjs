import test from 'node:test';
import assert from 'node:assert/strict';
import {ReviewMemo,reviewConfirmation,combinedReviewPrompt} from '../bridge/confirmation-review.mjs';
import {advanceConfirmation} from '../lib/confirmation-flow.js';
import {CandidateAuto,reviewSetFingerprint} from '../lib/candidate-auto.js';
test('non-reusable results can coalesce in flight but are not returned on a later retry',async()=>{
 const memo=new ReviewMemo();let calls=0;
 const run=async()=>{calls++;return {status:'uncertain'}};
 await Promise.all([memo.get('coverage',{key:'private:1'},'low',run,()=>false),memo.get('coverage',{key:'private:1'},'low',run,()=>false)]);
 assert.equal(calls,1);await memo.get('coverage',{key:'private:1'},'low',run,()=>false);assert.equal(calls,2);
});
const context={scope:'private:1',revision:'r1',operation:'confirm',offset:0,total:1,evidenceOnly:false,
 candidate:{id:'c',text:'我喜欢茶',quote:'我喜欢茶'},related:[{id:'a',text:'我喜欢小笼包',quote:'我喜欢小笼包'}],
 evidence:{id:'c',text:'我喜欢茶',quote:'他说喜欢咖啡，但我喜欢茶',sourceId:'m1',subjectId:'1'}};
const verdict={id:'c',revision:'r1',supported:true,speakerMatches:true,literal:true,current:true,confidence:.99,evidence:context.evidence.quote,reason:'本人明确陈述'};
const result={revision:'r1',candidateEvidence:context.candidate.quote,relations:[{id:'a',relation:'coexist',confidence:.99,evidence:context.related[0].quote}],evidenceVerdict:verdict};
const prepared={needed:true,context,evidence:context.evidence,reviewed:0,total:1};

test('combined output independently validates complete original evidence and every relation',async()=>{
 assert.match(combinedReviewPrompt(context),/完整原始消息/);
 assert.deepEqual(await reviewConfirmation(context,async()=>JSON.stringify(result)),result);
 for(const value of [
  {...result,revision:'old'}, {...result,relations:[]}, {...result,relations:[result.relations[0],result.relations[0]]},
  {...result,relations:[{...result.relations[0],id:'foreign'}]}, {...result,relations:[{...result.relations[0],evidence:'小笼包'}]},
  {...result,evidenceVerdict:{...verdict,evidence:context.candidate.quote}}, {...result,evidenceVerdict:{...verdict,speakerMatches:'true'}},
 ])await assert.rejects(reviewConfirmation(context,async()=>JSON.stringify(value)));
 assert.throws(()=>combinedReviewPrompt({...context,evidence:{...context.evidence,id:'other'}}));
});

test('same inputs share one in-flight request; returned objects cannot mutate cached results',async()=>{
 const memo=new ReviewMemo();let calls=0,release;
 const run=()=>{calls++;return new Promise(r=>release=r)};
 const a=memo.get('combined',context,'high',run),b=memo.get('combined',context,'high',run);
 await new Promise(r=>setImmediate(r));assert.equal(calls,1);release(result);
 const [x,y]=await Promise.all([a,b]);x.evidenceVerdict.supported=false;assert.equal(y.evidenceVerdict.supported,true);
 assert.equal((await memo.get('combined',context,'high',run)).evidenceVerdict.supported,true);assert.equal(calls,1);
});

test('revision, source, scope, page, operation and model changes invalidate retry memo',async()=>{
 const memo=new ReviewMemo();let calls=0;const run=async()=>{calls++;return result};
 await memo.get('combined',context,'high',run);
 for(const patch of [{revision:'r2'},{scope:'private:2'},{operation:'restore'},{offset:8},{evidence:{...context.evidence,quote:'我不喜欢茶'}},{related:[{...context.related[0],quote:'我不喜欢小笼包'}]}])await memo.get('combined',{...context,...patch},'high',run);
 await memo.get('combined',context,'low',run);assert.equal(calls,8);
});

test('errors are retryable; memo expires without sliding renewal and stays bounded',async()=>{
 let now=0,calls=0;const memo=new ReviewMemo({now:()=>now,ttlMs:100,maxEntries:2}),run=async()=>{calls++;return result};
 await assert.rejects(memo.get('combined',context,'high',async()=>{throw Error('invalid')}));
 await memo.get('combined',context,'high',run);now=90;await memo.get('combined',context,'high',run);assert.equal(calls,1);
 now=101;await memo.get('combined',context,'high',run);assert.equal(calls,2);
 for(let i=0;i<4;i++)await memo.get('combined',{...context,revision:'r'+i},'high',run);assert.equal(memo.ready.size,2);
});

test('single page confirmation needs one model call; durable verdict skips the extra evidence call',async()=>{
 let calls=0,saves=0,confirms=0;
 const deps={valid:()=>true,combined:async()=>{calls++;return result},facts:async()=>{throw Error('duplicate')},save:async body=>{saves++;assert.equal(body.evidenceOnly,false);return{pending:false}},confirm:async revision=>{confirms++;assert.equal(revision,'r1');return{status:'confirmed'}}};
 assert.equal((await advanceConfirmation(prepared,deps)).status,'confirmed');assert.equal(calls,1);assert.equal(saves,1);
 await advanceConfirmation({...prepared,needed:false,evidenceVerdict:verdict},deps);assert.equal(calls,1);assert.equal(confirms,2);
});

test('multi-page flow uses combined only once, then relations only, with no early confirmation',async()=>{
 let combined=0,facts=0,confirms=0,offset=0;
 const deps={valid:()=>true,combined:async()=>{combined++;return result},facts:async()=>{facts++;return result},save:async()=>({pending:offset<16,reviewed:offset+8,total:17}),confirm:async()=>{confirms++;return{status:'confirmed'}}};
 assert.equal((await advanceConfirmation(prepared,deps)).status,'pending');assert.equal(confirms,0);
 offset=8;await advanceConfirmation({...prepared,evidenceVerdict:verdict,context:{...context,offset}},deps);assert.equal(confirms,0);
 offset=16;assert.equal((await advanceConfirmation({...prepared,evidenceVerdict:verdict,context:{...context,offset}},deps)).status,'confirmed');
 assert.deepEqual({combined,facts,confirms},{combined:1,facts:2,confirms:1});
});

test('old relation receipts are preserved while only missing original evidence is reviewed',async()=>{
 let saved;
 await advanceConfirmation({...prepared,needed:false},{valid:()=>true,combined:async c=>{assert.equal(c.evidenceOnly,true);assert.deepEqual(c.related,[]);return{...result,relations:[]}},facts:async()=>{throw Error('duplicate')},save:async body=>{saved=body;return{pending:false}},confirm:async()=>({status:'confirmed'})});
 assert.equal(saved.evidenceOnly,true);
});

test('negative evidence and disabled in-flight checks never confirm or overwrite facts',async()=>{
 let saved=0,confirmed=0,enabled=true;
 const deps={valid:()=>enabled,combined:async()=>({...result,evidenceVerdict:{...verdict,supported:false}}),save:async()=>{saved++;return{pending:false}},confirm:async()=>confirmed++};
 assert.equal((await advanceConfirmation(prepared,deps)).status,'manual');assert.equal(saved,1);assert.equal(confirmed,0);
 deps.combined=async()=>{enabled=false;return result};await assert.rejects(advanceConfirmation(prepared,deps),/关闭/);assert.equal(saved,1);
});

test('complete but uncertain or conflicting reviews stop before confirmation, including cached reviews',async()=>{
 for(const reason of ['3 条关系尚不确定','1 条关系存在矛盾']){
  let calls=0,confirms=0;
  const automatic={status:'manual',dependency:'relations',reason};
  const deps={valid:()=>true,combined:async()=>{calls++;return result},facts:async()=>{throw Error('duplicate')},save:async()=>({pending:false,automatic}),confirm:async()=>{confirms++;throw Error('must not submit')}};
  assert.deepEqual(await advanceConfirmation(prepared,deps),{status:'manual',dependency:'relations',reason});
  assert.deepEqual(await advanceConfirmation({...prepared,needed:false,evidenceVerdict:verdict,automatic},deps),{status:'manual',dependency:'relations',reason});
  assert.equal(calls,1);assert.equal(confirms,0);
 }
});

test('related fact changes wake a previously blocked candidate; retrieval counters do not',async()=>{
 const peer={id:'a',text:'旧事实',source_text:'原话',scope:'private:1',subject_id:'1',access_count:1};
 assert.equal(reviewSetFingerprint([peer]),reviewSetFingerprint([{...peer,access_count:50,last_access:100}]));
 assert.notEqual(reviewSetFingerprint([peer]),reviewSetFingerprint([{...peer,source_text:'更正原话'}]));
 let calls=0,row={id:'c',text:'候选',scope:'private:1',review_context_version:reviewSetFingerprint([peer])};
 const worker=new CandidateAuto({load:()=>({enabled:true}),save:()=>{},list:async()=>[row],step:async()=>{calls++;return{status:'manual'}}});
 await worker.tick();await worker.tick();assert.equal(calls,1);
 row={...row,review_context_version:reviewSetFingerprint([{...peer,text:'新事实'}])};await worker.tick();assert.equal(calls,2);
});


test('unsupported original evidence is not retried just because unrelated memory was added',async()=>{
 let calls=0,row={id:'c',text:'候选',source_text:'原话',scope:'private:1',review_context_version:'v1'};
 const w=new CandidateAuto({load:()=>({enabled:true}),save:()=>{},list:async()=>[row],step:async()=>{calls++;return{status:'manual',dependency:'source'}}});
 await w.tick();row={...row,review_context_version:'v2'};await w.tick();assert.equal(calls,1);
 row={...row,source_text:'新的完整原话'};await w.tick();assert.equal(calls,2);
});

test('a partial review with a blocker pauses automatic work without claiming remaining facts are safe',async()=>{
 let calls=0,commits=0;
 const automatic={status:'manual',dependency:'relations',reason:'已复核 8/100 条；1 条关系尚不确定'};
 const deps={valid:()=>true,combined:async()=>{calls++;return result},facts:async()=>{throw Error('must not review more')},save:async()=>({pending:true,reviewed:8,total:100,automatic}),confirm:async()=>commits++};
 assert.equal((await advanceConfirmation(prepared,deps)).status,'manual');
 assert.equal((await advanceConfirmation({...prepared,needed:true,evidenceVerdict:verdict,automatic},deps)).status,'manual');
 assert.equal(calls,1);assert.equal(commits,0);
});
