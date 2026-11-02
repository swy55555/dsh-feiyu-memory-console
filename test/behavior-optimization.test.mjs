import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {extras} from './bridge-test-context.mjs';
import {detectCorrection,repairHint} from '../bridge/repair.mjs';
import {parseInteraction} from '../bridge/interaction-context.mjs';
import {MindWorkspace} from '../bridge/mind-workspace.mjs';
import {buildSessionBlock,buildSummaryBlock} from '../bridge/human-context.mjs';
import {recallForCurrentContext} from '../bridge/reply-context.mjs';

const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
const between=(a,b)=>{const x=source.indexOf(a),y=source.indexOf(b,x);assert.ok(x>=0&&y>x);return source.slice(x,y)};
const key='private:1',message='你记错了，我说的是周六。';
function interpretation(original=message,target='claim'){
 return parseInteraction({intent:'feedback',focus:'repair',feedbackTarget:target,boundary:'none',confidence:.95,
  meaning:'用户指出先前所说的日期有误',quote:original,contextEvidence:[{id:'a1',quote:'你准备周日出发。'}]},original,
  [{id:'a1',role:'assistant',text:'你准备周日出发。'}]);
}

test('ordinary negations, quotations, third parties and guesses cannot trigger unsupported correction guidance',()=>{
 for(const input of ['今天天气不是很好。','这不是我昨天提到的那本书吗？','他说“你记错了”，我没参与。','他记错了我的名字。','假如你记错了，我们再核对。','我并没有去过那里。','我说的是这部电影的名字。']){
  assert.equal(detectCorrection(input).isCorrection,false,input);
 }
 assert.equal(detectCorrection(message).isCorrection,false,'no analysis means no automatic admission');
 assert.equal(repairHint({isCorrection:false}),'');
});

test('only completed, quoted claim feedback provides a correction hint; expression feedback remains separate',()=>{
 const valid=interpretation();assert.ok(valid);
 const result=detectCorrection(message,valid);assert.equal(result.isCorrection,true);
 assert.ok(repairHint(result));assert.doesNotMatch(repairHint(result),/先直接承认|不要辩解/);
 assert.equal(detectCorrection('今天天气不是很好。',valid).isCorrection,false,'old quote');
 assert.equal(detectCorrection(message,interpretation(message,'expression')).isCorrection,false);
 assert.equal(detectCorrection(message,{...valid,contextEvidence:[]}).isCorrection,false);
 assert.equal(detectCorrection(message,{...valid,confidence:.2}).isCorrection,false);
 assert.equal(detectCorrection(message,{...valid,focus:'listen'}).isCorrection,false);
});

function fixture(workspace=false){
 let revision='v1';const mind=new MindWorkspace({allowed:()=>true,enabled:()=>true});mind.begin(key,'m1');
 const ctx=vm.createContext({...extras,crypto,buildSessionBlock,buildSummaryBlock,recallForCurrentContext,
  cfg:{ownerQQ:1,socialV2:{memoryRecall:{enabled:false},selfMemory:{recall:false},emotion:{enabled:false}}},
  mindAllowed:()=>true,mindWorkspaceEnabled:()=>workspace,mindWorkspaces:mind,
  sourceValidity:{revision:()=>revision},humanContextEnabled:()=>false,noteSessionTurn:()=>{},scheduleRotationCheck:()=>{},
  dailyMemorySubjects:new Map(),dailyRecallQueries:new Map(),recordRetrievalTrace:()=>{},
  fetchContextBundle:async()=>({messages:[],summaries:[]}),sessionWindowStart:()=>1,log:()=>{},
  continuity:{prompt:(_k,c)=>{c.interaction=interpretation();c.continuityItems=[];return '[continuity]';},delivery:()=>{}},
  responsePatterns:{view:()=>({adjustments:[]}),candidates:()=>[]},growthClassroom:{candidates:()=>[]},
  repairState:{events:[],lessons:['保留用户说明的日期条件。']},saveRepairState:()=>{}});
 const compose=vm.runInContext(between('  async function withMemoryContext(','  const dailyRecallQueries')+';withMemoryContext',ctx);
 return {ctx,compose,change:(next='v2')=>{revision=next},context:()=>({allowIdleAssociation:true,continuityMessageId:'m1'})};
}

