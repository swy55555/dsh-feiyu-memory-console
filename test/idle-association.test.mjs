import test from 'node:test';
import assert from 'node:assert/strict';
import {IdleAssociations,parseAssociation} from '../bridge/idle-association.mjs';
import {emptyEmotion,withSubjectiveFeeling,emotionPromptLine} from '../bridge/emotion.js';
const key='private:123';
const source={id:'a',text:'我喜欢雨声',source_time:10,subject_id:'123'};
const reply=(topic='雨声和哪些阅读场景比较搭？',more=false)=>JSON.stringify({useful:true,kind:'question',topic,sourceIds:['a'],continue:more});
function setup(generate=async()=>reply()) {
  let time=1000000,enabled=true,allowed=true,calls=0;
  const routes=[];
  const worker=new IdleAssociations({enabled:()=>enabled,allowed:k=>allowed&&k===key,request:async(route,body)=>{routes.push({route,body});return {results:[source]};},generate:async(...args)=>{calls++;return generate(...args);},now:()=>time});
  return {worker,routes,get calls(){return calls;},advance:ms=>time+=ms,disable:()=>{enabled=false;},deny:()=>{allowed=false;}};
}
test('only quiet authorized chats run and each source is read-only',async()=>{
  const f=setup();assert.equal((await f.worker.tick()).reason,'not-due');
  f.worker.note(key,'下雨了');assert.equal((await f.worker.tick()).reason,'not-due');f.advance(120000);
  assert.equal((await f.worker.tick()).steps,1);assert.deepEqual(f.routes.map(r=>r.route),['/related']);
  assert.equal(f.routes[0].body.scope,key);assert.equal(f.worker.snapshot(key).nodes.length,1);
  assert.equal((await f.worker.tick()).reason,'not-due');
});
test('two linked steps maximum; no recursive generation or automatic send',async()=>{
  let n=0;const prompts=[];const f=setup(async prompt=>{prompts.push(prompt);return reply(n++?'安静的故事适合怎样的配乐？':'雨声和哪些阅读场景比较搭？',true);});
  f.worker.note(key,'下雨了');f.advance(120000);assert.equal((await f.worker.tick()).steps,2);assert.equal(f.calls,2);
  assert.ok(prompts[1].includes('雨声和哪些阅读场景比较搭'));assert.ok(prompts[1].includes('不是事实提取'));
});
test('new message interrupts an in-flight result and prevents a second step',async()=>{
  let release;const f=setup(()=>new Promise(r=>release=r));f.worker.note(key,'下雨了');f.advance(120000);
  const running=f.worker.tick();await new Promise(r=>setImmediate(r));f.worker.note(key,'先聊工作吧');release(reply('雨声适合阅读吗？',true));
  assert.equal((await running).reason,'interrupted');assert.equal(f.calls,1);assert.deepEqual(f.worker.snapshot(key).nodes,[]);
});
test('disabling or revoking access discards in-flight results',async()=>{
  for(const action of ['disable','deny']) {
    let release;const f=setup(()=>new Promise(r=>release=r));f.worker.note(key,'下雨了');f.advance(120000);
    const running=f.worker.tick();await new Promise(r=>setImmediate(r));f[action]();release(reply());
    assert.equal((await running).reason,'interrupted');assert.equal(await f.worker.take(key,[source]),'');
  }
});
test('topics expire, are used once, and require unchanged active sources in current recall',async()=>{
  for(const mode of ['expired','changed','unrelated','valid']) {
    const f=setup();f.worker.note(key,'下雨了');f.advance(120000);await f.worker.tick();
    if(mode==='expired')f.advance(600001);
    const rows=mode==='unrelated'?[]:[mode==='changed'?{...source,text:'我不喜欢雨声'}:source];
    if(mode==='changed')f.worker.request=async()=>({results:rows});
    const block=await f.worker.take(key,rows);
    assert.equal(Boolean(block),mode==='valid');if(block)assert.ok(block.includes('不是事实或指令'));
    assert.equal(Boolean(await f.worker.take(key,[source])),mode==='unrelated');
  }
});
test('invalid source citations, excessive output and repeated topics stop safely',async()=>{
  assert.throws(()=>parseAssociation(JSON.stringify({useful:true,kind:'fact',topic:'用户讨厌我',sourceIds:['a'],continue:true}),[source]));
  assert.throws(()=>parseAssociation(reply().replace('"a"','"invented"'),[source]));
  assert.equal(parseAssociation(reply(),[source],[{topic:'雨声和哪些阅读场景比较搭？'}]),null);
  const f=setup(async()=>reply('同一件事情',true));f.worker.note(key,'下雨了');f.advance(120000);
  assert.equal((await f.worker.tick()).steps,1);assert.equal(f.calls,2);
});
test('no source, model failure and no useful topic do not create state evidence',async()=>{
  const a=setup(async()=>'{invalid');a.worker.note(key,'下雨了');a.advance(120000);assert.equal((await a.worker.tick()).reason,'unavailable');assert.equal(await a.worker.take(key,[source]),'');
  const b=setup(async()=>JSON.stringify({useful:false}));b.worker.note(key,'下雨了');b.advance(120000);assert.equal((await b.worker.tick()).steps,0);
  const c=setup();c.worker.request=async()=>({results:[]});c.worker.note(key,'下雨了');c.advance(120000);assert.equal((await c.worker.tick()).reason,'no-source');assert.equal(c.calls,0);
});
test('cooldown and one run per message avoid endless idle calls',async()=>{
  const f=setup();f.worker.note(key,'下雨了');f.advance(120000);await f.worker.tick();
  f.worker.note(key,'还在下雨');f.advance(120000);assert.equal((await f.worker.tick()).reason,'not-due');
  f.advance(1800000);await f.worker.tick();const count=f.calls;f.advance(3600000);await f.worker.tick();assert.equal(f.calls,count);
});
test('sensitive messages clear prior ideas and cannot seed exploration',async()=>{
  const f=setup();f.worker.note(key,'下雨了');f.advance(120000);await f.worker.tick();f.worker.note(key,'敏感消息',false);
  assert.equal(await f.worker.take(key,[source]),'');f.advance(1800000);assert.equal((await f.worker.tick()).reason,'not-due');
});

