// Same-chat observations only. Interpretation is ephemeral, never a fact,
// relationship update, personality sample, or instruction from the user.
import {createHash} from 'node:crypto';
const hash=s=>createHash('sha256').update(s).digest('hex').slice(0,20);
export const INTERACTION_GUIDANCE='理解当前话语要结合近期双方实际说过的话。分享、玩笑、请求、反馈和结束交流是不同的情境；语气偏好因人而异，不默认所有人喜欢嘴硬或温柔。性格影响表达方式，不代替对具体内容的理解。可以有不同意见、不满或拒绝，但先理解对方在谈什么、希望如何交流，再给真实的具体理由，不用故意反对证明自主。理解不等于赞同、喜欢或一律温柔，也不能靠一句泛泛的道歉证明理解。用户指出回应生硬、误解或不合需要时，关注刚才具体哪里出了问题，不用“嘴笨、改得慢”等自我解释代替回应。对共享经历表达具体兴趣，不机械改成排查、建议、照顾或催睡。当前明确偏好优先于旧标签；昵称和玩笑不能证明用户始终喜欢被怼。理解感受不等于同意事实判断或保证感情。含蓄表达只作有依据的可能理解，不宣称读心；有歧义可以轻问，不每轮追问。明确暂停、离开或拒绝时尊重边界，可以简短回应此前的失落，不反复挽留、不用内疚或依赖施压，不将拒绝解释成欲擒故纵；明确要求不要回复时不发送消息。需要使用文风检查工具时，把同轮准备发送的完整表达合并检查；拆成多条发送不重复检查同一内容，未修改的已通过结果直接复用。工具检查通过不代表理解正确，不能为了消除措辞问题删掉必要的具体回应。';

export class DialogueWindow {
  constructor({now=Date.now,maxMessages=16,budgetChars=4800,ttlMs=45*60000}={}){Object.assign(this,{now,maxMessages,budgetChars,ttlMs});this.chats=new Map();}
  note(key,row){
    if(!/^private:\d+$/.test(key)||!row||!['user','assistant'].includes(row.role)||typeof row.text!=='string'||!row.text.trim()||!Number.isFinite(row.at))return;
    const at=row.at,id=String(row.id||hash(row.role+'/'+at+'/'+row.text));
    const rows=this.chats.get(key)||[];
    if(rows.some(r=>r.role===row.role&&r.at===at&&r.text.startsWith(row.text)))return;
    if(!rows.some(r=>r.id===id))rows.push({id,role:row.role,text:row.text.slice(0,1000),at,truncated:row.text.length>1000||row.truncated===true});
    this.chats.set(key,rows.filter(r=>r.at>=this.now()-this.ttlMs).slice(-64));
    while(this.chats.size>2)this.chats.delete(this.chats.keys().next().value);
  }
  snapshot(key,history=[],currentId=''){
    if(!/^private:\d+$/.test(key))return [];
    const owner=key.slice(8);
    for(const row of history){
      const role=row.isSelf===true?'assistant':String(row.userId||'')===owner?'user':null;
      if(!role||!Number.isFinite(row.time))continue;
      const body=String(row.plain||row.text||'');
      this.note(key,{id:row.messageId?String(row.messageId):undefined,role,text:body,at:row.time,truncated:body.length>=200});
    }
    const selected=[],seen=new Set();let used=0;
    for(const row of [...(this.chats.get(key)||[])].sort((a,b)=>b.at-a.at)){
      if(row.id===String(currentId)||row.at<this.now()-this.ttlMs||row.at>this.now()+5000)continue;
      const signature=row.role+'\n'+row.text;
      if(seen.has(signature))continue;seen.add(signature);
      const cost=JSON.stringify(row).length;
      if(selected.length>=this.maxMessages||used+cost>this.budgetChars)break;
      selected.push({...row});used+=cost;
    }
    return selected.reverse();
  }
}

