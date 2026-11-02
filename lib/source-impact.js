// Local, read-only interpretation of explicit source links. No semantic matching.
import {createHash} from 'node:crypto'
import {indirectImpact} from './indirect-impact.js'
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex')
const key=x=>JSON.stringify([x.kind,x.id])
export function enrichSourceImpact(preview,{owner,continuity,patterns,self,idle}={}) {
  if(!preview.source)return {...preview,total:0,shown:0,truncated:false,bridgeCoverage:'unavailable'}
  const source=preview.source,found=new Map(),checked=new Set()
  const sameOwner=String(owner||'')===source.subject&&source.scope===`private:${owner}`
  function add(kind,item,refs,historical=false){
    if(!item||typeof item.id!=='string'||!Array.isArray(refs))throw Error('invalid evidence owner')
    if(!refs.some(e=>e?.id===source.eventId&&typeof e.quote==='string'&&e.quote.length>0&&source.text.includes(e.quote)))return
    const row={kind:'bridge:'+kind,id:item.id,text:String(item.text||item.label||item.quote||'').slice(0,240),status:String(item.status||'recorded'),reference:historical?'historical':'current'}
    const k=key(row);if(!found.has(k)||!historical)found.set(k,row)
  }
  function chat(file){
    if(file?.version!==1||!Array.isArray(file.chats))throw Error('state unavailable')
    const matches=file.chats.filter(x=>Array.isArray(x)&&x[0]===source.scope)
    if(matches.length>1)throw Error('ambiguous chat')
    return matches[0]?.[1]
  }
  function inspect(kinds,fn){
    // A malformed file cannot partially masquerade as a valid current snapshot.
    const prior=new Map(found)
    try{fn();for(const k of kinds)checked.add('bridge:'+k)}catch{found.clear();for(const [k,v]of prior)found.set(k,v)}
  }
  if(sameOwner){
    inspect(['concern','belief'],()=>{
      const s=chat(continuity)
      for(const [list,kind]of [['concerns','concern'],['beliefs','belief']]){
        if(s&&!Array.isArray(s[list]))throw Error('invalid continuity')
        for(const x of s?.[list]||[]){add(kind,x,x.evidence||[]);for(const r of x.revisions||[])add(kind,{...x,...r,id:x.id},r.evidence||[],true)}
      }
    })
    inspect(['response-evidence','response-adjustment'],()=>{
      const s=chat(patterns)
      for(const [list,kind]of [['evidence','response-evidence'],['adjustments','response-adjustment']]){
        if(s&&s[list]!==undefined&&!Array.isArray(s[list]))throw Error('invalid response state')
        for(const x of s?.[list]||[])add(kind,x,[{id:x.sourceId,quote:x.quote}])
      }
    })
    inspect(['self-reference'],()=>{
      if(self?.version!==1||!Array.isArray(self.claims))throw Error('invalid self reference')
      for(const x of self.claims)add('self-reference',x,x.evidence||[])
      for(const h of self.history||[])for(const x of h.claims||[])add('self-reference',x,x.evidence||[],true)
    })
  }
  const rows=new Map((preview.items||[]).map(x=>[key(x),x.kind.startsWith('bridge:')?{...x,reference:'unavailable',status:checked.has(x.kind)?'not-in-current-snapshot':'state-unavailable'}:x]))
  for(const [k,v]of found)rows.set(k,v)
  const indirect=sameOwner?indirectImpact(source,preview.items||[],idle):{items:[],coverage:'not-applicable'}
  for(const x of indirect.items)rows.set(key(x),x)
  const all=[...rows.values()].sort((a,b)=>key(a).localeCompare(key(b)))
  const counts={current:0,historical:0,unavailable:0};for(const x of all)counts[x.reference]++
  const snapshot=digest({source:source.version,items:all,checked:[...checked].sort(),indirectCoverage:indirect.coverage})
  // Do not return private source text or unselected bridge state to the browser.
  return {...preview,source:{version:source.version},items:all.slice(0,100),total:all.length,shown:Math.min(100,all.length),truncated:all.length>100,
    counts,snapshot,indirectCoverage:indirect.coverage,indirectCount:all.filter(x=>x.indirect).length,bridgeCoverage:sameOwner?(checked.size===5?'checked':'partial'):'not-applicable',checkedAt:Date.now()}
}
