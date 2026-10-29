import {validEvidenceVerdict} from '../bridge/confirmation-review.mjs'
import {createHash} from 'node:crypto'
export const candidateFingerprint=row=>reviewSetFingerprint([row])
const sourceFingerprint=row=>{const {review_context_version,...source}=row;return reviewSetFingerprint([source])}
// One candidate/page per tick, no repeated paid review of unchanged ambiguous facts.
export class CandidateAuto {
  constructor({load,save,list,step,now=Date.now}) {
    Object.assign(this,{save,list,step,now});this.busy=false;this.epoch=0
    const old=load()||{};this.state={enabled:old.enabled===true,records:Array.isArray(old.records)?old.records:[],error:''}
  }
  snapshot(){return {...this.state,running:this.busy,records:this.state.records.slice(-30).reverse()}}
  setEnabled(value){this.save({...this.state,enabled:value===true});this.state.enabled=value===true;this.epoch++;return this.snapshot()}
  dispose(){this.epoch++}
  async tick(){
    if(!this.state.enabled||this.busy)return this.snapshot()
    this.busy=true;const epoch=this.epoch,valid=()=>this.state.enabled&&epoch===this.epoch
    try{
      const rows=await this.list();if(!valid())return this.snapshot()
      const ids=new Set(rows.map(r=>r.id)), recent=new Set(this.state.records.slice(-30).map(r=>r.id));
      this.state.records=this.state.records.filter(x=>ids.has(x.id)||recent.has(x.id));
      const row=rows.find(r=>{const old=this.state.records.find(x=>x.id===r.id&&(x.dependency==='source'?x.sourceFingerprint===sourceFingerprint(r):x.fingerprint===candidateFingerprint(r)));return !old||(['pending','error'].includes(old.status)&&old.nextAt<=this.now())})
      if(!row)return this.snapshot()
      // Fail before calling a model if persistent state cannot be written.
      this.save(this.state)
      const fingerprint=candidateFingerprint(row);let result
      try{result=await this.step(row,valid)}catch{result={status:'error',reason:'服务暂不可用或数据已更新，稍后重试'}}
      if(!valid())return this.snapshot()
      const record={id:row.id,text:row.text,scope:row.scope,fingerprint,sourceFingerprint:sourceFingerprint(row),at:this.now(),...result,nextAt:this.now()+(result.status==='error'?600000:60000)}
      this.state.records=[...this.state.records.filter(x=>x.id!==row.id),record];this.state.error='';this.save(this.state)
    }catch{this.state.error='自动核对暂不可用，请检查服务与状态保存权限'}
    finally{this.busy=false}
    return this.snapshot()
  }
}

export function validateCandidateVerdict(value,context){
  return validEvidenceVerdict(value,context) && value.supported && value.speakerMatches && value.literal && value.current && value.confidence>=.95
}

export function candidateEvidenceContext(prepared){
  const c=prepared?.evidence, context=prepared?.context;
  if(!c?.sourceId||!c.subjectId||typeof c.quote!=='string'||!c.quote.trim()||c.quote.length>500||c.id!==context?.candidate?.id)throw Error('缺少完整原话，不可使用提取摘要替代');
  return {scope:context.scope,revision:context.revision,candidate:c};
}

export function reviewSetFingerprint(rows) {
  const ignored=new Set(['last_access','access_count','last_reinforced','strength_days','importance']);
  const normalized=rows.map(row=>Object.fromEntries(Object.keys(row).sort().filter(k=>!ignored.has(k)).map(k=>[k,ArrayBuffer.isView(row[k])?Buffer.from(row[k]).toString('base64'):row[k]]))).sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}
