import assert from 'node:assert/strict'
import {enrichSourceImpact} from '../lib/source-impact.js'
const scope='private:1',quote='只在周末喝咖啡',ref={id:'event1',quote}
const base={readOnly:true,modelCalls:0,status:'matched',source:{scope,subject:'1',eventId:'event1',version:'a'.repeat(64),text:quote},items:[]}
const state={owner:'1',continuity:{version:1,chats:[[scope,{concerns:[],beliefs:[{id:'b',text:'旧认识',evidence:[],revisions:[{evidence:[ref]}]}]}]]},patterns:{version:1,chats:[[scope,{evidence:[],adjustments:[{id:'a',sourceId:'event1',quote}]}]]},self:{version:1,claims:[{id:'s',text:'自我参考',evidence:[ref]}],history:[]}}
const copy=structuredClone(state),r=enrichSourceImpact(base,state)
assert.equal(r.total,3);assert.equal(r.counts.current,2);assert.equal(r.counts.historical,1);assert.equal(r.bridgeCoverage,'checked')
assert.deepEqual(state,copy);assert.equal(r.source.text,undefined);assert.equal(r.source.subject,undefined)
assert.equal(r.snapshot,enrichSourceImpact(base,state).snapshot)
const group=enrichSourceImpact({...base,source:{...base.source,scope:'group:2'}},state)
assert.equal(group.total,0);assert.equal(group.bridgeCoverage,'not-applicable')
assert.equal(enrichSourceImpact(base,{...state,owner:'2'}).total,0)
const stored={...base,items:[{kind:'bridge:self-reference',id:'s',text:'',reference:'registered'}]}
const missing=enrichSourceImpact(stored,{owner:'1'})
assert.equal(missing.counts.unavailable,1);assert.equal(missing.bridgeCoverage,'partial')
assert.notEqual(missing.snapshot,r.snapshot)
const broken=structuredClone(state);broken.self.claims.push({id:'bad',evidence:'broken'})
assert.equal(enrichSourceImpact(stored,broken).items.find(x=>x.id==='s').reference,'unavailable')
const wrongQuote=structuredClone(state);wrongQuote.self.claims[0].evidence[0].quote='每天都喝'
assert.equal(enrichSourceImpact(stored,wrongQuote).items.find(x=>x.id==='s').reference,'unavailable')
const history=structuredClone(state);history.self.history=[{claims:history.self.claims}];history.self.claims=[]
assert.equal(enrichSourceImpact(stored,history).items.find(x=>x.id==='s').reference,'historical')
const many={...base,items:Array.from({length:110},(_,i)=>({kind:'memory',id:String(i),reference:'current'}))}
const limited=enrichSourceImpact(many,{owner:'2'});assert.equal(limited.total,110);assert.equal(limited.items.length,100);assert.equal(limited.counts.current,110);assert.equal(limited.truncated,true)
console.log('PASS source impact: scoped snapshots, history, missing and corrupt states, quote matching, bounded display, no mutation')
