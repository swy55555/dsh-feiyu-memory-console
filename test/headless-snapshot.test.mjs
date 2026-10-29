import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
const start={type:'turn/start',data:{turn:1}},message={type:'assistant/message',data:{turn:1,text:'validated-result'}},end={type:'turn/end',data:{turn:1,reason:{kind:'completed'}}};
function harness(){
 const resolved=[],rejected=[];
 const ctx=vm.createContext({learnerFeatures:new Map([['fresh','candidate_review']]),learnerSessions:new Set(['fresh','legacy','chat']),learnerWaiters:new Map([['fresh',[{resolve:x=>resolved.push(x),reject:e=>rejected.push(e.message),timer:0}]]]),learnerCollectors:new Map(),reverse:new Map([['chat','private:1']]),slangLearnerSessionId:'legacy',clearTimeout:()=>{},
 createTurnCollector:()=>{const turns=new Map();return{push(e){const id=e.data?.turn;if(e.type==='turn/start')turns.set(id,'');if(e.type==='assistant/message'&&turns.has(id))turns.set(id,turns.get(id)+e.data.text);if(e.type==='turn/end'&&turns.has(id)){const text=turns.get(id);turns.delete(id);return{text,reason:e.data.reason}}}}}});
 const a=source.indexOf('  function acceptLearnerEvent('),b=source.indexOf('  async function runSlangExtraction(',a);
 vm.runInContext(source.slice(a,b),ctx);return{ctx,resolved,rejected};
}
test('snapshot start plus live completion resolves the active background request',()=>{
 const {ctx,resolved}=harness();ctx.restoreHeadlessSnapshot('fresh',[{type:'event',event:start}]);ctx.acceptLearnerEvent('fresh',message);ctx.acceptLearnerEvent('fresh',end);
 assert.deepEqual(resolved,['validated-result']);assert.equal(ctx.learnerWaiters.has('fresh'),false);
});
test('a completed fresh snapshot resolves once; repeated snapshots cannot replay or duplicate text',()=>{
 const {ctx,resolved}=harness();ctx.restoreHeadlessSnapshot('fresh',[start,message]);ctx.restoreHeadlessSnapshot('fresh',[start,message,end]);ctx.restoreHeadlessSnapshot('fresh',[start,message,end]);
 assert.deepEqual(resolved,['validated-result']);assert.equal(ctx.learnerCollectors.has('fresh'),false);
});
test('normal chats, reusable learners and expired waiters never consume historical completion',()=>{
 const {ctx,resolved}=harness();ctx.restoreHeadlessSnapshot('chat',[start,message,end]);ctx.restoreHeadlessSnapshot('legacy',[start,message,end]);ctx.learnerWaiters.delete('fresh');ctx.restoreHeadlessSnapshot('fresh',[start,message,end]);assert.deepEqual(resolved,[]);
});
test('an error completion rejects rather than turning partial output into a valid answer',()=>{
 const {ctx,resolved,rejected}=harness();ctx.restoreHeadlessSnapshot('fresh',[start,message,{...end,data:{turn:1,reason:{kind:'error'}}}]);assert.deepEqual(resolved,[]);assert.equal(rejected.length,1);
});
