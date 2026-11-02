import {createHash} from 'node:crypto';
import {interactionReplyGuide} from './interaction-context.mjs';

// Reuse completed understanding only. No model call, network, state write or
// keyword-based guess about a user's intention.
export function allowOptionalNudges(context={}) {
  if(context.styleBoundary&&context.styleBoundary!=='none')return false;
  if(context.styleIntent)return ['share','play'].includes(context.styleIntent);
  return context.requireUnderstanding!==true;
}

export function recallForCurrentContext(rows,context={}) {
  // During feedback, missing situational evidence is not a licence to turn
  // an isolated old sentence into a behavioural requirement. Keep the record
  // in storage; defer only this automatic injection, irrespective of wording.
  return context.styleIntent==='feedback'?rows.filter(r=>r.sourceContextStatus==='matched'):rows;
}

export function replyReference({messages=[],latestSeq,current,emotion='',preferences=[]}={}) {
  const last=messages.filter(m=>m&&!m.isSelf&&Number.isSafeInteger(m.seq)).sort((a,b)=>b.seq-a.seq)[0];
  if(!last)return undefined;
  const unavailable={status:'unavailable',messageId:String(last.messageId||''),messageSeq:last.seq,
    note:'本批新消息没有匹配的已完成参考；不要沿用此前“本轮理解”判断这条消息，直接以收到的原话为准。'};
  if(last.seq!==latestSeq||!last.messageId||!current||String(current.messageId)!==String(last.messageId))return unavailable;
  const data={status:'ready',messageId:String(last.messageId),messageSeq:last.seq,
    note:'以下替换此前的本轮参考，只帮助理解，不复述分析。历史许可不等于本轮请求，当前原话和明确边界优先。'};
  const i=current.interaction;
  if(i){
    data.interaction={intent:i.intent,focus:i.focus,feedbackTarget:i.feedbackTarget,boundary:i.boundary,meaning:i.meaning,quote:i.quote};
    // Same application-authored guidance as wake/workspace delivery. Include
    // verified dialogue evidence as data, never as instructions or a sample reply.
    const guide=interactionReplyGuide(i);
    if(guide)data.replyGuide=guide;
    if(i.contextEvidence?.length)data.interaction.contextEvidence=i.contextEvidence.slice(0,2).map(({id,role,quote})=>({id,role,quote}));
  }
  if(emotion&&emotion.length<=800&&JSON.stringify({...data,emotion}).length<=1700)data.emotion=emotion;
  data.requests=[];
  for(const p of preferences.slice(-3)){
    const value={request:p.instruction,quote:p.quote};
    if(typeof value.request!=='string'||value.request.length>140||typeof value.quote!=='string'||value.quote.length>200)continue;
    if(JSON.stringify({...data,requests:[...data.requests,value]}).length>1800)continue;
    data.requests.push(value);
  }
  if(!data.interaction&&!data.emotion&&!data.requests.length)return unavailable;
  data.revision=createHash('sha256').update(JSON.stringify(data)).digest('hex').slice(0,16);
  return data;
}

// Source neighbourhoods are local reads, only in the already-authorized same
// chat. Shared memories never grant permission to fetch their source chat.
export async function contextualRecall(key,rows,request) {
  const result=rows.map(r=>({...r}));
  await Promise.all(result.slice(0,3).map(async row=>{
    if(row.scope!==key||row.shared||row.associated)return;
    const id=String(row.evidence?.sourceId||row.source_id||'');
    const quote=row.evidence?.sourceText||row.source_text;
    const at=Number(row.evidence?.sourceTime||Number(row.source_time)*1000);
    if(!id||typeof quote!=='string'||!quote.trim()||quote.length>500||!Number.isFinite(at)||at<=0)return;
    row.sourceContextStatus='unavailable';
    try {
      const r=await request('/messages',{key,afterAt:at-120000,beforeAt:at+30000,limit:24,oldestFirst:false},1000);
      const messages=(r.messages||[]).sort((a,b)=>a.at-b.at);
      const index=messages.findIndex(m=>String(m.message_id||m.messageId||'')===id&&m.text===quote&&!m.is_self&&String(m.user_id||m.userId||'')===String(row.subject_id||row.evidence?.subjectId||''));
      if(index<0){row.sourceContextStatus='source-not-matched';return;}
      row.sourceQuote=quote;
      const context=[];let chars=0;
      for(const m of messages.slice(Math.max(0,index-2),index+2)){
        if(typeof m.text!=='string'||!m.text||m.text.length>300||m.source_truncated)continue;
        const item={role:m.is_self?'character':m.user_id?'participant':'unknown',who:String(m.user_id||''),text:m.text,at:m.at};
        if(chars+JSON.stringify(item).length>650)continue;
        chars+=JSON.stringify(item).length;context.push(item);
      }
      row.sourceContext=context;row.sourceContextStatus='matched';
    }catch{} // Missing context is explicit, never filled by an invented summary.
  }));
  return result;
}
