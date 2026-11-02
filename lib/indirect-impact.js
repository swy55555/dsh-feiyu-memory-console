// Only recorded, versioned derivation paths. No inference by text similarity.
const hash64=x=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x)
export function indirectImpact(source,parents,audit) {
  const missing={items:[],coverage:'unavailable'}
  if(audit?.version!==1||!Array.isArray(audit.events)||audit.events.length>40)return missing
  const memories=new Map(parents.filter(x=>x.kind==='memory').map(x=>[x.id,x]))
  const rows=[],seen=new Set()
  try{
    for(const e of audit.events){
      if(e?.key!==source.scope||e.status!=='ready')continue
      if(typeof e.ideaId!=='string'||!e.ideaId||!Number.isFinite(e.at))throw Error('invalid event')
      if(!e.dependencies){
        const refs=(Array.isArray(e.sources)?e.sources:[]).filter(x=>memories.has(x?.id))
        if(refs.length)rows.push({kind:'bridge:association',id:e.ideaId+':legacy',reference:'unavailable',status:'legacy-unversioned',indirect:true,
          text:'这次旧联想未记录逐节点的来源版本，无法确认具体影响。',via:refs.map(x=>({kind:'memory',id:x.id})),at:e.at})
        continue
      }
      if(e.dependencies.version!==1||!Array.isArray(e.dependencies.nodes)||e.dependencies.nodes.length>3)throw Error('invalid derivation')
      for(const n of e.dependencies.nodes){
        if(typeof n.id!=='string'||!n.id.startsWith(e.ideaId+':')||seen.has(n.id)||typeof n.topic!=='string'||n.topic.length>120||!Array.isArray(n.sources)||!n.sources.length||n.sources.length>3)throw Error('invalid node')
        seen.add(n.id)
        const via=[],uncertain=[]
        for(const r of n.sources){
          if(typeof r?.id!=='string')throw Error('invalid parent')
          const p=r.provenance
          if(!p){if(memories.has(r.id))uncertain.push({kind:'memory',id:r.id});continue}
          if(p.version!==1||p.scope!==source.scope||!hash64(p.memoryVersion))continue
          if(!p.sourceVersion){if(memories.has(r.id))uncertain.push({kind:'memory',id:r.id,version:p.memoryVersion});continue}
          if(p.sourceVersion!==source.version||!hash64(p.sourceVersion))continue
          via.push({kind:'memory',id:r.id,version:p.memoryVersion,
            parentState:memories.get(r.id)?.memoryVersion===p.memoryVersion?'same-version':memories.has(r.id)?'changed-version':'not-present'})
        }
        if(!via.length&&!uncertain.length)continue
        const reference=via.length?'historical':'unavailable',path=via.length?via:uncertain
        rows.push({kind:'bridge:association',id:n.id,text:n.topic,status:'past-generated',reference,indirect:true,via:path,at:e.at})
        const i=n.impression
        if(i&&typeof i.text==='string'&&i.text.length<=80&&['warmth','curiosity','concern'].includes(i.feeling)){
          rows.push({kind:'bridge:association-feeling',id:n.id+':feeling',text:i.text,status:'past-impression',reference,indirect:true,
            via:[...path,{kind:'bridge:association',id:n.id}],at:e.at})
        }
      }
    }
  }catch{return missing}
  return {items:rows,coverage:'checked'}
}
