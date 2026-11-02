import {buildHumanContext,shouldRecallMemory} from './human-context.mjs';
import {contextualRecall} from './reply-context.mjs';
import {renderEvidence} from './retrieval-session.mjs';

export const MEMORY_LOOKUP_GUIDE='长期记忆仅按当前查询检索有限候选，不是全库穷尽检查。无匹配不证明从未记录或已经丢失；工具失败、关闭、超时和未查询必须区分。qq_memory_query 只读轻量话题/印象，近期聊天也不是长期库；需要主动查长期记忆时使用 qq_vmem_search。不要把检索状态解释成用户在故意刁难你。';

// Local, read-only retrieval for messages delivered inside an ongoing model turn.
// A bounded cache coalesces wait/unread/recent reads of the same current message.
export class FollowupMemory {
  constructor({request,retrieval=null,revision=()=>null,now=Date.now,maxChats=128,timeoutMs=2000}={}){
    Object.assign(this,{request,retrieval,revision,now,maxChats,timeoutMs});this.entries=new Map();this.busy=0;
  }
  async get({key,messages=[],latestSeq,enabled=true,current=()=>true,options={},trace=()=>{}}={}){
    const last=messages.filter(m=>m&&!m.isSelf&&Number.isSafeInteger(m.seq)).sort((a,b)=>b.seq-a.seq)[0];
    if(!/^(private|group):\d+$/.test(key)||!last)return undefined;
    const query=String(last.plain||last.text||last.tail||'').trim();
    const base={messageId:String(last.messageId||''),messageSeq:last.seq,scope:key,note:MEMORY_LOOKUP_GUIDE};
    const result=status=>({...base,status});
    if(!enabled)return result('disabled');
    if(last.seq!==latestSeq||!base.messageId||!current())return result('stale');
    if(!query||query.length>2000||!shouldRecallMemory(query))return result('not-queried');
    const revision=this.revision();
    if(revision==='unavailable')return result('unavailable');
    const valid=()=>current()&&this.revision()===revision;
    const fingerprint=JSON.stringify([last.seq,base.messageId,query,revision,options]);
    const prior=this.entries.get(key);
    if(prior?.fingerprint===fingerprint&&this.now()-prior.at<30000){
      const cached=await prior.promise;
      return valid()?structuredClone(cached):result('stale');
    }
    if(this.busy>=2)return result('busy');
    this.busy++;
    const entry={fingerprint,at:this.now()};
    const work=(async()=>{
      if(this.retrieval){
        const found=await this.retrieval.search({key,turn:last.seq,query,current:valid,maxChars:6000,maxItems:8});
        return {...base,...found,records:undefined,ids:(found.records||[]).map(r=>r.id),context:renderEvidence(found)};
      }
      const response=await this.request('/search',{query,scope:key,k:5,min_score:.4},Math.min(this.timeoutMs,1500));
      if(!Array.isArray(response?.results))throw Error('invalid-search-response');
      // Never accept another chat's source, even if the service labels it shared.
      const rows=response.results.filter(r=>r?.scope===key).slice(0,5);
      const contextual=await contextualRecall(key,rows,(route,body)=>this.request(route,body,500));
      const selected=[];
      const context=buildHumanContext({key,currentMessage:query,searchRows:contextual,
        options:{...options,maxChars:Math.min(2400,Number(options.maxChars)||2000),maxItems:3,onSelect:r=>selected.push(r)}});
      if(!valid())return result('stale');
      return {...base,status:selected.length?'matched':rows.length?'filtered':'empty',ids:selected.map(r=>r.id),context:selected.length?context:''};
    })();
    work.then(()=>{this.busy--;},()=>{this.busy--;});
    let timer;
    entry.promise=Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>resolve(result('unavailable')),this.timeoutMs);})])
      .catch(()=>result('unavailable')).then(value=>{
        const safe=valid()?value:result('stale');
        trace({key,query,messageId:base.messageId,messageSeq:last.seq,status:safe.status,ids:safe.ids||[]});
        return safe;
      }).finally(()=>{clearTimeout(timer);if(this.entries.get(key)===entry&&this.now()-entry.at>=30000)this.entries.delete(key);});
    this.entries.set(key,entry);
    while(this.entries.size>this.maxChats)this.entries.delete(this.entries.keys().next().value);
    return structuredClone(await entry.promise);
  }
}
