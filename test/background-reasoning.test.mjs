import test from 'node:test';
import assert from 'node:assert/strict';
import {backgroundEffort,reasoningView,validateEffortPatch,runBoundedHeadless} from '../bridge/background-reasoning.mjs';
import {selectBackgroundModel} from '../lib/background-model.js';
const never=()=>new Promise(()=>{});
test('separate defaults and explicit module overrides preserve chat settings',()=>{
 const cfg={dsh:{reasoningEffort:'max'},backgroundReasoning:{idle_association:'high'}};
 assert.equal(backgroundEffort(cfg,'event_understanding'),'low');assert.equal(backgroundEffort(cfg,'memory_extract'),'high');assert.equal(backgroundEffort(cfg,'fact_review'),'high');assert.equal(backgroundEffort(cfg,'idle_association'),'high');assert.equal(reasoningView(cfg).chatEffort,'max');
 for(const patch of [{unknown:'low'},{diary:'off'},{diary:'medium'},[],null])assert.throws(()=>validateEffortPatch(patch));
 assert.deepEqual(validateEffortPatch({diary:'low'}),{diary:'low'});
});
test('timeout cancels remote work before forgetting the session',async()=>{
 const order=[];await assert.rejects(runBoundedHeadless({dispatch:async()=>order.push('submit'),wait:never(),timeoutMs:10,cancel:async()=>order.push('cancel'),cleanup:async()=>order.push('cleanup')}),/超时/);
 assert.deepEqual(order,['submit','cancel','cleanup']);
});
test('failed cancellation retains ownership and reports admission block',async()=>{
 let cleanup=false,blocked=false;
 await assert.rejects(runBoundedHeadless({dispatch:async()=>{},wait:never(),timeoutMs:10,cancel:async()=>{throw Error('offline')},cleanup:async()=>cleanup=true,onCancelFailure:()=>blocked=true}),/暂停/);
 assert.equal(blocked,true);assert.equal(cleanup,false);
});
test('late submission is cancelled again, without releasing ownership early',async()=>{
 let submit,stops=0,cleaned=false,blocked=false;
 await assert.rejects(runBoundedHeadless({dispatch:()=>new Promise(r=>submit=r),wait:never(),timeoutMs:10,cancel:async()=>stops++,cleanup:async()=>cleaned=true,onCancelFailure:()=>blocked=true}),/暂停/);
 assert.equal(blocked,true);assert.equal(cleaned,false);submit();await new Promise(r=>setTimeout(r,0));assert.equal(stops,2);
});
test('successful completion is never cancelled',async()=>{
 let stops=0,cleaned=false;assert.equal(await runBoundedHeadless({dispatch:async()=>{},wait:Promise.resolve('json'),timeoutMs:100,cancel:async()=>stops++,cleanup:async()=>cleaned=true}),'json');assert.equal(stops,0);assert.ok(cleaned);
});
test('session-only selection rejects chat sessions and never writes global defaults',async()=>{
 let preset='qq-memory',saved=0;const selections=[];
 const ctx={sessionController:{agents:{resolveAgent:async()=>({agent:{session:{}}}),presetForSession:()=>preset,serializeImageAdmission:(_,fn)=>fn(),selectForNextRequest:(_,s)=>selections.push(s)}},llm:{resolveCallConfig:async x=>x},agentDefaultModel:{saveSelection:()=>saved++}};
 const body={sessionId:'session-test',provider:'deepseek-account',model:'deepseek-flash',reasoningEffort:'low'};
 assert.equal((await selectBackgroundModel(ctx,body)).selected.reasoningEffort,'low');assert.equal(saved,0);assert.equal(selections.length,1);
 preset='qq-chat';await assert.rejects(selectBackgroundModel(ctx,body),/qq-memory/);assert.equal(selections.length,1);
 await assert.rejects(selectBackgroundModel({},body),/不支持/);
});


test('host model endpoint requires the private bridge token before invoking selection',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),http=await import('node:http');
 const previous=process.env.DSH_HOME,dir=fs.mkdtempSync(path.join(os.tmpdir(),'xinji-model-host-'));process.env.DSH_HOME=dir;
 const bridge=path.join(dir,'qq-bridge');fs.mkdirSync(path.join(bridge,'state'),{recursive:true});fs.writeFileSync(path.join(bridge,'config.json'),'{}');fs.writeFileSync(path.join(bridge,'state','console-token'),'fixture-console-token');
 const {createApiHandler}=await import('../lib/api.js');let calls=0;
 const server=http.createServer(createApiHandler({selectBackgroundModel:async body=>{calls++;return{selected:body}}}));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${server.address().port}/api/background/model`,headers={'content-type':'application/json','x-feiyu-console':'1'};
 try{
  const denied=await fetch(url,{method:'POST',headers,body:'{}'});assert.equal(denied.status,403);assert.equal(calls,0);
  const accepted=await fetch(url,{method:'POST',headers:{...headers,'x-console-token':'fixture-console-token'},body:JSON.stringify({sessionId:'session-test'})});assert.equal(accepted.status,200);assert.equal(calls,1);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));if(previous===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=previous;fs.rmSync(dir,{recursive:true,force:true});}
});
