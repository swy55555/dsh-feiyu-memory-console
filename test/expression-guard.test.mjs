import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import crypto from 'node:crypto';
import {once} from 'node:events';
import {ExpressionGuard,inspectExpression,expressionSettings,DEFAULT_EXPRESSION_RULES} from '../bridge/expression-guard.mjs';
import {privateReplyGuard} from '../bridge/reply-freshness.mjs';
import {replyReference} from '../bridge/reply-context.mjs';
import {emotionAttribution} from '../bridge/emotion.js';

test('narrow phrases block complete batches without changing text; warnings never reject',()=>{
 for(const text of ['这条我认。','这话我不接','这份心意我收下了','这 条 我 认','这\u200b条我认'])assert.equal(inspectExpression([text]).hard.length,1,text);
 const messages=['第一条正常','这话我不接'];const before=structuredClone(messages);assert.equal(inspectExpression(messages).hard.length,1);assert.deepEqual(messages,before);
 for(const text of ['我不接受这个结论，证据不足。','我不是不愿意，是今天确实没时间。','值得一提的是，这次已经处理完。','你越纠正，我越不会说话。'])assert.equal(inspectExpression([text]).hard.length,0,text);
 assert.ok(inspectExpression(['我不是不愿意，是今天确实没时间。']).warnings.length);
});
test('balanced discussion quotes/code are exceptions; putting a catchphrase in quotes alone is not',()=>{
 for(const text of ['你刚才说“这条我认”，听着像汇报。','“这话我不接”这种句式不合适。','例如「这份心意我收下了」。','const x = `这话我不接`;','```js\nconst x="这条我认";\n```'])assert.equal(inspectExpression([text]).hard.length,0,text);
 for(const text of ['“这条我认”','我就说“这话我不接”。','你刚才说“这条我认，后面的引号没闭合','例如“别的内容”。这话我不接。'])assert.equal(inspectExpression([text]).hard.length,1,text);
});
test('one rewrite opportunity per actor/input survives restart, does not borrow another chat, and recovers on new input',()=>{
 let stored;const g=new ExpressionGuard({save:x=>stored=structuredClone(x)}),args={actor:'private:1',turn:'1:1000',key:'group:2',messages:['这条我认']};
 assert.equal(g.check(args).code,'EXPRESSION_REWRITE_REQUIRED');assert.equal(g.check({...args,messages:['刚才那项数据不对。']}).ok,true);
 assert.equal(g.check(args).code,'EXPRESSION_REWRITE_LIMIT');assert.equal(g.check({...args,messages:['正常话也不能再自动重试']}).ok,false);
 const reloaded=new ExpressionGuard({load:()=>stored});assert.equal(reloaded.blocked(args.actor,args.turn),true);
 assert.equal(reloaded.check({...args,actor:'private:3',messages:['正常回复']}).ok,true);
 assert.equal(reloaded.check({...args,turn:'2:1001',messages:['正常回复']}).ok,true);
 const v=g.view();g.configure({...v.settings,enabled:false},v.revision);assert.equal(g.check(args).ok,true);
});
test('validated literal settings use optimistic revision; audit omits full draft and has a finite size',()=>{
 const g=new ExpressionGuard();const v=g.view();assert.throws(()=>g.configure(v.settings,'old'));
 for(const patch of [{hard:['我']},{soft:['x\ny']},{hard:['这条我认'],soft:['这条我认']},{enabled:'yes'}])assert.throws(()=>expressionSettings({...DEFAULT_EXPRESSION_RULES,...patch}));
 const configured=g.configure({...v.settings,hard:['不要这句']},v.revision);assert.ok(configured.revision!==v.revision);
 for(let i=0;i<100;i++)g.check({actor:'private:1',turn:String(i),key:'private:1',messages:['不要这句，以及其他未存入记录的私密内容']});
 assert.equal(g.view().events.length,80);assert.ok(!JSON.stringify(g.view()).includes('私密内容'));
});

