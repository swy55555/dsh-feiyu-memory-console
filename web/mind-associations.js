// One view of existing state: this renderer never generates thoughts or applies mood twice.
const statusLabels={disabled:'已关闭',ready:'已生成，等待合适话题','waiting-topic':'本轮不相关，继续暂存',waiting:'等待空闲','waiting-for-message':'等待新的私聊消息',exploring:'正在联想',stopped:'已收束','no-source':'没有相关事实',unavailable:'生成暂不可用',provided:'已准备参考，等待投递',injected:'已交给聊天模型（不代表实际表达）',expired:'已过期','source-changed':'来源已变化，已丢弃','validation-unavailable':'来源校验暂不可用',interrupted:'被新消息打断'};
export function mindAssociations(el,ui){
  const d=ui.idle,e=ui.emotion,enabled=d?.enabled??ui.overview.idleAssociation===true;
  const affect=d?.affectEnabled??ui.overview.idleAffect===true;
  const root=el('section',{class:'card pad mind-associations'},el('div',{class:'section-head'},el('div',{},el('span',{class:'eyebrow',text:'从经历到念头'}),el('h2',{text:'空闲联想与主观感受'}))),el('p',{class:'note',text:'空闲时从真实记忆延伸话题；临时感受与事件情绪共同影响表达，各自保留来源和期限。联想不自动变成事实或长期认识。'}));
  const controls=el('div',{class:'mind-controls'},el('label',{},el('input',{type:'checkbox',checked:enabled,disabled:ui.loading,on:{change:x=>ui.change({enabled:x.target.checked})}}),' 启用空闲联想（试验）'),el('label',{},el('input',{type:'checkbox',checked:affect,disabled:ui.loading,on:{change:x=>ui.change({affectEnabled:x.target.checked})}}),' 允许联想产生轻微主观感受（试验）'));
  root.appendChild(controls);
  if(!enabled&&affect)root.appendChild(el('p',{class:'note',text:'已保留感受设置；空闲联想关闭时不会产生新的联想感受。'}));
  if(ui.error)root.appendChild(el('p',{role:'alert',text:ui.error}));
  const stage=(n,title,...children)=>el('article',{class:'mind-stage'},el('span',{class:'eyebrow',text:n}),el('h3',{text:title}),...children);
  const sources=(d?.sources||[]).map(s=>el('p',{text:s.text}));
  const thoughts=(d?.nodes||[]).map((n,i)=>el('p',{text:`${i+1}. ${n.topic}`}));
  const impression=d?.impression;
  const flow=el('div',{class:ui.visual?'mind-flow':'mind-flow text-view'},
    stage('01 · 来源','真实记忆',...(sources.length?sources:[el('p',{class:'muted',text:'当前没有供联想使用的记忆。'})])),
    stage('02 · 延伸','临时话题',el('span',{class:'mind-badge',text:statusLabels[d?.status]||d?.status||(ui.error?'读取失败':'正在读取')}),...thoughts,d?.expiresAt?el('p',{class:'small muted',text:`保留至 ${new Date(d.expiresAt).toLocaleTimeString()}`}):null),
    stage('03 · 感受','未经确认的印象',el('p',{text:impression?impression.text:'当前没有生效的联想感受。'}),impression?el('p',{class:'small muted',text:`${({warmth:'温暖',curiosity:'好奇',concern:'牵挂'})[impression.feeling]||'临时感受'} · 愉悦偏移 ${Number(impression.valence||0).toFixed(3)} / 唤醒偏移 ${Number(impression.arousal||0).toFixed(3)} · ${new Date(impression.expiresAt).toLocaleTimeString()} 到期`}):null),
    stage('04 · 表达','此刻回应基调',el('p',{text:e?`${e.state?.label||'未提供'}${e.state?.nuance?' · '+e.state.nuance:''} · ${e.stance||'正常交流'}`:ui.emotionError||'正在读取情绪'}),el('p',{class:'small muted',text:'当前值已包含生效的感受，不会在此重复叠加。并非每轮都要谈论自己的情绪。'}),el('a',{href:'#/emotion',text:'查看情绪曲线与设置'})));
  root.appendChild(flow);
  root.appendChild(el('div',{class:'row'},el('button',{class:'btn sm',on:{click:ui.details},text:'查看联想去向'}),el('span',{class:'small muted',text:'交给模型不代表已经说出来；不会因为联想而主动发消息。'})));
  root.appendChild(el('details',{},el('summary',{text:'节奏、期限与消耗'}),el('p',{class:'note',text:'主人私聊安静两分钟后，一次生成最多三步短联想，逐步校验来源、重复和停止条件；每轮最多一次模型调用，两轮至少间隔三十分钟。话题保留十分钟，不相关时暂存。主观感受五分钟减半、十分钟失效，新的主人私聊消息清除旧感受。关闭联想清除临时话题；关闭感受清除当前印象。事件理解与空闲联想可分别开启。'})));
  return root;
}
