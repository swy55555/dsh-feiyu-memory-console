// Reuses event understanding; no generator or autonomous retry loop.
export function clarificationInstruction(context){
  if(!context?.candidates?.length)return '';
  return '\n可选 clarification：无明确澄清用 null；否则最多一项 {"kind":"whole_retraction|partial_correction|time_change|uncertain","targetId":"候选的原话ID","oldQuote":"对应旧原话全文","quote":"当前消息全文","speaker":"self","mode":"asserted|quoted|hypothetical|joke|uncertain","coverage":"entire|partial|uncertain","explicit":true,"confidence":0到1}。只判断本人现在明确纠正自己先前说过的话。整句原本就说错、明确整体撤回才用 whole_retraction；一句含多个事实而只改一点必须 partial_correction；以前是真的、后来变了用 time_change；指代含糊、不知道撤回哪句用 uncertain/null。引用、假设、玩笑、别人说的话、对角色表达不满都不能当作原话撤回。整句撤回需高把握，但把握分不代替证据。不生成替代事实，不修改其他消息；已有挂念/认识仍按原规则只用本次证据修正。可选择的旧话均在近期对话中，ID：'+JSON.stringify(context.candidates.map(r=>r.id))+'。';
}
export class ChatClarifications {
  constructor({enabled,candidates,request,lookup=()=>null,receipt=()=>null}){Object.assign(this,{enabled,candidates,request,lookup,receipt});}
  view(result){
    if(result?.status==='unavailable'&&result.currentVersion){
      const stored=this.receipt(result.scope,result.currentVersion);
      if(stored?.status==='applied'&&stored.sourceVersion===result.sourceVersion)result={...result,...stored};
    }
    if(result?.status!=='applied')return result;
    const state=this.lookup(result.scope,result.sourceVersion);
    return {...result,currentState:state?.state||'unavailable',canUndo:state?.state==='revoked'&&state.revision===result.correctionRevision};
  }
  context(key,input,recent){
    if(!this.enabled(key))return null;
    try{return this.candidates(key,input,recent);}catch{return null;}
  }
  async apply(context,proposal,current=()=>true){
    if(!proposal)return {status:'none'};
    if(!context||!this.enabled(context.scope)||!current())return {status:'skipped'};
    const row=context.candidates.find(r=>r.id===proposal.targetId);
    if(!row||!['whole_retraction','partial_correction','time_change','uncertain'].includes(proposal.kind)||proposal.oldQuote!==row.text||proposal.quote!==context.text||!Number.isFinite(proposal.confidence)||proposal.confidence<0||proposal.confidence>1)return {status:'rejected'};
    if(proposal.kind!=='whole_retraction')return {status:'preserved',kind:proposal.kind};
    if(proposal.explicit!==true||proposal.speaker!=='self'||proposal.mode!=='asserted'||proposal.coverage!=='entire'||proposal.confidence<.98)return {status:'rejected'};
    if(!current()||!this.enabled(context.scope))return {status:'skipped'};
    const reference={scope:context.scope,currentVersion:context.version,sourceVersion:row.version};
    try{
      const result=await this.request('/sources/clarification/apply',{scope:context.scope,currentId:context.id,currentVersion:context.version,
        targetId:row.id,targetVersion:row.version,targetRevision:row.revision,proposal},8000);
      if(result?.ok!==true||!['applied','already-processed'].includes(result.status))return {status:'unavailable',...reference};
      return {status:result.status,paused:result.paused||0,...reference,correctionRevision:result.correctionRevision};
    }catch{return {status:'unavailable',...reference};}
  }
}
