// Deterministic scenario runner; no live data, network, QQ or paid model calls.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {Continuity} from '../bridge/continuity.mjs';
let now=Date.UTC(2026,9,29,8),answer,calls=0;
const key='private:10001',c=new Continuity({enabled:()=>true,allowed:k=>k===key,now:()=>now,generate:async()=>{calls++;return JSON.stringify(answer)}});
const base=()=>({summary:'普通交流',appraisal:{kind:'neutral',target:'none',confidence:.95,intensity:0,evidence:[]},concerns:[],beliefs:[],focusIds:[],relationship:{kind:'none',quote:''}});
const steps=[];
async function turn(message,configure,expected){
  now+=60000;answer=base();configure(answer,c.snapshot(key));
  const result=await c.observe(key,{text:message},c.begin(key,'fixture-'+steps.length));assert.ok(result);
  const context={traceId:'trace-'+steps.length},reference=c.prompt(key,context);
  c.delivery(context.continuity,'injected');c.reply({key,traceId:context.traceId,status:'sent',sent:1});
  const s=c.snapshot(key);assert.equal(Boolean(reference),expected.reference);if(expected.concern)assert.equal(s.concerns[0].status,expected.concern);
  steps.push({message,event:answer.summary,hasReplyReference:Boolean(reference),concerns:s.concerns.map(({title,detail,status})=>({title,detail,status})),beliefs:s.beliefs.map(({text,status,evidence})=>({text,status,evidenceCount:evidence.length})),relationship:s.relation,lastResult:s.events.at(-1).replyStatus});
}
await turn('明天面试，有点紧张',(v)=>{
  v.summary='用户提到明天面试和紧张';v.appraisal={kind:'user_distress',target:'user',confidence:.95,intensity:.4,evidence:['有点紧张']};
  v.concerns=[{id:'',action:'open',title:'明天的面试',detail:'尚未结束，结果未知',quote:'明天面试',ttlHours:72}];
  v.beliefs=[{id:'',action:'propose',text:'也许在担心面试表现',quote:'有点紧张'}];
},{reference:true,concern:'open'});
await turn('先帮我看看这段代码',v=>{v.summary='用户切换到代码任务，不推断关系变化'},{reference:false,concern:'open'});
await turn('不是怕面试，是担心赶不上车',(v,s)=>{
  v.summary='用户澄清担心的原因';v.concerns=[{id:s.concerns[0].id,action:'update',title:'明天的面试',detail:'需要考虑交通安排',quote:'担心赶不上车',ttlHours:72}];
  v.beliefs=[{id:s.beliefs[0].id,action:'revise',text:'可能担心交通时间，而不是面试表现',quote:'担心赶不上车'}];
},{reference:true,concern:'open'});
await turn('先不聊面试了，继续看代码',(v,s)=>{
  v.summary='用户要求暂时不聊面试';v.concerns=[{id:s.concerns[0].id,action:'pause',title:'明天的面试',detail:'用户希望暂不聊',quote:'先不聊面试了',ttlHours:72}];
},{reference:false,concern:'paused'});
await turn('面试完啦，挺顺利',(v,s)=>{
  v.summary='面试已结束，相关挂念关闭';v.concerns=[{id:s.concerns[0].id,action:'close',title:'明天的面试',detail:'已顺利结束',quote:'面试完啦',ttlHours:1}];
  v.beliefs=[{id:s.beliefs[0].id,action:'reject',text:'可能担心交通时间，而不是面试表现',quote:'挺顺利'}];
},{reference:false,concern:'closed'});
await turn('今天很忙，先不聊了',v=>{v.summary='用户暂时忙碌，不等于关系变差'},{reference:false,concern:'closed'});
assert.equal(c.snapshot(key).relation.trust,.5);assert.equal(c.snapshot(key).relation.tension,0);
const result={version:'0.9.0',mode:'固定模型返回的机制模拟，不代表真实模型语义准确率',modelCallsSimulated:calls,passed:true,steps};
const output=JSON.stringify(result,null,2)+'\n';if(process.argv[2])fs.writeFileSync(process.argv[2],output);else process.stdout.write(output);
console.error('Continuity scenario OK: '+steps.length+' turns; no network or paid calls.');
