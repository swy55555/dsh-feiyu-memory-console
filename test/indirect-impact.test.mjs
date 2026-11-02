import assert from 'node:assert/strict'
import {indirectImpact} from '../lib/indirect-impact.js'
const source={scope:'private:1',version:'a'.repeat(64)},memoryVersion='b'.repeat(64)
const parents=[{kind:'memory',id:'m',memoryVersion}]
const provenance={version:1,scope:source.scope,memoryVersion,sourceVersion:source.version}
const node={id:'idea:1',topic:'雨天读什么？',sources:[{id:'m',provenance}],impression:{text:'也许可以聊聊雨声',feeling:'curiosity'}}
const event={key:source.scope,status:'ready',ideaId:'idea',at:1,dependencies:{version:1,nodes:[node]}}
const audit={version:1,events:[event]},copy=structuredClone(audit)
const run=a=>indirectImpact(source,parents,a)
const r=run(audit);assert.equal(r.items.length,2);assert.equal(r.items[0].reference,'historical');assert.equal(r.items[0].via[0].parentState,'same-version');assert.equal(r.items[1].via[1].kind,'bridge:association');assert.deepEqual(audit,copy)
assert.equal(indirectImpact(source,[{...parents[0],memoryVersion:'c'.repeat(64)}],audit).items[0].via[0].parentState,'changed-version')
assert.equal(indirectImpact(source,[],audit).items[0].via[0].parentState,'not-present')
assert.equal(run({version:1,events:[{...event,key:'group:2'}]}).items.length,0)
for(const change of [{scope:'private:2'},{sourceVersion:'d'.repeat(64)},{memoryVersion:'invalid'}]){
 const a=structuredClone(audit);Object.assign(a.events[0].dependencies.nodes[0].sources[0].provenance,change);assert.equal(run(a).items.length,0)
}
const legacy={version:1,events:[{key:source.scope,status:'ready',ideaId:'old',at:1,sources:[{id:'m'}],topics:['不应凭空确定这一句有影响']}]}
assert.equal(run(legacy).items[0].reference,'unavailable');assert.ok(!run(legacy).items[0].text.includes('不应凭空'))
const noVersion=structuredClone(audit);noVersion.events[0].dependencies.nodes[0].sources[0].provenance=null;assert.equal(run(noVersion).items[0].reference,'unavailable')
assert.equal(run(null).coverage,'unavailable')
assert.equal(run({version:1,events:[event,event]}).coverage,'unavailable')
console.log('PASS indirect paths: scoped versions, historical parents, legacy uncertainty, corruption, no fabricated edges')
