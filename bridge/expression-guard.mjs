// Local style rules informed by fishtalk 0.3.6 (Nozzi2455, MIT).
// No corpus, private samples, model calls, automatic deletion or canned replies.
import {createHash} from 'node:crypto';
const digest=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex').slice(0,20);
const normalize=s=>String(s).normalize('NFKC').replace(/[\u200B-\u200D\uFEFF]/g,'');
const compact=s=>normalize(s).replace(/\s+/gu,'');
export const DEFAULT_EXPRESSION_RULES={enabled:true,hard:['这条我认','这话我不接','这份心意我收下了'],soft:['值得一提的是','这本身就是','希望这对你有所帮助']};
export function expressionSettings(raw=DEFAULT_EXPRESSION_RULES){
  if(!raw||typeof raw!=='object'||typeof raw.enabled!=='boolean')throw Error('表达规则需要启用开关');
  const list=key=>{
    if(!Array.isArray(raw[key])||raw[key].length>40)throw Error('每类最多 40 条完整短语');
    const values=raw[key].map(x=>{if(typeof x!=='string'||x.trim().length<3||x.trim().length>60||/[\r\n\x00-\x1f]/.test(x))throw Error('每条需为 3–60 字的单行短语，不支持正则');return x.trim()});
    return [...new Map(values.map(x=>[compact(x),x])).values()];
  };
  const hard=list('hard'),soft=list('soft');
  if(soft.some(x=>hard.some(y=>compact(x)===compact(y))))throw Error('同一短语不能同时禁止和提醒');
  return {enabled:raw.enabled,hard,soft};
}
// Only balanced quotation/code spans qualify. An entire reply in quotes is not
// automatically an exception. We do not pretend this syntax check understands intent.
function ownSpeech(text){
  let t=normalize(text).replace(/```[^\n]*\n[\s\S]*?```/g,' ').replace(/`[^`\n]+`/g,' ');
  const discussion=/(?:原话|原文|引用|句式|措辞|说法|台词|词语|这句话|这个词|例如|比如|刚才说|刚刚说)/u;
  t=t.replace(/“[^”\n]*”|「[^」\n]*」|『[^』\n]*』|"[^"\n]*"|‘[^’\n]*’/g,(span,at,whole)=>discussion.test(whole.slice(Math.max(0,at-70),at)+whole.slice(at+span.length,at+span.length+70))?' ':span);
  return t;
}
export function inspectExpression(messages,settings=DEFAULT_EXPRESSION_RULES){
  const rules=expressionSettings(settings),hard=[],warnings=[];
  if(!rules.enabled)return {hard,warnings};
  const raw=messages.map(String).join('\n'),speech=ownSpeech(raw),flat=compact(speech);
  for(const phrase of rules.hard)if(flat.includes(compact(phrase)))hard.push({phrase,reason:'管理员设定的禁用套话'});
  for(const phrase of rules.soft)if(flat.includes(compact(phrase)))warnings.push({phrase,reason:'表达提醒，不阻止发送'});
  if(/不是[^。！？!?\n]{1,24}[，,]\s*(?:而)?是/u.test(speech))warnings.push({phrase:'不是……而是……',reason:'可能是工整对仗，也可能是正常解释；只提醒'});
  if(/^(?:总之|综上所述|总而言之)[，,:：]/u.test(speech.trim()))warnings.push({phrase:'总结式开头',reason:'工作汇报和必要总结可以保留；只提醒'});
  return {hard,warnings};
}

export class ExpressionGuard {
  constructor({load=()=>null,save=()=>{},now=Date.now}={}){
    Object.assign(this,{save,now});const stored=load();
    this.settings=expressionSettings(stored?.settings||DEFAULT_EXPRESSION_RULES);
    this.revision=digest(this.settings);this.turns=new Map((stored?.turns||[]).filter(([k,r])=>typeof k==='string'&&r?.revision===this.revision).slice(-256));
    this.events=Array.isArray(stored?.events)?stored.events.slice(-80):[];
  }
  persist(){this.save({version:1,settings:this.settings,turns:[...this.turns],events:this.events});}
  view(){return structuredClone({settings:this.settings,revision:this.revision,events:this.events});}
  configure(settings,revision){
    if(revision!==this.revision)throw Error('规则已变化，请重新加载后保存');
    const next=expressionSettings(settings),hash=digest(next);
    if(hash!==this.revision){this.settings=next;this.revision=hash;this.turns.clear();this.persist();}
    return this.view();
  }
  blocked(actor,turn){const r=this.turns.get(actor);return this.settings.enabled&&r?.turn===turn&&r?.revision===this.revision&&r.attempts>=2;}
  check({actor,turn,key,messages}){
    const found=inspectExpression(messages,this.settings);
    if(!this.settings.enabled)return {ok:true,...found};
    if(this.blocked(actor,turn))return {ok:false,code:'EXPRESSION_REWRITE_LIMIT',terminal:true,hard:found.hard,warnings:found.warnings,error:'本轮表达改写已停止。不要继续调用发送或改用其他发送工具。等待新消息；管理员可在“人格与指令 → 表达规则”查看记录、修改规则。',sent:0};
    if(!found.hard.length){
      if(found.warnings.length)this.record({actor,key,status:'warning',phrases:found.warnings.map(x=>x.phrase)});
      return {ok:true,...found};
    }
    const old=this.turns.get(actor),attempts=old?.turn===turn&&old?.revision===this.revision?old.attempts+1:1;
    this.turns.set(actor,{turn,attempts,revision:this.revision});
    while(this.turns.size>256)this.turns.delete(this.turns.keys().next().value);
    const terminal=attempts>=2;
    this.record({actor,key,status:terminal?'stopped':'rewrite',phrases:found.hard.map(x=>x.phrase)});
    return {ok:false,code:terminal?'EXPRESSION_REWRITE_LIMIT':'EXPRESSION_REWRITE_REQUIRED',terminal,...found,sent:0,
      error:'命中的完整短语：'+JSON.stringify(found.hard.slice(0,5).map(x=>x.phrase))+'。'+(terminal?'改写后仍含禁用套话，本轮停止自动重试；没有发送这批消息。等待新消息，规则和记录可由管理员在表达规则页面查看。':'这批消息尚未发送。请保留具体意思、事实和有依据的分歧，改写命中的套话后一次性提交完整回复；只给一次改写机会。不要机械删词、包装成引用、重复调用 fishtalk_check，也不要改用其他发送工具绕过。')};
  }
  record(e){this.events.push({...e,at:this.now()});this.events=this.events.slice(-80);this.persist();}
  hint(){return this.settings.enabled?'【发送前表达检查】二代文本发送接口会在本地检查套话，不必为这些规则另调 fishtalk_check。禁用完整短语：'+this.settings.hard.slice(0,40).join('、')+'。引用或讨论句式可以按真实语境保留；宽泛句式仅提醒。命中后只改写一次，继续失败将停止本轮；当前请求与明确暂停仍优先。\n':'';}
}