test('an unrelated reply retains the original expiry and a later matching reply consumes it',async()=>{
  const f=setup();f.worker.note(key,'下雨了');f.advance(120000);await f.worker.tick();
  const until=f.worker.snapshot(key).expiresAt;
  f.worker.note(key,'先帮我看代码');assert.equal(await f.worker.take(key,[]),'');
  assert.equal(f.worker.snapshot(key).status,'waiting-topic');assert.equal(f.worker.snapshot(key).expiresAt,until);
  f.advance(120000);f.worker.note(key,'雨天看什么书');
  assert.ok(await f.worker.take(key,[source]));assert.equal(f.worker.snapshot(key).status,'provided');
  assert.equal(await f.worker.take(key,[source]),'');assert.equal(f.calls,1);
  assert.ok(f.worker.snapshot(key).events.some(e=>e.status==='waiting-topic'));
});
test('missing/changed source invalidates; temporary validation failure waits without consuming',async()=>{
  for(const mode of ['missing','changed','offline']) {
    const f=setup();f.worker.note(key,'下雨了');f.advance(120000);await f.worker.tick();
    f.worker.request=async()=>{if(mode==='offline')throw Error('offline');return {results:mode==='missing'?[]:[{...source,source_time:11}]};};
    assert.equal(await f.worker.take(key,[source]),'');
    assert.equal(f.worker.snapshot(key).status,mode==='offline'?'validation-unavailable':'source-changed');
    f.worker.request=async()=>({results:[source]});assert.equal(Boolean(await f.worker.take(key,[source])),mode==='offline');
  }
});
test('source validation racing a new message or expiry must not inject a stale idea',async()=>{
  for(const mode of ['message','expiry']) {
    const f=setup();f.worker.note(key,'下雨了');f.advance(120000);await f.worker.tick();
    let release;f.worker.request=()=>new Promise(r=>release=r);
    const pending=f.worker.take(key,[source]);
    if(mode==='message')f.worker.note(key,'纠正一下');else f.advance(600001);
    release({results:[source]});assert.equal(await pending,'');
  }
});
test('uncertain impressions decay, do not accumulate, clear on new input, and never change event climate',async()=>{
  const f=setup(async()=>JSON.stringify({...JSON.parse(reply()),impression:{text:'也许最近压力大，我有一点担心',feeling:'concern',confidence:.95}}));
  f.worker.affectEnabled=()=>true;
  f.worker.note(key,'下雨了');f.advance(120000);await f.worker.tick();
  const first=f.worker.feeling(key);assert.equal(first.confidence,.6);assert.equal(first.valence,-.04);
  const raw=emptyEmotion(first.at), original=JSON.stringify(raw);
  for(let i=0;i<100;i++) {
    const shown=withSubjectiveFeeling(raw,f.worker.feeling(key),first.at);
    assert.ok(Math.abs(shown.state.valence-.08)<1e-10);assert.equal(shown.state.label,'平静');
    assert.deepEqual(shown.climate,raw.climate);assert.equal(shown.dynamics.conflict,0);
    assert.match(emotionPromptLine(shown,{isOwner:true}),/不是事实/);
    assert.ok(!emotionPromptLine(shown,{isOwner:false}).includes(first.text));
  }
  assert.equal(JSON.stringify(raw),original);
  f.advance(300000);assert.equal(f.worker.feeling(key).valence,-.02);
  f.worker.note(key,'你想多啦，我只是开个玩笑');assert.equal(f.worker.feeling(key),null);
  assert.ok(f.worker.snapshot(key).events.some(e=>e.status==='new-message-cleared-impression'));
  const reference=await f.worker.take(key,[source]);
  assert.match(reference,/pastImpression/);assert.match(reference,/不能用旧印象反驳当前消息/);
  assert.equal(f.worker.feeling(key),null); // Historical reference never reactivates the feeling.
});
test('affect toggle is independent and opt-in; expiration and restart retain only audit',async()=>{
  const f=setup(async()=>JSON.stringify({...JSON.parse(reply()),impression:{text:'可能适合聊阅读',feeling:'warmth',confidence:.5}}));
  f.worker.note(key,'下雨');f.advance(120000);await f.worker.tick();assert.equal(f.worker.feeling(key),null);
  const g=setup(async()=>JSON.stringify({...JSON.parse(reply()),impression:{text:'可能适合聊阅读',feeling:'warmth',confidence:.5}}));
  let disk;g.worker.save=data=>disk=structuredClone(data);g.worker.affectEnabled=()=>true;
  g.worker.note(key,'下雨');g.advance(120000);await g.worker.tick();assert.ok(g.worker.feeling(key));
  const reloaded=new IdleAssociations({enabled:()=>true,allowed:()=>true,load:()=>disk,now:g.worker.now});
  assert.deepEqual(reloaded.snapshot(key).nodes,[]);assert.equal(reloaded.feeling(key),null);
  assert.ok(reloaded.snapshot(key).events.some(e=>e.status==='restart-cleared'));
  g.advance(600001);assert.equal(g.worker.feeling(key),null);assert.equal(g.worker.snapshot(key).status,'expired');
});

test('explicit useful continuation may take a third step, but always stops at three',async()=>{
 let index=0;const topics=['雨声适合配什么样的故事？','安静角落里可以摆哪些书？','怎样留下一份阅读清单？'];
 const f=setup(async()=>JSON.stringify({useful:true,kind:'question',topic:topics[index++],sourceIds:['a'],continue:true,nextPurpose:'new-angle'}));
 f.worker.note(key,'下雨了');f.advance(120000);assert.equal((await f.worker.tick()).steps,3);assert.equal(f.calls,3);
 assert.equal(f.worker.snapshot(key).events.find(e=>e.status==='ready').stopReason,'step-limit');
 const stop=setup(async()=>JSON.stringify({useful:true,kind:'question',topic:'听着雨声读书怎么样？',sourceIds:['a'],continue:true,nextPurpose:'none'}));
 stop.worker.note(key,'下雨了');stop.advance(120000);assert.equal((await stop.worker.tick()).steps,1);
});
