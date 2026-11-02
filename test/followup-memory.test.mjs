import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {FollowupMemory} from '../bridge/followup-memory.mjs';
import {apply as applyGuard,RESTRICTED_TOOL_NAMES} from '../bridge/bootstrap/plugins/qq-agent-presets/qq-tool-restrict.mjs';
import {upgradeMemorySearch} from '../bridge/install-runtime-bundle.mjs';
const key='private:123',message={seq:2,messageId:'food',text:'你还记得我喜欢吃什么嘛'};
const fact={id:'old-food',text:'最喜欢吃肉，烤肉，火锅，烧烤都喜欢吃',scope:key,status:'active',score:.9,
 evidence:{sourceId:'old',subjectId:'123',sourceTime:1793209420521,sourceText:'最喜欢吃肉，烤肉，火锅，烧烤都喜欢吃'}};
const args={key,messages:[message],latestSeq:2};
const src=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
const between=(s,a,b)=>{const i=s.indexOf(a),j=s.indexOf(b,i);assert.ok(i>=0&&j>i);return s.slice(i,j)};
function fixture(overrides={}){
 const calls=[],traces=[];let rev='a',current=true;
 const request=async(route,body)=>{calls.push({route,body});return route==='/search'?{results:[fact]}:{messages:[]}};
 const memory=new FollowupMemory({request,revision:()=>rev,...overrides});
 return {memory,calls,traces,args:{...args,current:()=>current,trace:r=>traces.push(r)},revoke:()=>{rev='b'},newer:()=>{current=false}};
}
test('food question received inside a running turn retrieves old fact, coalesces reads and stays local',async()=>{
 const f=fixture();const [a,b]=await Promise.all([f.memory.get(f.args),f.memory.get(f.args)]);
 assert.equal(a.status,'matched');assert.match(a.context,/烤肉/);assert.deepEqual(a.ids,['old-food']);assert.deepEqual(a,b);
 assert.equal(f.calls.filter(r=>r.route==='/search').length,1);assert.equal(f.traces.length,1);
 assert.equal(f.calls[0].body.query,message.text);assert.equal(f.calls[0].body.scope,key);
 a.ids.push('mutated');assert.deepEqual((await f.memory.get(f.args)).ids,['old-food']);
});
test('empty, failure, disabled, arithmetic and stale message states do not claim data loss',async()=>{
 for(const [request,status] of [[async()=>({results:[]}),'empty'],[async()=>{throw Error('offline')},'unavailable'],[async()=>({}),'unavailable']]){
  const r=await fixture({request}).memory.get(args);assert.equal(r.status,status);assert.match(r.note,/不证明/);
 }
 const f=fixture();assert.equal((await f.memory.get({...args,enabled:false})).status,'disabled');
 assert.equal((await f.memory.get({...args,latestSeq:3})).status,'stale');
 assert.equal((await f.memory.get({...args,messages:[{...message,text:'2+2'}]})).status,'not-queried');assert.equal(f.calls.length,0);
});
test('cross-chat and inactive rows never become followup facts',async()=>{
 const f=fixture({request:async()=>({results:[{...fact,scope:'private:456',shared:true,shareAuthorizedFor:key},{...fact,status:'deleted'}]})});
 const r=await f.memory.get(args);assert.notEqual(r.status,'matched');assert.equal(r.context,'');
});
for(const mode of ['revoke','newer'])test(`in-flight and cached results are discarded after ${mode}`,async()=>{
 let finish;const f=fixture({request:()=>new Promise(r=>finish=r)});
 const work=f.memory.get(f.args);f[mode]();finish({results:[]});assert.equal((await work).status,'stale');
 const g=fixture();await g.memory.get(g.args);g[mode]();const r=await g.memory.get(g.args);
 if(mode==='newer')assert.equal(r.status,'stale');else assert.equal(g.calls.filter(r=>r.route==='/search').length,2);
});
test('timeout releases caller while underlying work retains its concurrency slot; caches are bounded',async()=>{
 let finishes=[];const f=fixture({timeoutMs:15,maxChats:2,request:()=>new Promise(r=>finishes.push(r))});
 assert.equal((await f.memory.get(args)).status,'unavailable');assert.equal(f.memory.busy,1);
 assert.equal((await f.memory.get({...args,key:'private:456'})).status,'unavailable');
 assert.equal((await f.memory.get({...args,key:'private:789'})).status,'busy');
 finishes.forEach(r=>r({results:[]}));await new Promise(r=>setImmediate(r));assert.equal(f.memory.busy,0);
 const g=fixture({maxChats:2});for(let i=1;i<5;i++)await g.memory.get({...args,key:'private:'+i});assert.equal(g.memory.entries.size,2);
});
test('actual bridge wrapper checks actor, latest sequence, pause and feature changes around reads',async()=>{
 let finish;const st={lastUnreadSeq:2},f=fixture({request:()=>new Promise(r=>finish=r)});
 const c={crypto,followupMemory:f.memory,recordRetrievalTrace:()=>{},agentTokenOk:(k,t)=>k===key&&t==='own',
 v2SessionAllowed:()=>true,v2ToolEnabled:()=>true,currentMode:'reserved2',cfg:{socialV2:{}},
 socialV2:{paused:false,conversations:new Map([[key,st]])},canonicalV2Key:k=>k};
 const ctx=vm.createContext(c),fn=vm.runInContext(between(src,'  async function memoryReferenceV2(','  function noteModelMessagesV2(')+';memoryReferenceV2',ctx);
 assert.equal(await fn(key,st,[message],'other','getRecent'),undefined);
 const pending=fn(key,st,[message],'own','waitMessages');st.lastUnreadSeq=3;finish({results:[]});assert.equal((await pending).status,'stale');
 st.lastUnreadSeq=2;c.socialV2.paused=true;assert.equal(await fn(key,st,[message],'own','getUnread'),undefined);
 c.socialV2.paused=false;c.cfg.socialV2.memoryRecall={followup:false};assert.equal(await fn(key,st,[message],'own','getRecent'),undefined);
 for(const flag of ['getRecent','getUnread','waitMessages'])assert.ok(src.includes(`req.headers['x-agent-token'],'${flag}')`));
});
test('actual manual endpoint rejects relay tokens and rechecks permissions after retrieval',async()=>{
 const block=between(src,"        if (req.method === 'GET' && url.pathname === '/api/socialV2/long-memory')","        if (req.method === 'GET' && url.pathname === '/api/socialV2/memory')");
 let allowed=true,finish;const st={lastUnreadSeq:2},responses=[];
 const ctx=vm.createContext({crypto,req:{method:'GET',headers:{'x-agent-token':'wrong'}},url:new URL('http://localhost/api/socialV2/long-memory?key='+key+'&query=food'),
 sendJson:(data,status=200)=>responses.push({data,status}),agentTokenOk:(k,t)=>k===key&&t==='own',v2SessionAllowed:()=>true,v2ToolEnabled:()=>allowed,
 currentMode:'reserved2',cfg:{socialV2:{}},socialV2:{paused:false,conversations:new Map([[key,st]])},canonicalV2Key:k=>k,
 getSocialV2State:()=>st,recordRetrievalTrace:()=>{},renderEvidence:()=>'',retrievalSessions:{search:()=>new Promise(r=>finish=r)}});
 const route=vm.runInContext('(async()=>{'+block+'})',ctx);await route();assert.equal(responses.at(-1).status,403);
 ctx.req.headers['x-agent-token']='own';const pending=route();allowed=false;finish({status:'matched',context:'private fact'});await pending;
 assert.equal(responses.at(-1).status,403);assert.ok(!JSON.stringify(responses.at(-1)).includes('private fact'));
});
test('QQ hides Soul tools and shadows only Soul memory; long-term read has independent registration flag',()=>{
 const restricted=[],contexts=[];let guard;
 applyGuard({systemPrompt:{context:r=>contexts.push(r)},tools:{restrict:r=>restricted.push(...r.deny),guard:g=>guard=g}});
 for(const n of ['learning_search','learning_get','learning_propose'])assert.ok(RESTRICTED_TOOL_NAMES.includes(n)&&restricted.includes(n));
 assert.equal(contexts.find(r=>r.name==='dsh-soul:memory').text(),'');assert.match(contexts.find(r=>r.name==='qq-memory-routing').text(),/qq_vmem_search/);
 assert.ok(guard({name:'learning_search'}));
 const mcp=fs.readFileSync(new URL('../bridge/mcp-snowluma-safe.js',import.meta.url),'utf8');
 const start=mcp.indexOf('const TOOL_CONFIG_FLAGS ='),end=mcp.indexOf('\nserver.tool(',start);
 for(const [tools,expected]of [[{extra:false},true],[{extra:true,longMemory:false},false]]){
  const registered=[];const c=vm.createContext({cfg:{socialV2:{tools}},server:{tool:n=>registered.push(n)}});
  vm.runInContext(mcp.slice(start,end)+";server.tool('qq_vmem_search');server.tool('qq_vmem_add');",c);
  assert.equal(registered.includes('qq_vmem_search'),expected);assert.equal(registered.includes('qq_vmem_add'),tools.extra);
 }
});
test('installed human context template matches tested source, including provenance deduplication',()=>{
 assert.equal(fs.readFileSync(new URL('../bridge/human-context-v09.mjs',import.meta.url),'utf8'),fs.readFileSync(new URL('../bridge/human-context.mjs',import.meta.url),'utf8'));
});
test('MCP upgrade is idempotent and preserves unrelated local paths',()=>{
 const canonical=fs.readFileSync(new URL('../bridge/mcp-snowluma-safe.js',import.meta.url),'utf8');
 const old=canonical.replace("qq_vmem_search: 'longMemory'","qq_vmem_search: 'extra'")+"\n// local media path must remain unchanged\n";
 const updated=upgradeMemorySearch(Buffer.from(old));assert.ok(updated.toString().endsWith('// local media path must remain unchanged\n'));
 assert.ok(updated.toString().includes("qq_vmem_search: 'longMemory'"));assert.deepEqual(upgradeMemorySearch(updated),updated);
 assert.throws(()=>upgradeMemorySearch(Buffer.from("server.tool(\n  'qq_vmem_search',\nmalformed")),/边界/);
});
