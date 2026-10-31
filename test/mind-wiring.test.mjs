import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import crypto from 'node:crypto';
import {MindWorkspace} from '../bridge/mind-workspace.mjs';
import {ResponsePatterns} from '../bridge/response-patterns.mjs';
import {Continuity} from '../bridge/continuity.mjs';
import {DialogueWindow} from '../bridge/interaction-context.mjs';
import {modeAllowed} from '../bridge/xinji-policy.mjs';
import * as human from '../bridge/human-context-v09.mjs';
import {backgroundEffort} from '../bridge/background-reasoning.mjs';
const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
function between(a,b){const x=source.indexOf(a),y=source.indexOf(b,x);assert.ok(x>=0&&y>x);return source.slice(x,y);}

test('actual startup initializes access mode before restoring feedback and continuity from disk',()=>{
 assert.ok(source.indexOf('  let currentMode =')<source.indexOf('  const responsePatterns ='));
 const key='private:1',saved={version:1,chats:[[key,{evidence:[],adjustments:[],disabled:['concise_first'],audit:[{status:'existing',at:1}]}]]};
 const savedContinuity={version:1,chats:[[key,{concerns:[{id:'old',title:'已有挂念',status:'open',expiresAt:Date.now()+86400000}],beliefs:[],events:[],seen:[],relation:{trust:.5,familiarity:0,tension:0}}]]};
 const ctx=vm.createContext({growthClassroom:{candidates:()=>[],state:{enabled:false}},path,STATE_DIR:'fixture',readJsonSafe:()=>({mode:'reserved2'}),normalizeModeInput:x=>x,modeAllowed,cfg:{ownerQQ:1,allow:{private:[1]},deny:{},allowAllWhenEmpty:false},ResponsePatterns,Continuity,DialogueWindow,saved,savedContinuity});
 const initial=between('  // Initialize policy before constructors','  fs.mkdirSync(STATE_DIR');
 const guard=between('  function isSessionAllowedInCurrentMode(','  function sessionPolicy(');
 const allowed=between('  const mindAllowed =','  function mindWorkspaceEnabled(');
 const result=vm.runInContext(initial+guard+allowed+`({patterns:new ResponsePatterns({allowed:mindAllowed,enabled:()=>true,load:()=>saved}),continuity:new Continuity({allowed:mindAllowed,enabled:()=>true,load:()=>savedContinuity})})`,ctx);
 assert.equal(result.patterns.view(key).storageError,false);assert.equal(result.patterns.view(key).audit.length,1);
 assert.equal(result.patterns.view(key).strategies[1].status,'disabled');assert.equal(result.continuity.storageError,false);assert.equal(result.continuity.state(key).concerns.length,1);
});
test('actual composer preserves current request, bounded emotions and stale-message isolation without fact recall',async()=>{
 const key='private:1',mind=new MindWorkspace({allowed:()=>true,enabled:()=>true});mind.begin(key,'m');
 const ctx=vm.createContext({growthClassroom:{candidates:()=>[],state:{enabled:false}},crypto,cfg:{socialV2:{memoryRecall:{enabled:false},context:{enabled:false}}},mindWorkspaceEnabled:()=>true,mindWorkspaces:mind,
  humanContextEnabled:()=>false,noteSessionTurn:()=>{},scheduleRotationCheck:()=>{},dailyMemorySubjects:new Map(),dailyRecallQueries:new Map(),recordRetrievalTrace:()=>{},
  continuity:{prompt:(_k,c)=>{c.continuityItems=[{id:'c',type:'concern',score:.9,text:'相关事项'}];return '';}},
  emotionState:{},emotionViewFor:()=>({}),emotionRecoveryCfg:()=>({}),withSubjectiveFeeling:x=>x,emotionPromptLine:()=> '有一点好奇',episodeRecallBlock:()=> '过去的情景参考',idleAssociations:{feeling:()=>null},expressionTeacher:{candidates:()=>[],view:()=>({lessons:[]})},responsePatterns:{candidates:()=>[],view:()=>({adjustments:[],strategies:[]})}});
 const fn=vm.runInContext(between('  async function withMemoryContext(','  const dailyRecallQueries')+';withMemoryContext',ctx);
 const result=await fn(key,'请直接给我答案',{allowIdleAssociation:true,continuityMessageId:'m'});assert.ok(result.endsWith('请直接给我答案'));assert.equal(result.split('有一点好奇').length,2);assert.match(result,/过去的情景参考/);
 mind.begin(key,'new');assert.equal(await fn(key,'旧请求',{allowIdleAssociation:true,continuityMessageId:'m'}),'旧请求');
});
test('actual management route blocks agents and preserves unrelated config; changes invalidate in-flight understanding',async()=>{
 let cfg={ownerQQ:1,socialV2:{}},file={ownerQQ:1,socialV2:{dailyMemory:{maxCallsPerDay:0}}},invalidated=0;
 const route=between("        if (url.pathname === '/api/mind') {","        if (url.pathname === '/api/continuity') {");
 async function run(headers,body,method='POST'){
  let result;const ctx=vm.createContext({growthClassroom:{candidates:()=>[],state:{enabled:false}},backgroundEffort,url:{pathname:'/api/mind'},req:{headers,method},cfg,ROOT:'fixture',path,readBody:async()=>body,
   readConfigObject:()=>structuredClone(file),atomicWriteJson:(_p,x)=>file=x,mindWorkspaces:{invalidate:()=>invalidated++,snapshot:()=>({})},continuity:{invalidate:()=>invalidated++},expressionTeacher:{view:()=>({lessons:[]}),invalidate:()=>{}},responsePatterns:{view:()=>({}),edit:()=>{throw Error('invalid')}},sendJson:(data,status=200)=>result={data,status}});
  await vm.runInContext('(async()=>{'+route+'})()',ctx);return result;
 }
 assert.equal((await run({'x-agent-call':'1'},{enabled:true})).status,403);assert.equal(invalidated,0);
 assert.equal((await run({},{learningEnabled:true})).status,200);assert.equal(invalidated,2);assert.equal(file.socialV2.dailyMemory.maxCallsPerDay,0);assert.equal(cfg.socialV2.mind.learningEnabled,true);
 assert.equal((await run({},{action:'invalid',id:'x'})).status,400);assert.equal((await run({},null,'DELETE')).status,405);
});

