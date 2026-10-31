const labels={draft:'尚未整理',generating:'正在生成草案',review:'等待你核对',active:'已启用参考',paused:'已停用',archived:'已归档',error:'本次未生成'};
export function classroomPanel(el,ui){
 const root=el('div',{class:'classroom-page'},el('div',{class:'page-head'},el('div',{},el('span',{class:'eyebrow',text:'把经验留下，让表达有依据'}),el('h1',{text:'成长课堂'}),el('p',{class:'note',text:'自己定义要学什么。保存为独立的课程参考，不改写真实记忆或模型权重。'})),el('div',{class:'row'},el('button',{class:'btn',disabled:ui.loading,text:'刷新课堂',on:{click:ui.refresh}}),el('button',{class:'btn primary',disabled:ui.loading||!ui.data,text:'＋ 新建课程',on:{click:()=>ui.edit(null)}}))));
 if(!ui.data){root.appendChild(el('p',{role:ui.error?'alert':'status',text:ui.error||'正在读取课程…'}));return root;}
 const d=ui.data;
 root.appendChild(el('section',{class:'card pad'},el('label',{},el('input',{type:'checkbox',checked:d.enabled,disabled:ui.loading,on:{change:e=>ui.action({action:'settings',enabled:e.target.checked})}}),' 启用成长课堂（可选）'),
  el('p',{class:'note',text:`整理模型：${d.model||'后台模型'} · 推理 ${d.effort||'low'}。保存和编辑不调用模型；“生成草案”最多一次调用，同样材料复用结果。没有定时上课或自动重试。`} ),
  el('p',{class:'note',text:'流程：填写目标 → 自己写参考或让模型整理 → 核对后启用 → 相关聊天才取用。最多同时启用3门，每轮最多选1门；复用事件理解选课，会增加少量目录和参考文字，但不新增选课调用。'}),
  el('p',{role:'status',text:!d.enabled?'当前关闭：不生成、不使用课程参考。':!d.continuityEnabled?'课程可整理；连续事件理解未开启，目前不会自动选课。':!d.workspaceEnabled?'课程可整理；本轮关注筛选未开启，目前不会注入课程参考。':'已开启：生成的草案须经你核对，才会进入相关聊天的参考。'}),
  el('div',{class:'row'},el('button',{class:'btn sm',text:'从“自然说话”开始',disabled:ui.loading,on:{click:()=>ui.edit({title:'自然说话',goal:'结合具体语境和对方真正说过的话自然回应，减少套话、机械总结与无必要的建议；允许嘴硬或不同意见，但不要敷衍、猜隐藏动机，也不强制装亲昵。',when:'日常分享、闲聊和对表达方式的反馈',scene:'用户说：今天忙了一天，终于能坐下了。',example:''})}}),el('button',{class:'btn sm',text:'从“讲故事”开始',disabled:ui.loading,on:{click:()=>ui.edit({title:'讲故事',goal:'围绕明确主题，用具体情节和自然节奏讲故事；区分虚构故事与真实经历，不冒充角色实际经历。',when:'用户明确请求创作故事或续写',scene:'用户想听一个简短、温暖但不说教的小故事。',example:''})}}))));
 if(d.storageError)root.appendChild(el('p',{role:'alert',text:'课程保存异常，未保存的更改不会生效。'}));
 if(!(d.courses||[]).length)root.appendChild(el('section',{class:'card pad'},el('h2',{text:'从一门具体的小课开始'}),el('p',{text:'点“＋ 新建课程”，写清想改善的地方、适用场景，并可提供对话或示例。创建课程不会花 token。'})));
 for(const c of d.courses||[]){
  const button=(label,action,extra={},disabled=false)=>el('button',{class:'btn sm',disabled:ui.loading||disabled,text:label,on:{click:()=>ui.action({action,id:c.id,...extra})}});
  const card=el('section',{class:'card pad classroom-course','data-course-id':c.id},el('div',{class:'section-head'},el('h2',{text:c.title}),el('span',{class:'pill',text:labels[c.status]||c.status})),el('p',{text:c.goal}),el('p',{class:'note',text:'适用：'+c.when}));
  if(c.error)card.appendChild(el('p',{role:'alert',text:c.error}));
  card.appendChild(el('div',{class:'row'},el('button',{class:'btn sm',text:'编辑课程',disabled:ui.loading,on:{click:()=>ui.edit(c)}}),button('生成学习草案（最多1次调用）','generate',{},!d.enabled||d.busy||c.status==='archived'),el('button',{class:'btn sm',text:'自己写参考（不调用模型）',disabled:ui.loading,on:{click:()=>ui.edit(c,true)}}),...(c.active?[button('停用参考','pause')]:[]),...(c.status!=='archived'?[button('归档课程','archive')]:[])));
  if(c.draft){
   card.appendChild(el('div',{class:'hub-evidence'},el('h3',{text:'学习参考'}),el('p',{text:c.draft.guidance}),el('p',{text:'避免：'+(c.draft.avoid||'未另设')}),el('p',{class:'note',text:c.draftSource==='user'?'用户编写的参考；不是事实记忆。':'模型草案；格式通过不代表内容正确或已学会。'}),el('details',{},el('summary',{text:'查看模拟示例与核对要点'}),el('p',{text:c.draft.example||'未生成示例'}),el('p',{text:c.draft.rationale||''}),...(c.draft.checks||[]).map(t=>el('p',{text:'· '+t}))),
    !c.active?button('已核对，启用这份参考','approve',{revision:c.revision},c.status==='generating'):el('p',{class:'note',text:'已启用只代表允许作为参考；本轮是否选入，可在“当前心绪 → 本轮用量与来源”查看。'})));
  }
  card.appendChild(el('p',{class:'note',text:`生成尝试 ${c.attempts||0} 次 · 费用在“花费 → 成长课堂”查看。再次点击生成不会让相同材料反复付费。`}));
  if(c.draft)card.appendChild(el('div',{class:'row'},button('实际聊天有帮助','feedback',{outcome:'helpful'}),button('实际聊天不合适，先停用','feedback',{outcome:'unhelpful'})));
  if(c.feedback?.length)card.appendChild(el('details',{},el('summary',{text:'你填写的使用反馈（'+c.feedback.length+'）'}),...c.feedback.slice().reverse().map(f=>el('p',{text:new Date(f.at).toLocaleString()+' · '+(f.outcome==='helpful'?'有帮助':'不合适')+(f.note?' · '+f.note:'') })),el('p',{class:'note',text:'反馈用于人工核对，不当作能力分数。重复表态不会自动加强参考，也不会触发付费重练。'})));
  root.appendChild(card);
 }
 if(d.legacy?.lessons?.length)root.appendChild(el('details',{class:'card pad'},el('summary',{text:'旧表达教师历史（只读，已停止循环）'}),...d.legacy.lessons.map(l=>el('p',{text:l.guidance}))));
 root.appendChild(el('p',{class:'note',text:'这是外部经验与提示参考，不是模型微调，也不保证产生人的理解能力。效果应比较真实回应、事实准确性和用户反馈，不能用模型自评分或练习次数冒充学习效果。'}));
 return root;
}
