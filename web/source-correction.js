export function sourceCorrectionPanel(row,{el,api}) {
  const panel=el('details',{class:'source-correction'}),body=el('div'),status=el('p',{class:'note',role:'status'});
  panel.append(el('summary',{text:'原话说错了：撤回依据或查看撤销'}),body,status);
  const request=(action,extra={})=>api('/source-correction/'+action,{method:'POST',body:{scope:row.scope,id:row.id,...extra}});
  let busy=false;
  const message='仅在整句原话本身说错、不能再作为依据时使用。如果只是提取错了、偏好后来变了，请编辑具体记忆；不要撤回整句原话。这里不会创建新的正确事实，也不会新增模型调用。';
  async function load(){
    if(busy)return;busy=true;status.textContent='正在核对来源版本…';body.replaceChildren();
    try{
      const p=await request('prepare');status.textContent='原话仍保留；此操作改变它能否继续作为依据。';
      body.append(el('p',{class:'note',text:message}));
      if(p.state==='revoked'){
        body.append(el('p',{text:'已撤回依据资格：'+p.reason}),el('button',{class:'btn ghost',text:'撤销这次来源纠正',on:{click:async event=>{
          event.preventDefault();const button=event.currentTarget;button.disabled=true;
          try{const r=await request('undo',{sourceVersion:p.sourceVersion,correctionRevision:p.correctionRevision});body.replaceChildren();status.textContent=`已撤销。恢复 ${r.restored||0} 条；${r.skipped||0} 条已有后续修改或仍依赖其他无效来源，保持现状。重新打开可查看。`;}catch(e){status.textContent=e.message;}finally{button.disabled=false;}
        }}}));return;
      }
      body.append(el('p',{text:`将暂停 ${p.count} 条当前记忆或摘要。心迹后续组装参考时，也会避开明确引用该来源的挂念、认识、回应反馈、表达要求与自我参考。`}),el('ul',{},p.targets.map(t=>el('li',{text:(t.kind==='memory'?'记忆：':'摘要：')+t.text}))),el('p',{class:'note',text:'暂停的记忆移入“已归档”，可以从本入口撤销。已产生的性格数值和心情不会倒退；未登记的间接链、已经交给模型的旧上下文不在本次清理范围内。'}));
      const reason=el('textarea',{rows:3,maxLength:300,style:{display:'block',width:'100%',boxSizing:'border-box',marginBottom:'12px'},placeholder:'请说明整句原话为什么不能再作为依据','aria-label':'撤回来源的原因'});
      const consent=el('input',{type:'checkbox'});
      const button=el('button',{class:'btn',text:'撤回这句原话的依据资格',disabled:true,on:{click:async event=>{
        event.preventDefault();button.disabled=true;
        try{const r=await request('apply',{sourceVersion:p.sourceVersion,revision:p.revision,reason:reason.value});body.replaceChildren();status.textContent=`已暂停 ${r.paused||0} 条记忆或摘要，未删除原话。重新打开这里可以撤销；没有调用模型。`;}catch(e){status.textContent=e.message;}finally{button.disabled=!(consent.checked&&reason.value.trim());}
      }}});
      const update=()=>button.disabled=!(consent.checked&&reason.value.trim());reason.addEventListener('input',update);consent.addEventListener('change',update);
      body.append(reason,el('label',{style:{display:'block',marginBottom:'12px'}},consent,'我确认要撤回整句原话的依据资格，而非只改一条记忆'),button);
    }catch(e){status.textContent=e.message;}finally{busy=false;}
  }
  panel.addEventListener('toggle',()=>{if(panel.open)void load();});return panel;
}
