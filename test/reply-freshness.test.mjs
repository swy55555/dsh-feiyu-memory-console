import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {privateReplyGuard} from '../bridge/reply-freshness.mjs'
const key='private:1'
test('unseen additions stop only same-chat private replies, without marking messages read',()=>{
 let s={lastUnreadSeq:3},seen=3
 const make=(k=key,actor=true)=>privateReplyGuard({key:k,sameActor:actor,state:()=>s,readThrough:()=>seen})
 const guard=make();guard();s.lastUnreadSeq=4;assert.throws(guard,e=>e.code==='NEW_PRIVATE_INPUT');assert.equal(seen,3)
 seen=4;assert.throws(guard);make()()
 const unread=make();s={lastUnreadSeq:4};assert.throws(unread)
 seen=2;assert.throws(make());make('group:1')();make(key,false)()
})
test('actual burst queue stops remaining bubbles, reports sent count, and accepts a fresh followup',async()=>{
 const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8')
 const a=source.indexOf('  function sendMessagesV2('),b=source.indexOf('  // 审计范围',a)
 let s={lastUnreadSeq:1},seen=1;const delivered=[]
 const sandbox={sendChain:Promise.resolve(),captureSendGuard:()=>()=>{},onebotSend:async(kind,id,msg)=>{delivered.push(msg);if(msg==='first')s.lastUnreadSeq++},noteMemeUse:()=>{},log:()=>{},sleep:async()=>{}}
 const send=vm.runInNewContext('('+source.slice(a,b).trim()+')',sandbox)
 const guard=()=>privateReplyGuard({key,sameActor:true,state:()=>s,readThrough:()=>seen})
 await assert.rejects(send(key,['first','stale-second','stale-third'],[1,1],null,null,guard()),e=>e.code==='NEW_PRIVATE_INPUT'&&e.sent.length===1)
 assert.deepEqual(delivered,['first']);seen=s.lastUnreadSeq
 await send(key,['updated-reply'],[],null,null,guard());assert.deepEqual(delivered,['first','updated-reply'])
 // All three QQ text send routes must provide the scoped guard.
 assert.equal((source.match(/await sendMessagesV2\([^\n]*capturePrivateReplyGuard/g)||[]).length,3)
})
