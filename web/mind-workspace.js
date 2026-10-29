import { mindLandscape, referenceText } from './mind-landscape.js';
const types={memory:'历史表述',concern:'相关挂念',belief:'待验证认识',emotion:'表达基调',pattern:'回应倾向',association:'可选联想',relation:'关系证据'};
const status={disabled:'已停用',empty:'暂无反馈',fading:'缺少新证据，已淡化',contradicted:'遇到反对反馈，暂停使用',active:'多日支持，可按情境使用',candidate:'积累中，尚不用于回应'};
const actions={'evidence-added':'加入反馈',duplicate:'重复反馈，未累加','not-independent':'同一经历或不确定，未累加','invalid-feedback':'反馈未通过校验',capacity:'证据容量已满，暂停积累',revoked:'撤销反馈',disable:'停用倾向',resume:'恢复倾向'};
const when=t=>t?new Date(t).toLocaleString():'尚无';
const displayText=referenceText;
export function mindWorkspacePanel(el,ui){
 const root=el('section',{class:'card pad mind-hub','aria-label':'心绪中枢'},el('span',{class:'eyebrow',text:'心有所感 · 念有所依'}),el('h2',{text:'心绪中枢'}),el('p',{class:'note',text:'感受此刻的心境，轻触一条线索，看看它从哪里来。'}));
 if(!ui.data){root.appendChild(el('p',{role:ui.error?'alert':'status',text:ui.error||'正在读取心绪中枢…'}));return root;}
 const {workspace:w,patterns:p,learningConfigured,continuityEnabled}=ui.data;
 const fold=(key,label)=>el('details',{class:'hub-fold',open:ui.folds?.[key]===true,on:{toggle:e=>{if(ui.folds)ui.folds[key]=e.target.open;}}},el('summary',{text:label}));
 const settings=fold('settings','中枢设置');
 settings.appendChild(el('div',{class:'mind-controls'},
  el('label',{},el('input',{type:'checkbox',checked:w.enabled,disabled:ui.loading,on:{change:e=>ui.change({enabled:e.target.checked})}}),' 启用本轮关注筛选'),
  el('label',{},el('input',{type:'checkbox',checked:learningConfigured,disabled:ui.loading,on:{change:e=>ui.change({learningEnabled:e.target.checked})}}),' 从明确反馈学习回应倾向（试验）')));
 settings.appendChild(el('p',{class:'note',text:'筛选默认开启，仅主人私聊，不单独调用模型。倾向学习默认关闭，需要同时开启下方的“连续事件理解”；复用同次调用，但会增加输入与输出 token。'}));
 if(!continuityEnabled&&learningConfigured)settings.appendChild(el('p',{class:'note',text:'学习开关已保存；连续事件理解未开启，目前不会积累或使用回应倾向。'}));
 if(!w.enabled)settings.appendChild(el('p',{text:'已关闭筛选，沿用原有回复参考方式；历史反馈仍保留。'}));
 root.appendChild(settings);
 const meter=el('div',{class:'hub-budget'},el('span',{text:`本轮关注 ${(w.selected||[]).length}/${w.maxItems} 条 · ${w.usedChars}/${w.budgetChars} 字符`}));
 if(ui.visual)meter.appendChild(el('progress',{max:w.budgetChars,value:w.usedChars,'aria-label':'本轮参考字符使用量'}));const budget=fold('budget','本轮用量与来源');budget.appendChild(meter);
 budget.appendChild(el('p',{class:'small muted',text:'预算只计算这个参考块，包含标签，不是整段对话的 token 数。新的消息会清除旧展示；五分钟后不再显示上一轮内容。'}));
 const item=(r,i)=>el('article',{class:'hub-item'},el('span',{class:'mind-badge',text:`${i+1} · ${types[r.type]||r.type}`}),el('p',{text:displayText(r)}),el('p',{class:'small muted',text:r.reason||'按本轮相关性筛选'}),el('details',{},el('summary',{text:'来源与原始参考'}),el('p',{text:r.text}),el('p',{class:'small muted',text:`参考编号：${r.id}${r.evidenceIds?.length?' · 依据：'+r.evidenceIds.join('、'):''}`})));
 if(ui.visual)root.appendChild(mindLandscape(el,ui,types));
 else root.appendChild(el('div',{class:ui.visual?'hub-selected visual':'hub-selected'},...(w.selected?.length?w.selected.map(item):[el('p',{class:'muted',text:w.stale?'上一次展示已过期，等待新的私聊。':'暂无本轮参考，等待新的主人私聊。'})])));
 root.appendChild(budget);
 if(w.deferred?.length)root.appendChild(el('details',{},el('summary',{text:`未入选参考与原因（${w.deferred.length}）`}),...w.deferred.map(item)));
 const learning=fold('learning','回应习惯 · 从明确反馈中学习');
 learning.append(el('h3',{text:'回应倾向'}),el('p',{class:'note',text:'只学习回应方式，不改写事实、人格或关系分数。至少三个不同日期的独立反馈才可能生效；明确反对会立即暂停。无新反馈满三十天不再使用。'}));
 if(p.storageError)learning.appendChild(el('p',{role:'alert',text:'反馈保存异常，请检查磁盘与权限。'}));
 if(p.capacity)learning.appendChild(el('p',{role:'status',text:'反馈已达到 96 条保守上限，暂停加入新反馈；已撤销的记录仍用于去重，不会通过遗忘来反复加分。'}));
 for(const s of p.strategies||[]){
  const rows=(p.evidence||[]).filter(e=>e.strategy===s.id);
  learning.appendChild(el('article',{class:'hub-strategy'},el('h4',{text:s.label}),el('span',{class:'mind-badge',text:status[s.status]||s.status}),el('p',{text:s.hint}),
   el('p',{class:'small muted',text:`支持 ${s.positiveDays} 天 / 反对 ${s.negativeDays} 天 · 参考强度 ${Math.round(s.strength*100)}%（非准确率）${!p.enabled?' · 学习与使用当前未启用':''}`}),
   el('button',{class:'btn sm',disabled:ui.loading,on:{click:()=>ui.change({action:s.status==='disabled'?'resume':'disable',id:s.id})},text:s.status==='disabled'?'恢复此倾向':'停用此倾向'}),
   el('details',{},el('summary',{text:`查看反馈依据（${rows.length}）`}),...rows.map(e=>el('div',{class:'hub-evidence'},el('p',{text:e.quote}),el('p',{class:'small muted',text:`${when(e.at)} · ${e.outcome==='helpful'?'有帮助':'不合适'} · 消息 ${e.sourceId}${e.revoked?' · 已撤销':''}`}),e.revoked?null:el('button',{class:'btn sm',disabled:ui.loading,on:{click:()=>ui.change({action:'revoke',id:e.id})},text:'撤销这条反馈'}))))));
 }
 learning.appendChild(el('details',{},el('summary',{text:'最近处理记录'}),...(p.audit||[]).slice(-12).reverse().map(a=>el('p',{class:'small',text:`${when(a.at)} · ${actions[a.status]||a.status}`}))));
 root.appendChild(learning);
 root.appendChild(el('p',{class:'small muted',text:'情境练习用于离线检查规则，不给角色灌入模拟经历。设计参考小凌原创心光模块；本插件亦有 QQ 用户夜怀瑾、小甘心的贡献。'}));return root;
}
