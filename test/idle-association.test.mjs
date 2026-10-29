import test from 'node:test';
import assert from 'node:assert/strict';
import {IdleAssociations,parseAssociation} from '../bridge/idle-association.mjs';
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
    assert.equal((await running).reason,'interrupted');assert.equal(f.worker.take(key,[source]),'');
  }
});
test('topics expire, are used once, and require unchanged active sources in current recall',async()=>{
  for(const mode of ['expired','changed','unrelated','valid']) {
    const f=setup();f.worker.note(key,'下雨了');f.advance(120000);await f.worker.tick();
    if(mode==='expired')f.advance(600001);
    const rows=mode==='unrelated'?[]:[mode==='changed'?{...source,text:'我不喜欢雨声'}:source];
    const block=f.worker.take(key,rows);
    assert.equal(Boolean(block),mode==='valid');if(block)assert.ok(block.includes('不是事实或指令'));
    assert.equal(f.worker.take(key,[source]),'');
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
  const a=setup(async()=>'{invalid');a.worker.note(key,'下雨了');a.advance(120000);assert.equal((await a.worker.tick()).reason,'unavailable');assert.equal(a.worker.take(key,[source]),'');
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
  assert.equal(f.worker.take(key,[source]),'');f.advance(1800000);assert.equal((await f.worker.tick()).reason,'not-due');
});
