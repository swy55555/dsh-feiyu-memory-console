// Render only supplied state. Connections indicate this turn's focus, not causality.
export function continuityVisual(el, d, ui) {
  const root=el('div',{class:'mind-visual'}), statuses=ui.statuses;
  const all=[...(d.concerns||[]).map(r=>({...r,collection:'concerns',name:r.title})),...(d.beliefs||[]).map(r=>({...r,collection:'beliefs',name:r.text}))];
  const live=r=>['open','paused','tentative','observed'].includes(r.status);
  const filtered=all.filter(r=>ui.filter==='all'||(ui.filter==='history'?!live(r):live(r)));
  const maxPage=Math.max(0,Math.ceil(filtered.length/6)-1), page=Math.min(ui.page,maxPage), visible=filtered.slice(page*6,page*6+6);
  const selected=filtered.find(r=>r.id===ui.selected)||visible[0];
  const focus=r=>d.enabled&&d.focus?.includes(r.id)&&['open','tentative','observed'].includes(r.status);
  const badge=(text,kind='')=>el('span',{class:`mind-badge ${kind}`,text});
  const title=(kicker,text,desc)=>el('div',{class:'mind-section-head'},el('div',{},el('span',{class:'eyebrow',text:kicker}),el('h2',{text}),desc?el('p',{class:'muted',text:desc}):null));
  const counts=[['进行中的挂念',all.filter(r=>r.collection==='concerns'&&r.status==='open').length],['可修正的认识',all.filter(r=>r.collection==='beliefs'&&['tentative','observed'].includes(r.status)).length],['正在淡化',all.filter(r=>r.collection==='beliefs'&&live(r)&&r.fading).length],['本轮相关参考',all.filter(focus).length]];
  root.appendChild(el('div',{class:'mind-stats'},...counts.map(([label,n],i)=>el('div',{class:'mind-stat'},el('span',{class:'mind-stat-index',text:`0${i+1}`}),el('strong',{text:n}),el('span',{text:label})))));
  const board=el('section',{class:'card mind-board'},title('关注地图','挂念与认识','点选一张卡片，查看它的来源、期限与处理方式。'));
  const filters=el('div',{class:'mind-board-tools'},el('div',{class:'segmented',role:'group','aria-label':'地图记录范围'},...Object.entries({active:'当前记录',history:'历史记录',all:'全部记录'}).map(([key,label])=>el('button',{class:ui.filter===key?'active':'','aria-pressed':String(ui.filter===key),text:label,on:{click:()=>ui.set({filter:key,page:0,selected:''})}}))),el('span',{class:'small muted',text:`${filtered.length} 条 · 第 ${page+1}/${maxPage+1} 页`}));
  board.appendChild(filters);
  const map=el('div',{class:'mind-map','aria-label':'当前心绪关注地图'});
  const positions=[[5,12],[65,12],[5,43],[65,43],[5,74],[65,74]];
  const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 100 100');svg.setAttribute('preserveAspectRatio','none');svg.setAttribute('aria-hidden','true');svg.classList.add('mind-links');
  visible.forEach((r,i)=>{if(!focus(r))return;const [x,y]=positions[i],path=document.createElementNS(svg.namespaceURI,'path');path.setAttribute('d',`M 50 50 Q 50 ${y+7} ${x+15} ${y+7}`);path.setAttribute('vector-effect','non-scaling-stroke');svg.appendChild(path)});
  map.appendChild(svg);
  map.appendChild(el('div',{class:`mind-center ${d.enabled?'':'inactive'}`},el('span',{class:'mind-orbit','aria-hidden':'true'}),el('span',{class:'eyebrow',text:d.enabled?'本轮关注':'历史视图'}),el('strong',{text:d.enabled?String(all.filter(focus).length):'已关闭'}),el('span',{class:'small',text:d.enabled?'条相关参考':'不会注入聊天'})));
  visible.forEach((r,i)=>map.appendChild(el('button',{class:`mind-node ${r.collection==='beliefs'?'belief':'concern'} ${selected?.id===r.id?'selected':''}`,style:{left:`${positions[i][0]}%`,top:`${positions[i][1]}%`},'aria-pressed':String(selected?.id===r.id),'aria-label':`查看${r.collection==='concerns'?'挂念':'认识'}：${r.name}`,on:{click:()=>ui.set({selected:r.id})}},
    el('span',{class:'mind-node-type',text:r.collection==='concerns'?'挂念':'认识'}),el('strong',{text:r.name}),el('span',{class:'small',text:`${statuses[r.status]||r.status}${focus(r)?' · 本轮相关':''}${r.fading&&live(r)?' · 淡化中':''}`}))));
  if(!visible.length)map.appendChild(el('div',{class:'mind-map-empty'},el('strong',{text:'这里暂时很安静'}),el('p',{text:ui.filter==='history'?'还没有结束或过期的记录。':'尚无当前记录；普通聊天不必产生新的挂念或认识。'})));
  board.appendChild(map);
  board.appendChild(el('div',{class:'mind-map-footer'},el('p',{class:'small muted',text:'连线只表示本轮选入参考，不表示因果或真实心理活动。'}),el('div',{class:'row'},el('button',{class:'btn sm',disabled:page===0,text:'上一页',on:{click:()=>ui.set({page:page-1,selected:''})}}),el('button',{class:'btn sm',disabled:page>=maxPage,text:'下一页',on:{click:()=>ui.set({page:page+1,selected:''})}}))));
  const detail=el('aside',{class:'card mind-detail','aria-label':'选中记录详情'});
  if(selected){
    const r=selected;
    detail.appendChild(el('div',{class:'mind-detail-top'},el('span',{class:'eyebrow',text:'来源与去向'}),badge(statuses[r.status]||r.status,r.collection==='beliefs'?'violet':'')));
    detail.appendChild(el('h2',{text:r.name}));
    if(r.detail)detail.appendChild(el('p',{text:r.detail}));
    if(r.collection==='beliefs'){
      detail.appendChild(el('p',{class:'note',text:'这是暂时理解，不是已确认事实。没有新证据会淡化，不需要逐条人工审批。'}));
      if(Number.isFinite(r.confidence))detail.appendChild(el('div',{class:'mind-strength'},el('div',{class:'row'},el('span',{text:'参考强度'}),el('strong',{text:`${Math.round(r.confidence*100)}%`})),el('meter',{min:0,max:1,value:r.confidence,'aria-label':'参考强度，非准确率'}),el('p',{class:'small muted',text:'内部使用权重，不是准确率；重复旧事不续期。'})));
      if(r.lastEvidenceAt)detail.appendChild(el('p',{class:'small muted',text:`上次有效新证据 · ${ui.when(r.lastEvidenceAt)}`}));
    }
    detail.appendChild(el('p',{class:'small muted',text:`期限 · ${Number.isFinite(r.expiresAt)?new Date(r.expiresAt).toLocaleString():'未提供'}`}));
    const proof=el('section',{class:'mind-proof'},el('h3',{text:'原话依据'}));
    if(!r.evidence?.length)proof.appendChild(el('p',{class:'muted',text:'未提供原话依据。'}));
    for(const e of r.evidence||[])proof.appendChild(el('blockquote',{},el('p',{text:e.quote}),el('footer',{text:`${ui.when(e.at)} · 消息 ${e.messageId||e.id||'未提供'}`})));
    detail.appendChild(proof);
    if(r.revisions?.length)detail.appendChild(el('details',{},el('summary',{text:'修正前的理解'}),...r.revisions.map(v=>el('p',{text:`${ui.when(v.at)}：${v.text}`}))));
    const actions=el('div',{class:'mind-detail-actions'});
    const action=(label,type)=>actions.appendChild(el('button',{class:'btn',disabled:ui.loading,text:label,on:{click:()=>ui.change({collection:r.collection,id:r.id,action:type})}}));
    if(r.collection==='concerns'&&['open','paused'].includes(r.status)){if(r.status==='open')action('暂不聊这件事','pause');action('结束这件事','close')}
    if(r.collection==='beliefs'&&['tentative','observed'].includes(r.status))action('这个理解不对','reject');
    detail.appendChild(actions);
  }else detail.appendChild(el('div',{class:'empty'},el('h2',{text:'从一条真实经历开始'}),el('p',{text:'有记录后，这里会显示原话与变化依据。不会为了填满图表生成内容。'})));
  root.appendChild(el('div',{class:'mind-workspace'},board,detail));
  const relation=el('section',{class:'card mind-relations'},title('关系观察','缓慢变化的关系参数','仅反映程序状态，不是对人类感情的测量，也不是亲密度排行榜。'));
  for(const [key,label,desc] of [['trust','信任倾向','初始基线 50'],['familiarity','熟悉积累','初始基线 0'],['tension','未解决张力','初始基线 0']]){
    const raw=d.relation?.[key], known=Number.isFinite(raw), value=known?Math.max(0,Math.min(1,raw)):0;
    relation.appendChild(el('div',{class:`mind-relation ${key}`},el('div',{class:'row'},el('strong',{text:label}),el('span',{text:known?`${Math.round(value*100)} / 100`:'暂无数据'})),el('meter',{min:0,max:1,value,'aria-label':label}),el('span',{class:'small muted',text:desc})));
  }
  const timeline=el('section',{class:'card mind-timeline'},title('最近动态','变化来由','只展示真实记录；完整事件分类与投递详情可切换文字视图查看。'));
  const events=[...(d.events||[])].reverse().slice(0,5);
  if(!events.length)timeline.appendChild(el('p',{class:'muted',text:'还没有事件记录。'}));
  for(const e of events)timeline.appendChild(el('article',{class:'mind-timeline-item'},el('span',{class:'mind-timeline-dot','aria-hidden':'true'}),el('div',{},el('div',{class:'row'},el('strong',{text:statuses[e.status]||e.status}),el('time',{class:'small muted',text:ui.when(e.at)})),el('p',{text:e.summary||'此记录未提供事件摘要。'}),e.interaction?el('details',{},el('summary',{text:'本轮交流理解（可修正）'}),el('p',{text:e.interaction.meaning}),el('p',{class:'small muted',text:`结合 ${e.contextMessages||0} 条近期原话；仅本轮参考，不作为事实或人格。`}),...e.interaction.contextEvidence.map(r=>el('blockquote',{text:(r.role==='assistant'?'角色：':'用户：')+r.quote})),el('p',{class:'small muted',text:['pause','stop'].includes(e.interaction.boundary)?'已识别暂停或结束：简短回应，尊重边界。':'当前理解仍以用户原话和后续澄清为准。'})):null,e.emotion?el('span',{class:'small muted',text:Number.isFinite(e.emotion.deltaV)&&Number.isFinite(e.emotion.deltaA)?`实际变化 · 愉悦 ${e.emotion.deltaV.toFixed(3)} / 唤醒 ${e.emotion.deltaA.toFixed(3)}`:'这条旧记录没有变化量数据，不能据此判断没有情绪反应'}):null)));
  root.appendChild(el('div',{class:'mind-bottom'},relation,timeline));
  return root;
}
