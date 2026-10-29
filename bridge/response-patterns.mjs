// Independently implemented evidence-backed response preferences.
// Design inspiration: 小凌's long-term tendencies; see ACKNOWLEDGEMENTS.md.
import {createHash, randomUUID} from 'node:crypto';
const DAY=86400000;
const fingerprint=s=>createHash('sha256').update(String(s).normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu,'').toLowerCase()).digest('hex');
export const STRATEGIES=Object.freeze({
  comfort_first:{label:'困扰时先倾听',kinds:['user_distress'],hint:'用户明确表达困扰时，先简短承接感受，再问是否需要建议；不要猜测隐藏情绪。'},
  concise_first:{label:'先简短，再按需展开',kinds:['neutral','criticism'],hint:'先给简明回应，再按用户需要展开；不能省略用户明确要求的细节。'},
  ask_before_advice:{label:'建议前先确认需要',kinds:['user_distress'],hint:'用户只是倾诉时先确认是否想听建议；用户已明确提问时直接回答。'},
  explain_correction:{label:'纠错时说明改动依据',kinds:['criticism'],hint:'被指出任务错误时先核对，说明修正和依据；不把纠错当成关系攻击。'},
});
export function learningInstruction(context) {
  if(!context)return '';
  return '\n可选 learning 最多1项：{"strategy":"comfort_first|concise_first|ask_before_advice|explain_correction","outcome":"helpful|unhelpful","experienceId":"新反馈用空字符串；同一经历重述填已有ID","evidenceKind":"new|repeat|uncertain","quote":"当前消息完整反馈原句，最多200字","confidence":0到1}。没有明确反馈则 learning:[]。只接受用户本人明确评价角色的回应方式是否有帮助，保留否定和适用情境。说自己累、说第三方、引用、假设、玩笑、简单谢谢、角色自己的回复、课程结果都不是反馈证据。不要靠情绪词判断。改写或补充同一反馈仍是repeat；不确定是否新经历用uncertain。只有新的实际反馈才用new；不同日期重述同一件事也不是new。策略只用于改善回应，不能推出用户人格或改变信任。已有反馈用于去重：'+JSON.stringify(context)+'\n';
}
export class ResponsePatterns {
  constructor({allowed,enabled,load=()=>null,save=()=>{},now=Date.now}) {
    Object.assign(this,{allowed,enabled,save,now});this.chats=new Map();this.storageError=false;
    try {
      const old=load();
      if(old?.version===1&&Array.isArray(old.chats))for(const [key,data] of old.chats){
        if(!allowed(key)||!data||!Array.isArray(data.evidence)||!Array.isArray(data.audit))continue;
        const evidence=data.evidence.filter(e=>e&&typeof e.id==='string'&&Object.hasOwn(STRATEGIES,e.strategy)&&['helpful','unhelpful'].includes(e.outcome)&&typeof e.quote==='string'&&e.quote.length<=200&&Number.isFinite(e.at)&&typeof e.sourceId==='string'&&typeof e.fingerprint==='string').slice(-96);
        this.chats.set(key,{evidence,audit:data.audit.slice(-80),disabled:Array.isArray(data.disabled)?data.disabled.filter(k=>Object.hasOwn(STRATEGIES,k)):[]});
      }
    }catch{this.storageError=true;}
  }
  state(key){if(!this.chats.has(key))this.chats.set(key,{evidence:[],audit:[],disabled:[]});return this.chats.get(key);}
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
    if(!Array.isArray(operations)||operations.length>1)return;
    for(const op of operations){
      if(!op||!Object.hasOwn(STRATEGIES,op.strategy)||!['helpful','unhelpful'].includes(op.outcome)||
         typeof op.quote!=='string'||!op.quote.trim()||op.quote.length>200||!String(original).includes(op.quote)||
         !Number.isFinite(op.confidence)||op.confidence<.9||op.confidence>1||
         !['new','repeat','uncertain'].includes(op.evidenceKind)||typeof op.experienceId!=='string'){
        this.log(s,'invalid-feedback');continue;
      }
      if(op.evidenceKind!=='new'||op.experienceId){this.log(s,'not-independent',{strategy:op.strategy});continue;}
      const fp=fingerprint(op.quote);
      if(s.evidence.some(e=>e.sourceId===id||e.fingerprint===fp)) {this.log(s,'duplicate',{strategy:op.strategy});continue;}
      // Keep revocations as tombstones. Never lose deduplication by trimming evidence.
      if(s.evidence.length>=96){this.log(s,'capacity');continue;}
      const e={id:randomUUID(),sourceId:id,strategy:op.strategy,outcome:op.outcome,quote:op.quote,fingerprint:fp,at,revoked:false};
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
      const days=new Map();for(const e of rows){const day=Math.floor(e.at/DAY);const old=days.get(day);if(!old||e.at>=old.at)days.set(day,e);}
      const votes=[...days.values()],positive=votes.filter(e=>e.outcome==='helpful'),negative=votes.filter(e=>e.outcome==='unhelpful');
      const last=rows.reduce((a,e)=>!a||e.at>=a.at?e:a,null),lastAt=last?.at||0;
      const weight=positive.reduce((n,e)=>n+2**(-(now-e.at)/(30*DAY)),0);
      const strength=weight/(weight+2+negative.length*2);
      const expired=!!last&&now-lastAt>=30*DAY;
      const active=positive.length>=3&&positive.length/(votes.length||1)>=.75&&strength>=.45&&!expired&&last?.outcome==='helpful';
      const status=s.disabled.includes(id)?'disabled':!rows.length?'empty':expired?'fading':last?.outcome==='unhelpful'?'contradicted':active?'active':'candidate';
      return {id,label:def.label,hint:def.hint,status,strength,lastEvidenceAt:lastAt,positiveDays:positive.length,negativeDays:negative.length,evidenceIds:rows.map(e=>e.id)};
    });
    return structuredClone({enabled:this.enabled(),storageError:this.storageError,capacity:s.evidence.length>=96,strategies,evidence:s.evidence,audit:s.audit});
  }
  candidates(key,kind){
    if(!this.enabled()||!this.allowed(key))return [];
    return this.view(key).strategies.filter(r=>r.status==='active'&&STRATEGIES[r.id].kinds.includes(kind)).map(r=>({id:'pattern:'+r.id,type:'pattern',text:r.hint,score:.6+r.strength*.1,reason:'多日独立反馈支持，且适用于当前事件',evidenceIds:r.evidenceIds})).slice(0,1);
  }
  edit(key,{action,id}){
    if(!this.allowed(key))throw Error('invalid-scope');const s=this.state(key);
    if(action==='revoke') {const row=s.evidence.find(e=>e.id===id);if(!row||row.revoked)throw Error('invalid-evidence');row.revoked=true;this.log(s,'revoked',{evidenceId:id,strategy:row.strategy});}
    else if(['disable','resume'].includes(action)&&Object.hasOwn(STRATEGIES,id)) {s.disabled=action==='disable'?[...new Set([...s.disabled,id])]:s.disabled.filter(k=>k!==id);this.log(s,action,{strategy:id});}
    else throw Error('invalid-action');
    this.persist();return this.view(key);
  }
}