const src=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
function between(a,b){const start=src.indexOf(a),end=src.indexOf(b,start);assert.ok(start>=0&&end>start,a);return src.slice(start,end);}
async function fixture(t){
 const sent=[],stops=[],activities=[],timers=[];
 const states=new Map(['private:1','group:2','private:3'].map((key,i)=>[key,{agentToken:'agent-'+i,lastUnreadSeq:1,lastIncomingAt:1000,lastReadThroughSeq:1,sendTimes:[],wakeConfig:{}}]));
 const guard=new ExpressionGuard();const sandbox={http,crypto,Buffer,URL,process,console,setTimeout,clearTimeout,
  cfg:{consolePort:0,consoleToken:'fixture-console-token-1234',ownerQQ:'1',socialV2:{send:{}}},currentMode:'reserved2',socialV2:{conversations:states,paused:false},state:{sessions:{'private:1':'s1','group:2':'s2','private:3':'s3'}},
  expressionGuard:guard,privateReplyGuard,replyReference,emotionAttribution,canonicalV2Key:k=>states.has(k)?k:null,isSessionAllowedInCurrentMode:k=>states.has(k),modeAllowed:k=>states.has(k),v2ToolEnabled:()=>true,
  getSocialV2State:k=>states.get(k),readThroughSeqV2:s=>s.lastReadThroughSeq,shouldBlockSilentReply:()=>false,SENSITIVE_RE:/PRIVATE_SECRET/,unquoteJsonString:s=>s,
  appendActivity:x=>activities.push(x),log:()=>{},saveSocialV2State:()=>{},recordSentMessagesV2:()=>{},scheduleReplyCheckV2:()=>{},computeGapsV2:()=>[],findCjkSpaceWarning:()=>null,findSplitBoundaryWarning:()=>null,
  resolveReplyTargetV2:async()=>({info:{},messageId:'123'}),sendChain:Promise.resolve(),captureSendGuard:()=>()=>{},onebotSend:async(k,id,msg)=>sent.push({k,id,msg}),noteMemeUse:()=>{},sleep:async()=>{},api:{stopSessionWork:async id=>stops.push(id)},
  mindWorkspaceEnabled:k=>k==='private:1',continuity:{replyState:()=>({messageId:'m1',interaction:{intent:'feedback',focus:'repair',boundary:'none',meaning:'明确反馈',quote:'别这样说'}})},emotionViewFor:()=>null,responsePatterns:{enabled:()=>false},
 };
 const context=vm.createContext(sandbox);
 // The real console function and real shared helpers are evaluated as siblings,
 // so this catches the previous console-local authentication closure regression.
 const code=between('  const tokenEq =','  function startConsoleServer(')+between('  function expressionTurn(','  const referenceReuse =')+between('  function capturePrivateReplyGuard(','  // 审计范围')+between('  function responseReferenceV2(','  function noteModelMessagesV2(')+between('  function startConsoleServer(','  // 会话代际：')+';({server:startConsoleServer(),reference:responseReferenceV2,dispatchBlocked:expressionDispatchBlocked,check:checkExpressionSend})';
 const bound=vm.runInContext(code,context);await once(bound.server,'listening');t.after(()=>new Promise(resolve=>{bound.server.closeAllConnections();bound.server.close(resolve)}));
 const url='http://127.0.0.1:'+bound.server.address().port;
 async function request(route,body,token='agent-0',consoleAuth=true){
  const headers={'content-type':'application/json',...(consoleAuth?{'x-console-token':sandbox.cfg.consoleToken}:{}),...(token!==null?{'x-agent-call':'1','x-agent-token':token}:{})};
  const res=await fetch(url+route,{method:body?'POST':'GET',headers,...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,...await res.json()};
 }
 const next=key=>{const s=states.get(key);s.lastUnreadSeq++;s.lastReadThroughSeq=s.lastUnreadSeq;s.lastIncomingAt++;};
 return {request,states,sent,stops,activities,guard,bound,next,sandbox};
}
test('real HTTP send routes reject before reservation or delivery, allow a clean rewrite, and stop only the actor after retry',async t=>{
 const f=await fixture(t);
 const routes=[['/api/socialV2/send-message',{key:'private:1',messages:['先别发这句','这条我认']}],['/api/socialV2/send-burst',{key:'private:1',messages:['这话我不接']}],['/api/send/private',{userId:'1',token:'agent-0',message:'这份心意我收下了'}],['/api/send/group',{groupId:'2',token:'agent-0',message:'这条我认'}],['/api/send/reply',{groupId:'2',token:'agent-0',replyToMessageId:'123',message:'这话我不接'}]];
 for(const [route,body] of routes){
  f.next('private:1');const sent=f.sent.length,before=f.states.get('private:1').sendTimes.length;
  const r=await f.request(route,body);assert.equal(r.code,'EXPRESSION_REWRITE_REQUIRED',JSON.stringify(r));assert.equal(r.sent,0);assert.equal(f.sent.length,sent);assert.equal(f.states.get('private:1').sendTimes.length,before);
 }
 f.next('private:1');const r=await f.request('/api/socialV2/send-message',{key:'private:1',messages:'这条我认'});assert.equal(r.ok,false);
 const clean=await f.request('/api/socialV2/send-message',{key:'private:1',messages:'我不是不愿意，是今天确实没时间。'});assert.equal(clean.ok,true,JSON.stringify(clean));assert.ok(clean.expressionWarnings.length);assert.equal(f.sent.at(-1).msg,'我不是不愿意，是今天确实没时间。');
 const stopped=await f.request('/api/socialV2/send-message',{key:'group:2',messages:'这话我不接'});assert.equal(stopped.code,'EXPRESSION_REWRITE_LIMIT');await new Promise(r=>setTimeout(r,20));assert.deepEqual(f.stops,['s1']);assert.equal(f.bound.dispatchBlocked('private:1'),true);assert.equal(f.bound.dispatchBlocked('group:2'),false);
 const bypass=await f.request('/api/socialV2/send-voice',{key:'group:2',text:'attempt'});assert.equal(bypass.code,'EXPRESSION_REWRITE_LIMIT');
 f.next('private:1');assert.equal(f.bound.dispatchBlocked('private:1'),false);
 assert.equal((await f.request('/api/socialV2/send-message',{key:'private:1',messages:'继续聊。'})).ok,true);
});
test('real admin API rejects models/unauthorized writes; current reference and stale private guards resolve the shared auth helper',async t=>{
 const f=await fixture(t);
 assert.equal((await f.request('/api/expression-rules',undefined,'agent-0')).status,403);
 assert.equal((await f.request('/api/expression-rules',undefined,null,false)).status,401);
 const view=await f.request('/api/expression-rules',undefined,null);assert.equal(view.ok,true);
 const changed=await f.request('/api/expression-rules',{revision:view.revision,settings:{...view.settings,hard:['不要这句']}},null);assert.equal(changed.ok,true);
 assert.equal((await f.request('/api/expression-rules',{revision:view.revision,settings:view.settings},null)).ok,false);
 const fresh=f.bound.reference('private:1',f.states.get('private:1'),[{messageId:'m1',seq:1,isSelf:false}],'agent-0');assert.equal(fresh.status,'ready');assert.ok(fresh.replyGuide);
 assert.equal(f.bound.reference('private:1',f.states.get('private:1'),[{messageId:'m1',seq:1,isSelf:false}],'agent-1'),undefined);
 f.states.get('private:1').lastUnreadSeq=2;
 const stale=await f.request('/api/socialV2/send-message',{key:'private:1',messages:'不要这句'});assert.equal(stale.code,'NEW_PRIVATE_INPUT');assert.equal(f.guard.view().events.length,0);
 assert.equal((await f.request('/api/socialV2/send-message',{key:'private:1',messages:'hello'},'wrong')).status,403);
});
test('a new input arriving before the scheduled stop cannot cancel its work',async t=>{
 const f=await fixture(t);
 f.bound.check('private:1',['这条我认'],'agent-0');f.bound.check('private:1',['这条我认'],'agent-0');f.next('private:1');await new Promise(r=>setTimeout(r,20));assert.deepEqual(f.stops,[]);
});
test('group actors and other private actors use the same rules without sharing attempts',async t=>{
 const f=await fixture(t);
 for(const [key,token] of [['group:2','agent-1'],['private:3','agent-2']]){
  const r=await f.request('/api/socialV2/send-message',{key,messages:'这条我认'},token);assert.equal(r.code,'EXPRESSION_REWRITE_REQUIRED');assert.match(r.error,/这条我认/);
  assert.equal((await f.request('/api/socialV2/send-message',{key,messages:'你刚才说“这条我认”，这句说法不合适。'},token)).ok,true);
 }
 assert.equal(f.guard.view().events.filter(r=>r.status==='rewrite').length,2);assert.deepEqual(f.stops,[]);
});