test('actual semantic recall retains subject, task and source-time markers; late search cannot restore old focus',async()=>{
 const key='private:1',mind=new MindWorkspace({allowed:()=>true,enabled:()=>true});mind.begin(key,'m');let release;
 const row={id:'plan',text:'计划周日去公园，如果不下雨',scope:key,subject_id:'1',tier:'task',score:.95,source_id:'original',source_time:100};
 const traces=[];const ctx=vm.createContext({growthClassroom:{candidates:()=>[],state:{enabled:false}},...human,crypto,AbortSignal,cfg:{socialV2:{context:{enabled:false},emotion:{enabled:false}}},mindWorkspaceEnabled:()=>true,mindWorkspaces:mind,
  noteSessionTurn:()=>{},scheduleRotationCheck:()=>{},dailyMemorySubjects:new Map([[key,'1']]),dailyRecallQueries:new Map([[key,'1 周日有什么计划']]),recordRetrievalTrace:x=>traces.push(x),
  continuity:{prompt:()=>''},getSocialV2State:()=>({}),recallQuery:()=>'',memoryScope:k=>k,memoryRequest:async()=>({results:[]}),fetch:async()=>({ok:true,json:async()=>({results:[row]})}),
  idleAssociations:{take:async()=>''},expressionTeacher:{candidates:()=>[],view:()=>({lessons:[]})},responsePatterns:{candidates:()=>[],view:()=>({adjustments:[],strategies:[]})},traceRow:r=>r,log:()=>{}});
 const fn=vm.runInContext(between('  async function withMemoryContext(','  const dailyRecallQueries')+';withMemoryContext',ctx);
 const result=await fn(key,'周日有什么计划',{allowIdleAssociation:true});
 for(const s of ['plan-not-known-complete','private:1','source','如果不下雨'])assert.ok(result.includes(s),s+' missing from '+result);assert.equal(traces.at(-1).injected.length,1);
 ctx.fetch=async()=>new Promise(r=>release=r);mind.begin(key,'pending');const pending=fn(key,'旧问题',{allowIdleAssociation:true});await new Promise(r=>setImmediate(r));mind.begin(key,'next');release({ok:true,json:async()=>({results:[row]})});assert.equal(await pending,'旧问题');assert.equal(traces.at(-1).injected.length,0);
});

test('pausing a concern in the existing route also invalidates captured workspace references',async()=>{
 const key='private:1',mind=new MindWorkspace({allowed:()=>true,enabled:()=>true});mind.begin(key,'old');let edited=false;
 const route=between("        if (url.pathname === '/api/continuity') {","        if (req.method === 'GET' && url.pathname === '/api/memory/idle-association')");
 const ctx=vm.createContext({growthClassroom:{candidates:()=>[],state:{enabled:false}},url:{pathname:'/api/continuity'},req:{method:'POST',headers:{}},cfg:{ownerQQ:1},readBody:async()=>({collection:'concerns',id:'c',action:'pause'}),continuity:{edit:()=>{edited=true},snapshot:()=>({})},mindWorkspaces:mind,sendJson:()=>{}});
 await vm.runInContext('(async()=>{'+route+'})()',ctx);assert.ok(edited);assert.equal(mind.compose(key,[{id:'c',type:'concern',text:'旧挂念',score:.9}],{continuityMessageId:'old'}).text,'');
});
