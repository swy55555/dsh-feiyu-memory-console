import test from 'node:test';
import assert from 'node:assert/strict';
import {Continuity,parseContinuity} from '../bridge/continuity.mjs';
const KEY='private:1',DAY=86400000;
const neutral=()=>({summary:'普通交流',appraisal:{kind:'neutral',target:'none',confidence:.95,intensity:0,evidence:[]},concerns:[],beliefs:[],focusIds:[],relationship:{kind:'none',quote:''}});
function fixture(options={}){
  let now=100*DAY,enabled=true,saved=null,calls=0,value=neutral(),id=0;
  const c=new Continuity({enabled:()=>enabled,allowed:k=>k===KEY,now:()=>now,load:()=>saved,save:v=>{saved=structuredClone(v)},generate:async()=>{calls++;return typeof value==='function'?value():JSON.stringify(value)},...options});
  return {c,get calls(){return calls},get saved(){return saved},set value(v){value=v},set now(v){now=v},set enabled(v){enabled=v},
    async say(body,messageId=String(++id)){return c.observe(KEY,{text:body},c.begin(KEY,messageId));},snap:()=>c.snapshot(KEY)};
}
function concern(quote,more={}){return {id:'',action:'open',title:'明天的面试',detail:'尚不知道结果',quote,ttlHours:72,...more};}
function belief(quote,more={}){return {id:'',action:'propose',text:'也许在担心面试表现',quote,evidenceKind:'new',...more};}

