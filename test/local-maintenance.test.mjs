import test from 'node:test'
import assert from 'node:assert/strict'
import {LocalMemoryMaintenance} from '../lib/local-memory-maintenance.js'
import {memoryCandidates,recallBlock} from '../bridge/daily-memory.js'
import {buildHumanContext} from '../bridge/human-context.mjs'

test('bounded local worker rotates chats, resumes pages after restart, applies only eligible records',async()=>{
  let saved,round=0;const calls=[]
  const options={load:()=>saved,save:v=>{saved=structuredClone(v)},scopes:async()=>['global','private:2','group:1'],
    preview:async(scope,after)=>{calls.push([scope,after]);return {token:'t',next:'page2',items:[{id:'episode',action:'experience'},{id:'ambiguous',action:'hold'}]}},
    apply:async(scope,token,ids)=>{assert.deepEqual(ids,['episode']);round++;return {changed:1,skipped:[]}}}
  let w=new LocalMemoryMaintenance(options);await w.tick();await w.tick()
  w=new LocalMemoryMaintenance(options);await w.tick()
  assert.deepEqual(calls,[['group:1',''],['private:2',''],['group:1','page2']]);assert.equal(round,3)
  assert.equal(w.snapshot().modelCalls,0)
})

test('disable cancels pending preview and prevents writes; unsupported service and persistence failure do not mutate',async()=>{
  let release,writes=0
  const opts={load:()=>null,save:()=>{},scopes:async()=>['private:1'],preview:()=>new Promise(r=>release=r),apply:async()=>{writes++}}
  const w=new LocalMemoryMaintenance(opts);const run=w.tick()
  while(!release)await new Promise(r=>setTimeout(r,0))
  w.setEnabled(false);release({items:[{id:'1',action:'experience'}]});await run;assert.equal(writes,0)
  const unsupported=new LocalMemoryMaintenance({...opts,ready:async()=>false});await unsupported.tick();assert.equal(writes,0)
  const failed=new LocalMemoryMaintenance({...opts,save:()=>{throw Error('read-only')}});await failed.tick();assert.match(failed.snapshot().error,/read-only/)
})

test('episode proposal remains sourced text and carries an explicit non-fact boundary in both recall modes',()=>{
  const msg={id:'m',userId:'1',sender:'用户',time:Date.now(),text:'我今天去看了电影'}
  const [row]=memoryCandidates(JSON.stringify([{source_id:'m',quote:msg.text,kind:'episode',confidence:.7,
    assessment:{subject:'self',mode:'asserted',sensitive:false},relation:'uncertain',relation_confidence:.5}]),[msg],Date.now(),[])
  assert.equal(row.memory_kind,'experience');assert.equal(row.confirmed,false);assert.equal(row.expires_at,0)
  const recalled={...row,id:'e',scope:'private:1',status:'active',score:.9}
  assert.match(recallBlock([recalled]),/experience.*只证明/s)
  assert.match(buildHumanContext({key:'private:1',searchRows:[recalled]}),/experience-not-fact/)
})
