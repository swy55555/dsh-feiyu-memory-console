// SQLite commits before events are visible. Each subscriber persists its state
// and cursor together; acknowledgement is last and can safely be replayed.
export function applySourceChange(state,event,{invalid=false,module=''}={}){
  if(!Number.isSafeInteger(event?.sequence)||event.sequence<1)throw Error('invalid evidence event');
  if((state?._evidenceCursor||0)>=event.sequence)return state;
  const next=structuredClone(state||{});
  const aliases=[event.eventId,event.sourceVersion,...(event.aliasIds||[]),...(event.messageId&&event.speaker?[`${event.scope}/${event.speaker}/${event.messageId}`]:[])].filter(Boolean);
  const matches=ref=>typeof ref==='string'?aliases.includes(ref):ref&&[ref.id,ref.sourceId,ref.eventId,ref.sourceVersion,ref.episodeId].some(x=>x&&aliases.includes(x));
  function visit(value,parent=''){
    if(!value||typeof value!=='object')return;
    if(Array.isArray(value)){value.forEach(v=>visit(v,parent));return;}
    const related=[...(Array.isArray(value.evidence)?value.evidence:[]),...(Array.isArray(value.evidenceIds)?value.evidenceIds:[]),...(Array.isArray(value.sourceIds)?value.sourceIds:[]),...(Array.isArray(value.sourceEpisodeIds)?value.sourceEpisodeIds:[]),...(value.contract?.rootIds||[]),value.sourceId,value.eventId,value.emotionEventId,value.sourceVersion].some(matches);
    if(related){
      value.sourceState=invalid?'invalid':'recheck';value.sourceChange=event.sequence;
      if(invalid&&parent==='concerns'&&['open','paused'].includes(value.status)){value.status='closed';value.closedReason='source-invalid';}
      if(invalid&&parent==='beliefs'){value.status='retracted';value.invalidatedAt=event.at*1000;}
      if(invalid&&parent==='claims')value.sourcePaused=true;
      // Keep the historical emotion/decision. Exclude it as present evidence,
      // never pretend an already-experienced mood did not occur.
      if(invalid&&['pending','proposed','queued','generating'].includes(value.status))value.status='cancelled';
    }
    for(const [key,child] of Object.entries(value))if(!key.startsWith('_'))visit(child,key);
  }
  visit(next);next._evidenceCursor=event.sequence;next._evidenceModule=module;return next;
}

export class EvidenceConsumer {
  constructor({request,load=()=>null,save,subscribers=[],invalidate=()=>{}}){
    Object.assign(this,{request,save,subscribers,invalidate});this.state=load()||{cursor:0};this.busy=false;
  }
  async tick(){
    if(this.busy)return {status:'busy'};this.busy=true;let applied=0;
    try{
      const data=await this.request('/evidence/changes',{after:this.state.cursor,limit:100},2000);
      if(!Array.isArray(data.events))throw Error('invalid change feed');
      for(const event of data.events){
        if(!Number.isSafeInteger(event.sequence)||event.sequence<=this.state.cursor)throw Error('unordered change feed');
        // Always invalidate ephemeral work, including on replay after a crash.
        this.invalidate(event);
        for(const subscriber of this.subscribers)await subscriber(event);
        const next={cursor:event.sequence};this.save(next);this.state=next;applied++;
      }
      return {status:'ready',applied,cursor:this.state.cursor,remainingRevision:data.revision};
    }finally{this.busy=false;}
  }
}