test('interview → unrelated code → correction → completion retains only relevant, revisable context',async()=>{
  const f=fixture(),n=neutral();n.concerns=[concern('明天面试')];n.beliefs=[belief('有点紧张')];f.value=n;
  await f.say('明天面试，有点紧张');
  let s=f.snap();const cid=s.concerns[0].id,bid=s.beliefs[0].id;
  assert.match(f.c.prompt(KEY,{}),/面试/);assert.equal(s.beliefs[0].status,'tentative');
  f.value=neutral();await f.say('先帮我看看代码');
  assert.equal(f.c.prompt(KEY,{}),'');assert.equal(f.snap().concerns[0].status,'open');
  const correction=neutral();correction.beliefs=[belief('担心赶不上车',{id:bid,action:'revise',text:'可能担心交通时间，而不是面试表现'})];correction.concerns=[concern('担心赶不上车',{id:cid,action:'update',detail:'担心交通安排'})];f.value=correction;
  await f.say('其实不是怕面试，是担心赶不上车');s=f.snap();
  assert.equal(s.beliefs[0].evidence.length,1);assert.equal(s.beliefs[0].revisions[0].text,'也许在担心面试表现');
  assert.doesNotMatch(f.c.prompt(KEY,{}),/也许在担心面试表现/);
  const done=neutral();done.concerns=[concern('面试完啦',{id:cid,action:'close',detail:'已顺利结束'})];done.beliefs=[belief('挺顺利',{id:bid,action:'reject'})];f.value=done;
  await f.say('面试完啦，挺顺利');assert.equal(f.snap().concerns[0].status,'closed');assert.equal(f.c.prompt(KEY,{}),'');assert.equal(f.c.idleQuery(KEY),'');
  assert.deepEqual(f.snap().relation,{trust:.5,familiarity:0,tension:0,days:[],day:100,used:0});
});
test('only real current quotes and known IDs accepted; invalid batch commits no partial updates',async()=>{
  const f=fixture(),n=neutral();n.concerns=[concern('明天面试')];n.beliefs=[belief('凭空想象')];f.value=n;
  assert.equal(await f.say('明天面试'),null);assert.equal(f.snap().concerns.length,0);
  n.beliefs=[];n.concerns[0].id='foreign';n.concerns[0].action='update';f.value=n;
  assert.equal(await f.say('明天面试'),null);assert.equal(f.snap().events.at(-1).status,'unavailable');
});
test('three separated days support a revisable recognition, copies and duplicated events do not',async()=>{
  const f=fixture(),n=neutral();n.beliefs=[belief('这次又提前检查了路线')];f.value=n;
  await f.say('这次又提前检查了路线','one');const id=f.snap().beliefs[0].id;
  await f.say('这次又提前检查了路线','one');assert.equal(f.calls,1);
  const support=quote=>({...neutral(),beliefs:[belief(quote,{id,action:'support',text:'不能偷偷替换成新的认识'})]});
  f.value=support('这次又提前检查了路线');f.now=101*DAY;await f.say('这次又提前检查了路线');assert.equal(f.snap().beliefs[0].evidence.length,1);
  f.value=support('我今天也先看了交通');f.now=102*DAY;await f.say('我今天也先看了交通');
  f.value=support('这回出发前还是查了时间');f.now=104*DAY;await f.say('这回出发前还是查了时间');
  const row=f.snap().beliefs[0];assert.equal(row.status,'observed');assert.equal(row.confidence,.6);assert.equal(row.text,'也许在担心面试表现');
  f.value={...neutral(),beliefs:[belief('只是巧合',{id,action:'revise',text:'也许只是这几次行程比较特殊'})]};await f.say('只是巧合');
  assert.equal(f.snap().beliefs[0].status,'tentative');assert.equal(f.snap().beliefs[0].evidence.length,1);
});
test('new messages invalidate an in-flight generation and its stale reply focus',async()=>{
  const f=fixture();let resolve;
  f.value=()=>new Promise(r=>resolve=r);
  const first=f.say('明天面试');f.c.begin(KEY,'new');
  resolve(JSON.stringify({...neutral(),concerns:[concern('明天面试')]}));
  assert.equal(await first,null);assert.equal(f.snap().concerns.length,0);assert.equal(f.snap().events.at(-1).status,'interrupted');
});
test('disable then re-enable cannot apply a pending old analysis',async()=>{
  const f=fixture();let resolve;f.value=()=>new Promise(r=>resolve=r);const first=f.say('明天面试');
  f.enabled=false;f.c.invalidate();f.enabled=true;resolve(JSON.stringify({...neutral(),concerns:[concern('明天面试')]}));await first;
  assert.equal(f.snap().concerns.length,0);
});
test('manual rejection invalidates pending updates and isolates owner scope',async()=>{
  const f=fixture();f.value={...neutral(),beliefs:[belief('有点紧张')]};await f.say('有点紧张');const id=f.snap().beliefs[0].id;
  let resolve;f.value=()=>new Promise(r=>resolve=r);const pending=f.say('今天也紧张');
  f.c.edit(KEY,{collection:'beliefs',id,action:'reject'});resolve(JSON.stringify({...neutral(),beliefs:[belief('今天也紧张',{id,action:'support'})]}));await pending;
  assert.equal(f.snap().beliefs[0].status,'rejected');assert.throws(()=>f.c.edit('private:2',{collection:'beliefs',id,action:'reject'}));
  assert.deepEqual(f.c.snapshot('private:2').beliefs,[]);assert.equal(f.c.prompt('private:2',{}),'');
});
test('pause and TTL survive restart, but last-turn focus never does',async()=>{
  const f=fixture();f.value={...neutral(),concerns:[concern('明天面试')]};await f.say('明天面试');const id=f.snap().concerns[0].id;
  const c=new Continuity({enabled:()=>true,allowed:k=>k===KEY,generate:()=>{throw Error('should not call')},load:()=>f.saved,now:()=>101*DAY});
  assert.equal(c.snapshot(KEY).concerns[0].status,'open');assert.equal(c.prompt(KEY,{}),'');
  c.edit(KEY,{collection:'concerns',id,action:'pause'});assert.equal(c.idleQuery(KEY),'');
  f.now=104*DAY;assert.equal(f.snap().concerns[0].status,'expired');assert.equal(f.c.prompt(KEY,{}),'');
});
test('ordinary absence, user distress, tasks and reported speech cannot change relationship via invalid pairing',async()=>{
  const f=fixture();
  for(const [kind,target] of [['neutral','none'],['user_distress','user'],['criticism','task'],['third_party','third_party']]){
    f.value={...neutral(),appraisal:{kind,target,confidence:1,intensity:1,evidence:['我今天忙']},relationship:{kind:'distrust',quote:'我今天忙'}};
    await f.say('我今天忙');assert.equal(f.snap().relation.trust,.5);assert.equal(f.snap().relation.tension,0);
  }
});
test('explicit relationship changes are bounded, deduplicated and do not automatically recover trust',async()=>{
  const f=fixture();f.value={...neutral(),appraisal:{kind:'conflict',target:'character',confidence:.95,intensity:.8,evidence:['我不信任你']},relationship:{kind:'distrust',quote:'我不信任你'}};
  for(let i=0;i<5;i++)await f.say('我不信任你');assert.equal(f.snap().relation.trust,.48);assert.equal(f.snap().relation.tension,.06);
  f.now=101*DAY;f.value={...neutral(),appraisal:{kind:'repair',target:'character',confidence:.95,intensity:.8,evidence:['对不起']},relationship:{kind:'repair',quote:'对不起'}};
  await f.say('对不起');assert.equal(f.snap().relation.trust,.48);assert.equal(f.snap().relation.tension,.03);
});
test('timeout, malformed output, long input and sensitive ticket all fail closed without blocking chat',async()=>{
  const f=fixture({timeoutMs:10});f.value=()=>new Promise(()=>{});assert.equal(await f.say('明天面试'),null);
  f.value=()=>'{invalid';assert.equal(await f.say('一条新消息'),null);
  const before=f.calls;await f.say('x'.repeat(2001));await f.c.observe(KEY,{text:'敏感'},f.c.begin(KEY,'secret',false));assert.equal(f.calls,before);
  assert.equal(f.c.prompt(KEY,{}),'');
});
test('disabled mode neither calls models nor injects retained records',async()=>{
  const f=fixture();f.enabled=false;await f.say('明天面试');assert.equal(f.calls,0);assert.equal(f.c.prompt(KEY,{}),'');
});
test('beliefs fade without compounding on refresh, and repeated quotes never extend the deadline',async()=>{
  const f=fixture();f.value={...neutral(),beliefs:[belief('这次出门先查了路线')]};await f.say('这次出门先查了路线');
  const original=f.snap().beliefs[0],id=original.id;f.now=107*DAY;
  assert.equal(f.snap().beliefs[0].confidence,.175);assert.equal(f.snap().beliefs[0].confidence,.175);
  f.value={...neutral(),beliefs:[belief('这次出门先查了路线',{id,action:'support'})]};
  await f.say('补充一句，这次出门先查了路线');let row=f.snap().beliefs[0];
  assert.equal(row.expiresAt,original.expiresAt);assert.equal(row.lastEvidenceAt,original.lastEvidenceAt);assert.equal(row.confidence,.175);
  assert.equal(row.evidence.length,1);assert.equal(f.snap().events.at(-1).changes[0].action,'repeat-evidence');
  f.now=130*DAY;assert.equal(f.snap().beliefs[0].status,'expired');
});
test('rephrasing an old experience and uncertain novelty do not refresh; valid new experiences do',async()=>{
  const f=fixture();f.value={...neutral(),beliefs:[belief('上周去车站查了路线')]};await f.say('上周去车站查了路线');
  const old=f.snap().beliefs[0],id=old.id;f.now=109*DAY;
  for(const evidenceKind of ['repeat','uncertain']){
    f.value={...neutral(),beliefs:[belief('那次我也是先看地图再出门',{id,action:'support',evidenceKind})]};
    await f.say('那次我也是先看地图再出门');assert.equal(f.snap().beliefs[0].expiresAt,old.expiresAt);
  }
  f.value={...neutral(),beliefs:[belief('今天去新医院前查了另一个路线',{id,action:'support',evidenceKind:'new'})]};
  await f.say('今天去新医院前查了另一个路线');const renewed=f.snap().beliefs[0];
  assert.equal(renewed.lastEvidenceAt,109*DAY);assert.equal(renewed.expiresAt,139*DAY);assert.equal(renewed.confidence,.35);
});
test('restart derives legacy deadline from actual evidence; faded hypotheses stop entering replies',async()=>{
  const f=fixture();f.value={...neutral(),beliefs:[belief('可能担心赶车')]};await f.say('可能担心赶车');
  const saved=f.saved,row=saved.chats[0][1].beliefs[0];delete row.lastEvidenceAt;delete row.baseConfidence;row.updatedAt=120*DAY;row.expiresAt=150*DAY;
  const c=new Continuity({enabled:()=>true,allowed:k=>k===KEY,now:()=>112*DAY,load:()=>saved,generate:async()=>JSON.stringify({...neutral(),focusIds:[row.id]})});
  assert.equal(c.snapshot(KEY).beliefs[0].expiresAt,130*DAY);
  await c.observe(KEY,{text:'提起那次赶车'},c.begin(KEY,'fresh'));
  assert.equal(c.prompt(KEY,{}),'');assert.ok(c.snapshot(KEY).beliefs[0].confidence<.12);
});
test('repeating an expired experience cannot create a fresh copy of the hypothesis',async()=>{
  const f=fixture();f.value={...neutral(),beliefs:[belief('上次面试先查了路线')]};await f.say('上次面试先查了路线');
  const original=f.snap().beliefs[0];f.now=131*DAY;assert.equal(f.snap().beliefs[0].status,'expired');
  f.value={...neutral(),beliefs:[belief('上次面试先查了路线',{text:'可能习惯提前规划路线'})]};await f.say('补充，上次面试先查了路线');
  assert.equal(f.snap().beliefs.length,1);assert.equal(f.snap().beliefs[0].expiresAt,original.expiresAt);assert.equal(f.snap().beliefs[0].status,'expired');
});
test('timed-out remote work retains concurrency slots; no unbounded paid retries',async()=>{
  const f=fixture({timeoutMs:5});const resolvers=[];f.value=()=>new Promise(r=>resolvers.push(r));
  await f.say('第一条消息');await f.say('第二条消息');await f.say('第三条消息');
  assert.equal(f.calls,2);assert.equal(f.snap().events.at(-1).status,'busy');
  resolvers.forEach(r=>r(JSON.stringify(neutral())));await new Promise(r=>setImmediate(r));
  f.value=neutral();await f.say('恢复后的消息');assert.equal(f.calls,3);
});
test('schema rejects the wrong text field and cannot revive a rejected identical hypothesis',()=>{
  const v={...neutral(),beliefs:[{id:'',action:'propose',title:'错误字段',quote:'原话'}]};
  assert.throws(()=>parseContinuity(JSON.stringify(v),'原话',{concerns:[],beliefs:[]}));
  v.beliefs=[belief('原话')];assert.throws(()=>parseContinuity(JSON.stringify(v),'原话',{concerns:[],beliefs:[{id:'b',text:v.beliefs[0].text,status:'rejected'}]}));
});
test('prompt delivery and QQ reply outcomes correlate to the actual source event',async()=>{
  const f=fixture();f.value={...neutral(),concerns:[concern('明天面试')]};const result=await f.say('明天面试');
  const ctx={traceId:'trace-1'};f.c.prompt(KEY,ctx);f.c.delivery(ctx.continuity,'injected');
  f.c.reply({key:KEY,traceId:'unrelated',status:'sent',sent:1});assert.equal(f.snap().events.filter(e=>e.status==='reply-result').length,0);
  f.c.reply({key:KEY,traceId:'trace-1',status:'failed',sent:0});const last=f.snap().events.at(-1);
  assert.equal(last.eventId,result.id);assert.equal(last.replyStatus,'failed');
});
test('persistence failures are visible, audit is bounded, generated support cannot reuse old evidence for a new hypothesis',async()=>{
  const f=fixture({save:()=>{throw Error('disk full')}});await f.say('你好');assert.equal(f.snap().storageError,true);
  const state={concerns:[],beliefs:[{id:'b',text:'旧认识',status:'tentative'}]};
  assert.throws(()=>parseContinuity(JSON.stringify({...neutral(),beliefs:[belief('原话',{id:'b',action:'propose',text:'新认识'})]}),'原话',state));
  for(let i=0;i<70;i++)await f.say('普通聊天'+i);assert.equal(f.snap().events.length,60);
});
