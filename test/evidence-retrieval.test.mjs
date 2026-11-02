import test from 'node:test';
import assert from 'node:assert/strict';
import {RetrievalSessions,renderEvidence} from '../bridge/retrieval-session.mjs';
import {EvidenceConsumer,applySourceChange} from '../bridge/evidence-consumer.mjs';
import {externalEvidence} from '../bridge/evidence-contract.mjs';
import {noteTaste,emptyTaste} from '../bridge/taste.mjs';
import {SelfReference} from '../bridge/self-reference.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
const key='private:10001';
const row=(id='one',root='root')=>({id,text:'用户说下周考试，后来纠正是朋友并且已经取消',scope:key,contract:{scope:key,rootIds:[root],sourceType:'participant-utterance'},retrieval:{method:'lexical-source'}});
test('bounded follow-up anchors, shared roots, duplicate query and per-turn reset',async()=>{
 const calls=[];const s=new RetrievalSessions({request:async(route,body)=>{calls.push(body);return {results:[row(body.query,body.query==='paraphrase'?'root':body.query)],vectorStatus:'ready'};}});
 const a=await s.search({key,turn:1,query:'root'});assert.equal(a.status,'matched');assert.match(renderEvidence(a),/历史证据/);
 assert.equal((await s.search({key,turn:1,query:'root'})).status,'no-new-evidence');assert.equal(calls.length,1);
 assert.equal((await s.search({key,turn:1,query:'paraphrase'})).status,'no-new-evidence');
 await s.search({key,turn:1,query:'neighbour',anchors:[a.records[0].ref]});assert.deepEqual(calls.at(-1).anchors,['root']);
 assert.equal((await s.search({key:'private:20002',turn:1,query:'root',anchors:[a.records[0].ref]})).status,'invalid-anchor');
 assert.equal((await s.search({key,turn:2,query:'root',anchors:[a.records[0].ref]})).status,'invalid-anchor');
});
test('call/character budgets, foreign scope, empty results and no model costs',async()=>{
 const s=new RetrievalSessions({request:async()=>({results:[{...row(),scope:'group:99'},row()]})});
 assert.equal((await s.search({key,turn:1,query:'a',maxCalls:1})).records.length,1);
 assert.equal((await s.search({key,turn:1,query:'b',maxCalls:1})).status,'budget-exhausted');
 const big=new RetrievalSessions({request:async()=>({results:[{...row(),text:'x'.repeat(2000)}]})});
 const r=await big.search({key,turn:1,query:'a',maxChars:500});assert.equal(r.records.length,0);assert.equal(r.stats.contextChars,0);
 assert.equal((await new RetrievalSessions({request:async()=>({results:[]})}).search({key,turn:1,query:'none'})).status,'empty');
});
test('first retrieval reserves followup room and forwards only already delivered roots',async()=>{
 const requests=[];const s=new RetrievalSessions({request:async(route,body)=>{requests.push(body);return {results:Array.from({length:body.limit},(_,i)=>({...row(body.query+i,body.query+i),text:'x'.repeat(900)}))};}});
 const first=await s.search({key,turn:1,query:'initial'});
 assert.equal(requests[0].limit,4);assert.ok(first.stats.contextChars<=3900);
 const next=await s.search({key,turn:1,query:'followup',anchors:[first.records[0].ref]});
 assert.deepEqual(requests[1].exclude,first.records.flatMap(r=>r.contract.rootIds));assert.ok(next.records.length>0);assert.ok(next.stats.contextChars<=6000);
});
test('source changes, new messages and timeouts cannot publish stale results',async()=>{
 let release,revision=1,current=true;const s=new RetrievalSessions({request:()=>new Promise(r=>release=r),revision:()=>revision,timeoutMs:50});
 const first=s.search({key,turn:1,query:'a',current:()=>current});await Promise.resolve();revision++;release({results:[row()]});assert.equal((await first).status,'stale');
 const second=s.search({key,turn:2,query:'b',current:()=>current});await Promise.resolve();current=false;release({results:[row()]});assert.equal((await second).status,'stale');
 const timeout=new RetrievalSessions({request:()=>new Promise(()=>{}),timeoutMs:5});assert.equal((await timeout.search({key,turn:1,query:'a'})).status,'unavailable');assert.equal((await timeout.search({key,turn:1,query:'b'})).status,'busy');
});
test('cache invalidation preserves the same-turn call budget and revokes anchors',async()=>{
 let revision=1;const s=new RetrievalSessions({revision:()=>revision,request:async()=>({results:[row()]})});
 const first=await s.search({key,turn:1,query:'a',maxCalls:1});revision++;s.invalidate();
 assert.equal((await s.search({key,turn:1,query:'b',anchors:[first.records[0].ref]})).status,'invalid-anchor');
 assert.equal((await s.search({key,turn:1,query:'b',maxCalls:1})).status,'budget-exhausted');
 assert.equal((await s.search({key,turn:2,query:'b',maxCalls:1})).status,'matched');
});
test('module save before ack: restart after save never reapplies state changes',async()=>{
 const event={sequence:1,scope:key,eventId:'source-one',sourceVersion:'version-one',kind:'source_corrections-insert',at:10};
 let module={concerns:[{status:'open',evidence:[{id:'source-one'}]}]},ack={cursor:0},writes=0,fail=true;
 const options={request:async()=>({events:[event],revision:1}),load:()=>ack,save:next=>{if(fail)throw Error('crash before ack');ack=next;},subscribers:[e=>{const next=applySourceChange(module,e,{invalid:true,module:'yuyin'});if(next!==module){writes++;module=next;}}]};
 await assert.rejects(new EvidenceConsumer(options).tick());assert.equal(module.concerns[0].status,'closed');assert.equal(ack.cursor,0);
 fail=false;await new EvidenceConsumer(options).tick();assert.equal(writes,1);assert.equal(ack.cursor,1);
});
test('failed module persistence does not acknowledge or mutate original state',async()=>{
 const original={beliefs:[{status:'tentative',sourceId:'source'}]};let ack=0;
 const e={sequence:2,scope:key,eventId:'source',kind:'source-removed',at:1};
 const c=new EvidenceConsumer({request:async()=>({events:[e]}),save:()=>ack++,subscribers:[()=>{const next=applySourceChange(original,e,{invalid:true});assert.equal(next.beliefs[0].status,'retracted');throw Error('disk full');}]});
 await assert.rejects(c.tick());assert.equal(ack,0);assert.equal(original.beliefs[0].status,'tentative');
});
test('correction closes concerns, cancels drafts and retains historical emotion',()=>{
 const before={concerns:[{status:'open',evidence:[{id:'s'}]}],claims:[{status:'supported',evidence:[{id:'s'}]}],draft:{status:'generating',sourceId:'s'},events:[{eventId:'s',valence:-.2}]};
 const next=applySourceChange(before,{sequence:1,eventId:'s',scope:key,kind:'source-removed',at:5},{invalid:true});
 assert.equal(next.concerns[0].status,'closed');assert.equal(next.claims[0].sourcePaused,true);assert.equal(next.draft.status,'cancelled');assert.equal(next.events[0].valence,-.2);assert.equal(next.events[0].sourceState,'invalid');
});
test('external author remains external and repeated root never reinforces interest',()=>{
 const evidence={url:'https://example.org/article',author:'author',excerpt:'The author enjoys coffee',at:1};
 const contract=externalEvidence(evidence);assert.equal(contract.sourceType,'external-document');assert.equal(contract.scope,'self');assert.equal(contract.speaker,'author');
 const first=noteTaste(emptyTaste(),{topic:'coffee',evidence});const second=noteTaste(first.state,{topic:'coffee',evidence:{...evidence,excerpt:'Paraphrased in diary',contract}});
 assert.equal(first.state.topics[0].strength,second.state.topics[0].strength);assert.equal(second.reason,'same-evidence-root');
});
test('late self-reference result cannot overwrite a manual revision',()=>{
 const s=new SelfReference({enabled:()=>true,allowed:()=>true,generate:async()=>'',save:()=>{}});
 s.state.revision=9;assert.throws(()=>s.apply({changes:[]},[],8),/已更新/);assert.equal(s.state.revision,9);
});
test('actual module subscriber persists invalidation while behavior is disabled, then acknowledges',async()=>{
 const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
 const code=source.slice(source.indexOf('  const evidenceConsumer=new EvidenceConsumer('),source.indexOf('  idleAssociationTimer.unref?.();'));
 const writes=[],event={sequence:7,scope:key,eventId:'source',sourceVersion:'version',kind:'source_corrections-update',messageId:'m',speaker:'10001',at:10};
 const continuity={allowed:()=>false,states:new Map([[key,{concerns:[{status:'open',evidence:['source']}]}]]),live:new Map([[key,{}]]),save:()=>writes.push('yuyin')};
 const selfReference={allowed:()=>false,state:{claims:[{evidence:['source']}]},commit(s){this.state=s;writes.push('lunkuo');}};
 const emotionLanes={states:new Map([[key,{events:[{eventId:'source',valence:-.2}]}]]),save:()=>writes.push('chaoxi'),owner(){return this.states.get(key);}};
 const stateFiles={'/state/self-memory.json':{items:[{sourceId:'source'}]},'/state/taste.json':{topics:[{evidence:[{id:'source'}]}]},'/state/diary-state.json':{notes:[{sourceId:'source'}]}};
 const ctx=vm.createContext({EvidenceConsumer,applySourceChange,path:path.posix,cfg:{ownerQQ:'10001'},memoryRequest:async()=>({events:[event],revision:7}),readJsonSafe:()=>null,STATE_DIR:'/state',NARRATIVE_FILE:'/state/narrative.json',fs:{existsSync:p=>Boolean(stateFiles[p]),readFileSync:p=>JSON.stringify(stateFiles[p])},atomicWriteJson:(p,s)=>{stateFiles[p]=s;writes.push(p);},
  sourceValidity:{blocked:()=>true},retrievalSessions:{invalidate:()=>{}},followupMemory:{entries:new Map()},mindWorkspaces:{invalidate:()=>{}},idleAssociations:{reset:()=>{}},initiativeEpoch:0,episodes:[{id:'ep',emotionEventId:key+'/10001/m'}],saveEpisodes:()=>writes.push('episodes'),continuity,selfReference,emotionLanes,emotionState:{},narrativeState:{versions:[{sourceEpisodeIds:['ep']}]},growthClassroom:{state:{courses:[{draft:{sourceId:'source'}}]},save:()=>writes.push('classroom')},setInterval:()=>({unref(){}}),log:()=>{}});
 await vm.runInContext(code+';evidenceConsumer.tick()',ctx);
 assert.equal(continuity.states.get(key).concerns[0].status,'closed');assert.equal(selfReference.state.claims[0].sourcePaused,true);
 assert.equal(emotionLanes.states.get(key).events[0].valence,-.2);assert.equal(ctx.narrativeState.versions[0].sourceState,'invalid');
 assert.equal(stateFiles['/state/self-memory.json'].items[0].sourceState,'invalid');assert.equal(ctx.growthClassroom.state.courses[0].draft.sourceState,'invalid');
 assert.equal(writes.at(-1),'/state/evidence-consumer.json');assert.equal(stateFiles['/state/evidence-consumer.json'].cursor,7);
});