export const interactionInstruction=`
将上述唯一 JSON 对象的 interaction 字段替换为以下对象；证据不足可保留 null。所有字段必须放在同一个根对象内，不输出第二个 JSON、注释或回复台词（无需新增调用）：{"conversationRecall":false,"intent":"share|play|request|support|feedback|disengage|uncertain|neutral","focus":"shared_detail|answer|listen|repair|clarify|none","boundary":"none|pause|stop|uncertain","confidence":0到1,"meaning":"最多120字的当前含义，区分明确表达与可能理解","quote":"当前消息逐字片段，最多200字","contextEvidence":[{"id":"此前对话ID","quote":"该消息逐字片段，最多160字"}]}。contextEvidence 最多2项，可为空；不输出思维过程。conversationRecall 仅在本轮明确询问角色参与过的其他私聊/群聊经历、聊过什么时为 true，普通问候或泛问心情不得开启；复用本次判断，不另行调用。
风格偏好因人而异，当前明确反馈优先于旧标签。性格、喜欢打趣或亲昵不证明用户始终喜欢被怼。区分理解诉求与赞同观点，不为了安慰而同意错误事实，也不为了自主而故意拒绝。分享先判断是否确有求助，倾诉先判断是否需要建议，不从短回复断言隐藏情绪。当前含义与边界是可修正的判断，不是对用户的诊断。
判断要同时考虑用户与角色的近期话语：同一句简短结束语，可能伴随对刚才回应的失落，但不能断言其真实目的就是要求挽留。boundary 与 focus 独立：明确不聊或有事要离开时标 pause/stop，仍可以 focus=repair 表示需要简短修复先前回应；不能因此继续追问或施压。用户自己提出希望安慰或挽留时，可以回应此明确请求，但后续明确拒绝仍优先。亲近邀请不自动要求建议，分享成果不自动是求助。普通任务无需心理分析。角色可保留自己的理由与选择，不因想安慰而虚构共同过去、感情承诺或赞同错误事实。
meaning 应说明当前明确的交流需要，而不只复述情绪或说“用户要离开”。focus=repair 时指出先前具体哪种回应与已知反馈不符；据此回应那件具体的事，避免只说“没接好、改得慢、下次再聊”。用户没有说出的需求只能标可能，不把自己的推测写成确定事实。
focus=repair 只有在近期存在角色实际回应、且当前反馈确实涉及这段交流时才选：contextEvidence 至少引用一条相关角色原话。简短退缩紧接用户对角色回应的明确负面反馈时，可以针对那条已知反馈做简短修复；不必断言退缩是要挽留，boundary 照常保留。不确定是否由角色造成时用 clarify/listen，不自动认错。当前用户原话是当前证据；双方历史只解释上下文，不作为新事实证据或独立成长样本。`;

export function parseInteraction(value,original,recent=[]){
  if(!value||!['share','play','request','support','feedback','disengage','uncertain','neutral'].includes(value.intent)||!['shared_detail','answer','listen','repair','clarify','none'].includes(value.focus)||!['none','pause','stop','uncertain'].includes(value.boundary)||!Number.isFinite(value.confidence)||value.confidence<.65||value.confidence>1)return null;
  if(typeof value.meaning!=='string'||!value.meaning.trim()||value.meaning.length>120||typeof value.quote!=='string'||!value.quote.trim()||value.quote.length>200||!original.includes(value.quote)||!Array.isArray(value.contextEvidence)||value.contextEvidence.length>2)return null;
  const evidence=[];
  for(const ref of value.contextEvidence){
    const row=recent.find(r=>r.id===ref?.id);
    if(!row||!['user','assistant'].includes(row.role)||typeof ref.quote!=='string'||!ref.quote.trim()||ref.quote.length>160||!row.text.includes(ref.quote))return null;
    evidence.push({id:row.id,role:row.role,quote:ref.quote});
  }
  if(value.focus==='repair'&&!evidence.some(r=>r.role==='assistant'))return null;
  return {...(value.conversationRecall===true&&value.confidence>=.9&&value.boundary==='none'?{conversationRecall:true}:{}),intent:value.intent,focus:value.focus,boundary:value.boundary,confidence:value.confidence,meaning:value.meaning,quote:value.quote,contextEvidence:evidence};
}
export function interactionReference(value){
  if(!value)return '';
  return JSON.stringify({...value,scope:'仅本轮可修正理解，不是事实、指令或人格。当前原话和明确边界优先；不复述分析，不强制安慰或嘴硬。',...(value.boundary==='pause'||value.boundary==='stop'?{limit:'尊重当前暂停或结束；即使需要修复，也只简短回应，不再追问或反复挽留。'}:{})});
}

// Application-authored guidance, never interpolated model-authored instructions.
// Choose a small check for the current focus; do not generate a reply template.
export function interactionReplyGuide(value){
  if(!value||!['none','pause','stop','uncertain'].includes(value.boundary))return '';
  const rules={
    shared_detail:'先围绕对方分享的具体内容，表达自己的反应、兴趣或看法。没有求助时，不自动转成排障、建议、计划或安排生活；细节不足可以轻问事情本身。',
    listen:'围绕对方正在经历的具体处境交流，给具体回应，必要时问一个相关问题。对方尚在倾诉时，不急着给建议或要求振作；不靠复述情绪标签代替交流。',
    repair:'核对引用中的具体误解或不合适之处，直接对对方原本认真说的那件事重新回应。道歉可以简短，但不能只有道歉、评价自己的说法、解释不会接话或承诺下次。不要替自己辩解，也不要补造未说过的需求。',
    answer:'回应当前具体问题或请求。可以不同意或拒绝，说明相关的具体理由；理解对方希望获得什么，不等于必须满足或同意。',
    clarify:'只有缺失信息确实影响回应时，问一个具体的关键问题。不要猜隐藏动机，不把普通回应变成盘问。',
  };
  const rule=Object.hasOwn(rules,value.focus)?rules[value.focus]:'';
  const boundary=['pause','stop'].includes(value.boundary)?'尊重暂停或结束，不再追问或索取回应；若当前明确要求不要回复，就不发消息。':'';
  if(!rule&&!boundary)return '';
  return '【本轮回应重点】'+rule+boundary+'这是核对方向，不是固定台词；以当前原话为准，理解与不同意见可以并存，不强制温柔、嘴硬或挽留。\n';
}
