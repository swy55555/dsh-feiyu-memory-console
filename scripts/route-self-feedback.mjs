// Apply an explicitly reviewed routing plan; never infer classifications from vocabulary.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import assert from 'node:assert/strict'
const args=process.argv.slice(2),get=k=>args[args.indexOf(k)+1]
assert.ok(args.includes('--state')&&args.includes('--plan'),'Use --state <file> --plan <reviewed plan> [--apply]')
const file=path.resolve(get('--state')),raw=fs.readFileSync(file,'utf8'),state=JSON.parse(raw),plan=JSON.parse(fs.readFileSync(get('--plan'),'utf8'))
assert.equal(state.version,1);assert.ok(Array.isArray(state.claims)&&Array.isArray(plan.items))
const seen=new Set(),next=structuredClone(state),changed=[]
for(const item of plan.items){
 assert.ok(!seen.has(item.id));seen.add(item.id)
 assert.ok(['self','interaction_feedback','user_preference'].includes(item.referenceKind))
 const row=next.claims.find(c=>c.id===item.id);assert.ok(row,'Reference changed; review again')
 assert.equal(crypto.createHash('sha256').update(row.text).digest('hex'),item.textHash,'Reference text changed; review again')
 if(row.referenceKind!==item.referenceKind){row.referenceKind=item.referenceKind;changed.push(item.id)}
}
assert.deepEqual(next.temperament,state.temperament)
assert.deepEqual(next.claims.map(({referenceKind,...r})=>r),state.claims.map(({referenceKind,...r})=>r))
if(!args.includes('--apply')||!changed.length){console.log(JSON.stringify({ready:true,changed:changed.length,applied:false}));process.exit(0)}
const stamp=Date.now(),backup=file+'.before-routing-'+stamp+'.bak';fs.copyFileSync(file,backup)
next.history=[...(next.history||[]),{revision:state.revision,at:stamp,claims:structuredClone(state.claims),temperament:structuredClone(state.temperament??null)}].slice(-20)
next.revision=(state.revision||0)+1
next.audit=[...(next.audit||[]),{at:stamp,action:'reference-routing',changed,revision:next.revision,reason:'已人工核对用途；保留原文与证据，交流反馈不作为人格台词。'}].slice(-80)
assert.equal(fs.readFileSync(file,'utf8'),raw,'State changed; do not overwrite')
fs.writeFileSync(file+'.routing-stage',JSON.stringify(next,null,2));fs.renameSync(file+'.routing-stage',file)
console.log(JSON.stringify({applied:true,changed:changed.length,revision:next.revision,backup}))
