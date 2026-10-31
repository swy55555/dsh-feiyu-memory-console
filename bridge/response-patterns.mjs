// Independently implemented evidence-backed response preferences.
// Design inspiration: 小凌's long-term tendencies; see ACKNOWLEDGEMENTS.md.
import {createHash, randomUUID} from 'node:crypto';
const DAY=86400000;
const fingerprint=s=>createHash('sha256').update(String(s).normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu,'').toLowerCase()).digest('hex');
export const STRATEGIES=Object.freeze({
  comfort_first:{label:'困扰时先倾听',kinds:['user_distress'],hint:'用户明确表达困扰时，先简短承接感受，再问是否需要建议；不要猜测隐藏情绪。'},
  concise_first:{label:'先简短，再按需展开',kinds:['neutral','criticism'],hint:'先给简明回应，再按用户需要展开；不能省略用户明确要求的细节。'},
  ask_before_advice:{label:'建议前先确认需要',kinds:['user_distress'],hint:'用户只是倾诉时先确认是否想听建议；用户已明确提问时直接回答。'},
  share_interest:{label:'接住日常分享的细节',kinds:['neutral','affection'],hint:'用户分享日常时回应一处具体细节，可以轻轻表达兴趣或感受；不要总转成建议、任务清单或连串提问。纯任务仍直接处理。'},
  leave_space:{label:'自然收尾，留一点空间',kinds:['neutral','user_distress'],hint:'允许一句自然回应就结束，不把每句话都接成追问；用户明确求助时仍积极回答。'},
  explain_correction:{label:'纠错时说明改动依据',kinds:['criticism'],hint:'被指出任务错误时先核对，说明修正和依据；不把纠错当成关系攻击。'},
  detailed_when_needed:{label:'按需说明具体细节',kinds:[],hint:'当前明确需要细节时把具体内容说清楚，不为了短句省略答案；当前要求简短时从简。'},
  gentle_expression:{label:'柔和而具体地表达',kinds:[],hint:'在适用情境里语气柔和，具体回应对方；不自动赞同、不虚构感情承诺，也不固定撒娇。'},
  playful_expression:{label:'适合时轻松打趣',kinds:[],hint:'双方当下确在轻松玩笑时可以打趣；认真反馈、求助或明确拒绝时停止调侃，不把嘴硬变成责怪。'},
  direct_expression:{label:'直接说明自己的观点',kinds:[],hint:'表达观点和不同意见时直接说明具体理由；不说教，不为显得自主而拒绝或贬低对方。'},
});
export function learningInstruction(context) {
  if(!context)return '';
  return '\n两个独立可选字段：learning（评价已经发生的回应）与 adjustments（本人当前明确要求的表达方式），没有则各用空数组。策略含义：'+JSON.stringify(Object.fromEntries(Object.entries(STRATEGIES).map(([k,v])=>[k,v.hint])))+'。\n可选 learning 最多1项：{"strategy":"comfort_first|concise_first|ask_before_advice|explain_correction|share_interest|leave_space|detailed_when_needed|gentle_expression|playful_expression|direct_expression","outcome":"helpful|unhelpful","experienceId":"新反馈用空字符串；同一经历重述填已有ID","evidenceKind":"new|repeat|uncertain","quote":"当前消息完整反馈原句，最多200字","confidence":0到1}。没有明确反馈则 learning:[]。只接受用户本人明确评价角色的回应方式是否有帮助，保留否定和适用情境。说自己累、说第三方、引用、假设、玩笑、简单谢谢、角色自己的回复、课程结果都不是反馈证据。不要靠情绪词判断。改写或补充同一反馈仍是repeat；不确定是否新经历用uncertain。只有新的实际反馈才用new；不同日期重述同一件事也不是new。策略只用于改善回应，不能推出用户人格或改变信任。已有反馈用于去重：'+JSON.stringify(context)+'\n可选 adjustments 最多1项：{"kind":"response_style","instruction":"具体表达要求，最多140字","quote":"当前本人要求的逐字原话，最多200字","explicit":true,"confidence":0到1}。仅提取本人明确要求的措辞、长短、语气或交谈节奏；不推测偏好，不改变身份、事实、情感、权限或工具规则。引用、假设、第三方的要求不是本人的要求；“别用这种句式”但上下文无法确定具体所指时返回空数组，不编造句式。新要求用于当下及接下来24小时，后来的要求优先；这是临时遵循，不代表已养成习惯。\n';
}
export class ResponsePatterns {
  constructor({allowed,enabled,load=()=>null,save=()=>{},now=Date.now}) {
    Object.assign(this,{allowed,enabled,save,now});this.chats=new Map();this.storageError=false;
    try {
      const old=load();
      if(old?.version===1&&Array.isArray(old.chats))for(const [key,data] of old.chats){
        if(!allowed(key)||!data||!Array.isArray(data.evidence)||!Array.isArray(data.audit))continue;
        const evidence=data.evidence.filter(e=>e&&typeof e.id==='string'&&Object.hasOwn(STRATEGIES,e.strategy)&&['helpful','unhelpful'].includes(e.outcome)&&typeof e.quote==='string'&&e.quote.length<=200&&Number.isFinite(e.at)&&typeof e.sourceId==='string'&&typeof e.fingerprint==='string').slice(-96);
        this.chats.set(key,{evidence,adjustments:(Array.isArray(data.adjustments)?data.adjustments:[]).filter(x=>x&&typeof x.id==='string'&&typeof x.instruction==='string'&&x.instruction.length<=140&&typeof x.quote==='string'&&x.quote.length<=200&&Number.isFinite(x.expiresAt)).slice(-8),audit:data.audit.slice(-80),disabled:Array.isArray(data.disabled)?data.disabled.filter(k=>Object.hasOwn(STRATEGIES,k)):[]});
      }
    }catch{this.storageError=true;}
  }
  state(key){if(!this.chats.has(key))this.chats.set(key,{evidence:[],adjustments:[],audit:[],disabled:[]});return this.chats.get(key);}
  persist(){try{this.save({version:1,chats:[...this.chats]});this.storageError=false;}catch{this.storageError=true;}}
  log(state,status,extra={}){state.audit=[...state.audit,{id:randomUUID(),at:this.now(),status,...extra}].slice(-80);}
  context(key){
    if(!this.allowed(key)||!this.enabled())return null;
    // Bound the complete evidence set, rather than hiding old evidence from deduplication.
    return this.state(key).evidence.map(({id,strategy,outcome,quote,at})=>({id,strategy,outcome,quote,at}));
  }
  observe(key,operations,{id,at,original,source='user',current=true}={}){
    if(!this.allowed(key)||!this.enabled()||!current||source!=='user'||!id||!Number.isFinite(at))return;
    const s=this.state(key);
    if(!Array.isArray(operations)||operations.length>1){this.log(s,'invalid-feedback',{reason:'反馈必须是最多一项的数组',sourceId:id});this.persist();return;}
    if(!operations.length)this.log(s,'no-feedback',{sourceId:id,reason:'本轮没有明确评价回应方式，不计入长期习惯'});
    for(const op of operations){
      const reason=!op||!Object.hasOwn(STRATEGIES,op.strategy)?'未识别的回应策略':
        !['helpful','unhelpful'].includes(op.outcome)?'缺少明确的正面或反面评价':
        typeof op.quote!=='string'||!op.quote.trim()||op.quote.length>200?'反馈原话缺失或过长':
        !String(original).includes(op.quote)?'反馈引用与当前原话不一致':
        !Number.isFinite(op.confidence)||op.confidence<.75||op.confidence>1?'反馈判断把握不足（短期尝试需至少0.75，长期积累需0.9）':
        !['new','repeat','uncertain'].includes(op.evidenceKind)||typeof op.experienceId!=='string'?'缺少独立经历标记':'';
      if(reason){this.log(s,'invalid-feedback',{reason,sourceId:id});continue;}
      if(op.evidenceKind!=='new'||op.experienceId){this.log(s,'not-independent',{strategy:op.strategy});continue;}
      const fp=fingerprint(op.quote);
      if(s.evidence.some(e=>e.sourceId===id||e.fingerprint===fp)) {this.log(s,'duplicate',{strategy:op.strategy});continue;}
      // Keep revocations as tombstones. Never lose deduplication by trimming evidence.
      if(s.evidence.length>=96){this.log(s,'capacity');continue;}
      const e={id:randomUUID(),sourceId:id,strategy:op.strategy,outcome:op.outcome,confidence:op.confidence,quote:op.quote,fingerprint:fp,at,revoked:false};
      s.evidence.push(e);this.log(s,'evidence-added',{strategy:op.strategy,evidenceId:e.id});
    }
    this.persist();
  }
  view(key){
    if(!this.allowed(key))return {enabled:false,strategies:[],evidence:[],audit:[]};
    const s=this.state(key),now=this.now();
    const strategies=Object.entries(STRATEGIES).map(([id,def])=>{
      const rows=s.evidence.filter(e=>e.strategy===id&&!e.revoked&&now-e.at<60*DAY&&e.at<=now);
      // Multiple comments in one day do not manufacture many independent confirmations.
      const days=new Map();for(const e of rows.filter(x=>(x.confidence??1)>=.9)){const day=Math.floor(e.at/DAY);const old=days.get(day);if(!old||e.at>=old.at)days.set(day,e);}
      const votes=[...days.values()],positive=votes.filter(e=>e.outcome==='helpful'),negative=votes.filter(e=>e.outcome==='unhelpful');
      const last=rows.reduce((a,e)=>!a||e.at>=a.at?e:a,null),lastAt=last?.at||0;
      const weight=positive.reduce((n,e)=>n+2**(-(now-e.at)/(30*DAY)),0);
      const strength=weight/(weight+2+negative.length*2);
      const expired=!!last&&now-lastAt>=30*DAY;
      const active=positive.length>=3&&positive.length/(votes.length||1)>=.75&&strength>=.45&&!expired&&last?.outcome==='helpful';
      const trial=!active&&!expired&&last?.outcome==='helpful'&&!rows.some(x=>x.outcome==='unhelpful')&&now-lastAt<2*DAY;
      const status=s.disabled.includes(id)?'disabled':!rows.length?'empty':expired?'fading':last?.outcome==='unhelpful'?'contradicted':active?'active':trial?'trial':'candidate';
      return {id,label:def.label,hint:def.hint,status,strength,lastEvidenceAt:lastAt,positiveDays:positive.length,negativeDays:negative.length,evidenceIds:rows.map(e=>e.id)};
    });
    return structuredClone({adjustments:(s.adjustments||[]).filter(x=>!x.revoked&&!x.superseded&&x.expiresAt>now),enabled:this.enabled(),storageError:this.storageError,capacity:s.evidence.length>=96,strategies,evidence:s.evidence,audit:s.audit});
  }
  candidates(key,kind){
    if(!this.enabled()||!this.allowed(key))return [];
    const view=this.view(key),adjustment=view.adjustments.at(-1);
    return [...(adjustment?[{id:'adjustment:'+adjustment.id,type:'preference',text:JSON.stringify({request:adjustment.instruction,quote:adjustment.quote,expiresAt:adjustment.expiresAt,scope:'仅表达方式；当前要求优先，不改变权限和事实'}),score:.99,reason:'本人明确表达要求，临时遵循24小时，不计入长期习惯',evidenceIds:[adjustment.sourceId]}]:[]),
      ...view.strategies.filter(r=>['active','trial'].includes(r.status)&&STRATEGIES[r.id].kinds.includes(kind)).map(r=>({id:'pattern:'+r.id,type:'pattern',text:r.hint+(r.status==='trial'?'（单次明确反馈后的短期尝试，当前要求优先，不推断稳定偏好。）':''),score:r.status==='trial'?.91:.95+r.strength*.03,reason:r.status==='trial'?'已有明确正面反馈，48小时内按情境尝试；尚未形成习惯':'多日独立反馈支持，且适用于当前事件',evidenceIds:r.evidenceIds})).slice(0,1)];
  }
  adjust(key,operations,{id,at,original,source='user',current=true}={}){
    if(!this.allowed(key)||!this.enabled()||!current||source!=='user'||!id||!Number.isFinite(at))return;
    const s=this.state(key);
    if(!Array.isArray(operations)||operations.length>1){this.log(s,'invalid-adjustment',{reason:'表达要求必须是最多一项的数组',sourceId:id});this.persist();return;}
    for(const op of operations){
      if(!op||op.kind!=='response_style'||op.explicit!==true||typeof op.instruction!=='string'||!op.instruction.trim()||op.instruction.length>140||typeof op.quote!=='string'||!op.quote.trim()||op.quote.length>200||!String(original).includes(op.quote)||!Number.isFinite(op.confidence)||op.confidence<.9||op.confidence>1){this.log(s,'invalid-adjustment',{reason:'需要本人明确的表达要求、对应原话和至少0.9的把握',sourceId:id});continue;}
      const proof=fingerprint(op.quote);
      if(s.adjustments.some(x=>x.sourceId===id)||s.adjustments.some(x=>!x.revoked&&!x.superseded&&x.proof===proof&&at-x.at<DAY)){this.log(s,'duplicate-adjustment',{sourceId:id});continue;}
      for(const old of s.adjustments)old.superseded=true;
      s.adjustments.push({id:randomUUID(),instruction:op.instruction.trim(),quote:op.quote,sourceId:id,proof,at,expiresAt:at+DAY,revoked:false});s.adjustments=s.adjustments.slice(-8);
      this.log(s,'adjustment-added',{sourceId:id,reason:'本人的明确表达要求已记录，24小时内优先参考'});
    }
    this.persist();
  }
  edit(key,{action,id}){
    if(!this.allowed(key))throw Error('invalid-scope');const s=this.state(key);
    if(action==='dismiss-adjustment'){const row=s.adjustments.find(x=>x.id===id);if(!row||row.revoked)throw Error('invalid-adjustment');row.revoked=true;this.log(s,'adjustment-dismissed',{sourceId:row.sourceId});}
    else if(action==='revoke') {const row=s.evidence.find(e=>e.id===id);if(!row||row.revoked)throw Error('invalid-evidence');row.revoked=true;this.log(s,'revoked',{evidenceId:id,strategy:row.strategy});}
    else if(['disable','resume'].includes(action)&&Object.hasOwn(STRATEGIES,id)) {s.disabled=action==='disable'?[...new Set([...s.disabled,id])]:s.disabled.filter(k=>k!==id);this.log(s,action,{strategy:id});}
    else throw Error('invalid-action');
    this.persist();return this.view(key);
  }
}