test('unavailable source database fails closed without losing the current message',async()=>{
 const f=fixture(),context=f.context();f.change('unavailable');
 assert.equal(await f.compose(key,message,context),message);
 assert.equal(context.sourceReferencesDiscarded,true);
});

test('disabled understanding cannot reuse a previous interaction to trigger repair',async()=>{
 const f=fixture(),context={...f.context(),disableContinuity:true,interaction:interpretation()};
 const out=await f.compose(key,message,context);
 assert.doesNotMatch(out,/【更正】/);assert.ok(out.endsWith(message));
 assert.equal(f.ctx.repairState.events.length,0);
});

for(const workspace of [false,true])test(`actual composer delivers correction/lesson once with workspace=${workspace}`,async()=>{
 const f=fixture(workspace),context=f.context(),out=await f.compose(key,message,context);
 assert.equal(out.split('【更正】').length-1,1);
 assert.equal(out.split('【别再犯】').length-1,1);
 assert.ok(out.endsWith(message));
});

test('source change while history is loading drops prepared references and preserves original request',async()=>{
 const f=fixture(),context=f.context();let finish;
 f.ctx.fetchContextBundle=()=>new Promise(r=>finish=r);
 const pending=f.compose(key,message,context);await new Promise(r=>setImmediate(r));
 f.change();finish({messages:[],summaries:[]});
 assert.equal(await pending,message);
 assert.equal(context.sourceReferencesDiscarded,true);
 assert.deepEqual(Array.from(context.referenceBlocks||[]),[]);
});

for(const timing of ['before-dispatch','during-reuse'])test(`actual dispatch excludes stale references ${timing}, retaining media and request`,async()=>{
 const f=fixture(),context=f.context(),prepared=await f.compose(key,message,context),sent=[],commits=[];
 Object.assign(f.ctx,{reverse:new Map([['session',key]]),referenceReuse:{prepare:async({content})=>{
  if(timing==='during-reuse')f.change();return {content,savedChars:12,reused:['history'],commit:x=>commits.push(x)};
 }},turnTraces:{enqueue:()=>({}),cancel:()=>{}},api:{sessions:{prompt:async p=>{sent.push(p);return {result:{ok:true,value:{}}}}}}});
 const dispatch=vm.runInContext(between('  async function dispatchTracedPrompt(','  function traceRow(')+';dispatchTracedPrompt',f.ctx);
 if(timing==='before-dispatch')f.change();
 await dispatch({sessionId:'session',content:[{type:'text',text:prepared},{type:'image',url:'synthetic-image'}]},context);
 assert.equal(sent.length,1);assert.equal(sent[0].content[0].text,message);
 assert.equal(sent[0].content[1].url,'synthetic-image');
 assert.equal(context.sourceReferencesDiscarded,true);assert.ok(!commits.includes(true),'stale reuse proof must not be committed');
 assert.ok(context.referenceAssembly.decisions.every(row=>row.reason==='source-revision-changed'));
});

test('unchanged source revision preserves prepared context at actual dispatch',async()=>{
 const f=fixture(),context=f.context(),prepared=await f.compose(key,message,context),sent=[];
 Object.assign(f.ctx,{reverse:new Map([['session',key]]),referenceReuse:{prepare:async({content})=>({content,savedChars:0,reused:[],commit:()=>{}})},
  turnTraces:{enqueue:()=>({}),cancel:()=>{}},api:{sessions:{prompt:async p=>{sent.push(p);return {result:{ok:true,value:{}}}}}}});
 const dispatch=vm.runInContext(between('  async function dispatchTracedPrompt(','  function traceRow(')+';dispatchTracedPrompt',f.ctx);
 await dispatch({sessionId:'session',content:[{type:'text',text:prepared}]},context);
 assert.equal(sent[0].content[0].text,prepared);assert.ok(prepared.includes('[continuity]'));
});
