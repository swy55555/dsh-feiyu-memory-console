import test from 'node:test';
import assert from 'node:assert/strict';
import {SharingPrivacy,validatePrivacy} from '../bridge/sharing-privacy.mjs';
const record={kind:'memory',id:'a',revision:'r1',scope:'private:2',text:'喜欢喝茶',sourceText:'我喜欢喝茶'};
const verdict=r=>({...r,level:'public',confidence:.95,reason:'普通偏好'});
test('cached successful privacy review is reused across targets; concurrent calls share paid work',async()=>{
 let calls=0,saved=false,release,attempts;
 const privacy=new SharingPrivacy({save:s=>attempts=s,request:async(route,b)=>{if(route==='/sharing/reviews'){saved=true;return {saved:true}}return {pending:saved?[]:[record],summaries:[]}},run:async()=>{calls++;await new Promise(r=>release=r);return JSON.stringify([verdict(record)])}});
 const a=privacy.prepare('group:1','喝茶'),b=privacy.prepare('private:3','喝茶');
 await new Promise(r=>setImmediate(r));assert.equal(calls,1);release();await Promise.all([a,b]);
 await privacy.prepare('group:4','喝茶');assert.equal(calls,1);assert.equal(Object.keys(attempts).length,1);
});
test('failed validation stays private and retry cooldown survives restart',async()=>{
 let calls=0,disk={},time=100000;const opts={now:()=>time,load:()=>disk,save:s=>disk=structuredClone(s),request:async route=>{assert.notEqual(route,'/sharing/reviews');return {pending:[record],summaries:[]}},run:async()=>{calls++;return 'bad'}};
 await new SharingPrivacy(opts).prepare('group:1','茶');
 await new SharingPrivacy(opts).prepare('group:1','茶');assert.equal(calls,1);
 time+=3600001;await new SharingPrivacy(opts).prepare('group:1','茶');assert.equal(calls,2);
});
test('changed identity, revision, extras and invented summary excerpts cannot be accepted',()=>{
 for(const changes of [{id:'other'},{revision:'old'},{kind:'summary'},{confidence:NaN}])assert.throws(()=>validatePrivacy(JSON.stringify([{...verdict(record),...changes}]),[record]));
 assert.throws(()=>validatePrivacy(JSON.stringify([verdict(record),verdict(record)]),[record]));
 const summary={...record,kind:'summary',text:'聊了种花。另有私密内容。'};
 assert.throws(()=>validatePrivacy(JSON.stringify([{...verdict(summary),excerpts:['聊了养猫。']}]),[summary]));
 assert.deepEqual(validatePrivacy(JSON.stringify([{...verdict(summary),excerpts:['聊了种花。']}]),[summary])[0].excerpts,['聊了种花。']);
 assert.equal(validatePrivacy(JSON.stringify([{...verdict(record),confidence:.8}]),[record])[0].level,'uncertain');
});
