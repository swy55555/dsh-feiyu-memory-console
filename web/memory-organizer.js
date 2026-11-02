// Deliberately separate from extraction / paid semantic review.
export function organizerPanel(el, { api, confirmDialog, scopes, ownerQQ, onApplied }) {
  const root = el('section', {class:'card pad', id:'memory-organizer', style:{gridColumn:'1 / -1'}})
  const choices = scopes.filter(s => /^(private|group):[0-9]+$/.test(s.scope))
  const owner = ownerQQ ? `private:${ownerQQ}` : ''
  if (owner && !choices.some(s => s.scope === owner)) choices.unshift({scope:owner,label:'主人的私聊'})
  let scope = choices.some(s => s.scope === owner) ? owner : choices[0]?.scope || ''
  let plan = null, busy = false, error = '', result = null, selected = new Set(), cursor = ''
  let automatic=null, automaticError=''
  const labels = {archive:'可归档',confirm:'可确认',experience:'可自动记下原话',hold:'后台暂存'}
  const post = (route, body) => api(route, {method:'POST',body})
  async function loadAutomatic(body){
    try{automatic=body?await post('/organize/automatic',body):await api('/organize/automatic');automaticError=''}
    catch(e){automaticError=e.message}finally{draw()}
  }
  async function preview(after = '') {
    busy = true; error = ''; result = null; draw()
    try { plan = await post('/organize/preview', {scope,after}); cursor=after; selected = new Set() }
    catch(e) { error=e.message; plan=null }
    finally { busy=false; draw() }
  }
  async function apply(action = 'recommended') {
    if (!plan || !selected.size || busy) return
    busy=true; error=''; draw()
    try {
      if(action==='archive-selected') {
        const rows=plan.items.filter(r=>selected.has(r.id))
        const ok=await confirmDialog({title:`主动归档所选 ${rows.length} 条？`,
          desc:'这些记录会从当前记忆列表收起，不再参与正常记忆检索；正文、来源和有效期保留。待确认候选不会因此变成已确认事实。\n\n这是你的主动选择，包括仍在保护期或尚未审妥的所选记录，不代表它们是错误记忆。不调用模型，可在操作记录中撤销。\n\n所选记录：\n'+rows.map(r=>'• '+r.text).join('\n'),
          ok:'确认归档所选记录'})
        if(!ok) return
      }
      result=await post('/organize/apply',{scope,token:plan.token,ids:[...selected],action,acknowledge:action==='archive-selected'}); selected.clear(); await onApplied?.()
    }
    catch(e) { error=e.message }
    finally { busy=false; draw() }
  }
  function draw() {
    const heldOpen=root.querySelector('[data-held]')?.open || false
    root.replaceChildren(
      el('div',{class:'section-head'},el('h2',{class:'h2',text:'自动记忆维护'}),el('span',{class:'pill',text:'本地处理 · 0 新增模型调用'})),
      el('p',{class:'note',text:'完整自述、普通计划与经历核对原始消息后自动记下，只作为有来源的参考；已审妥的事实复用审核；符合规则的过期、淡化记录归档。后台每分钟轮转一个聊天、最多 50 条，不需要逐条点击，也不新增模型调用。原有效期不延长，核心及高重要记录不自动归档。'}),
      el('div',{class:'local-maintenance'},
        automatic?el('label',{},el('input',{type:'checkbox',checked:automatic.enabled,'aria-label':'开启本地自动整理',on:{change:e=>loadAutomatic({enabled:e.target.checked})}}),' 本地自动整理（不调用模型）'):null,
        el('button',{class:'btn sm',on:{click:()=>loadAutomatic()}},'刷新后台状态'),
        automaticError?el('p',{role:'alert',text:automaticError}):null,
        automatic?.error?el('p',{role:'alert',text:automatic.error}):null,
        automatic?.records?.length?el('p',{class:'note',text:`最近一批：检查 ${automatic.records[0].scanned} 条，处理 ${automatic.records[0].changed} 条。修改可在“最近改了什么”撤销；撤销后内容未变，不会再自动处理。`}):null),
      el('div',{class:'row',style:{flexWrap:'wrap'}},
        el('label',{},'选择聊天 ',el('select',{class:'input','aria-label':'整理哪个聊天',disabled:busy,on:{change:e=>{scope=e.target.value;plan=null;result=null;error='';selected.clear();draw()}}},
          ...choices.map(s=>el('option',{value:s.scope,selected:s.scope===scope,text:s.label || s.scope})))),
        el('button',{class:'btn primary',disabled:busy || !scope,on:{click:()=>preview()}},busy?'正在本地处理…':'本地预览（不调用模型）')))
    if(error) root.append(el('p',{role:'alert',text:error}))
    if(result) {
      root.append(el('p',{role:'status',text:`已处理 ${result.changed} 条，跳过 ${result.skipped.length} 条；新增模型调用 ${result.modelCalls} 次。${result.changed?'可在下方“最近改了什么”撤销本批修改。':'本批没有修改记忆。'}`}))
      if(result.skipped.length) root.append(el('ul',{},...result.skipped.map(r=>el('li',{text:`${plan.items.find(i=>i.id===r.id)?.text || r.id}：${r.reason}`}))))
      if(result.auditWarning) root.append(el('p',{role:'alert',text:`${result.auditWarning} ${result.undo?.operationId || ''}`}))
    }
    if(!plan) return
    const eligible = plan.items.filter(r=>r.action!=='hold')
    const selectedHeld=plan.items.filter(r=>selected.has(r.id) && r.action==='hold').length
    root.append(el('p',{class:'note',text:`本页 ${plan.items.length} 条待整理记录，其中 ${eligible.length} 条可按建议处理；所有条目都可主动选择归档。此聊天共 ${plan.total} 条，每页最多 50 条。预览保留 15 分钟。`}))
    if(plan.graceUntil>Date.now()) root.append(el('p',{class:'note',text:`新遗忘规则保护至 ${new Date(plan.graceUntil).toLocaleString()}，保护期内不建议归档。`} ))
    if(!plan.items.length) root.append(el('p',{class:'note',text:'暂时没有需要整理的记录，现有记忆保持原样。'}))
    const tools = el('div',{class:'row',style:{flexWrap:'wrap'}},
      el('button',{class:'btn sm',disabled:busy || !!result || !plan.items.length,on:{click:()=>{selected=new Set(selected.size===plan.items.length?[]:plan.items.map(r=>r.id));draw()}}},selected.size===plan.items.length && selected.size?'取消全选':'全选本页'),
      eligible.length?el('button',{class:'btn sm',disabled:busy || !!result,on:{click:()=>{selected=new Set(eligible.map(r=>r.id));draw()}}},'仅选择建议项'):null,
      el('button',{class:'btn sm primary',disabled:busy || !!result || !selected.size || !!selectedHeld,on:{click:()=>apply()}},`按建议处理 ${selected.size} 条`),
      el('button',{class:'btn sm',disabled:busy || !!result || !selected.size,on:{click:()=>apply('archive-selected')}},`主动归档所选 ${selected.size} 条`))
    root.append(tools)
    if(selectedHeld)root.append(el('p',{class:'note',text:`所选 ${selectedHeld} 条暂不符合建议处理条件，不能直接确认；可以保留，或主动归档。不调用模型。`}))
    const itemRow = item => el('div',{style:{padding:'12px 0',borderBottom:'1px solid var(--border)',overflowWrap:'anywhere'}},
      el('label',{},el('input',{type:'checkbox',checked:selected.has(item.id),disabled:busy || !!result,'aria-label':`选择：${item.text}`,on:{change:e=>{e.target.checked?selected.add(item.id):selected.delete(item.id);draw()}}}),` ${labels[item.action]} · ${item.text}`),
      el('p',{class:'note',text:item.reason}),
      item.expires_at?el('p',{class:'note',text:`原有效期至 ${new Date(item.expires_at*1000).toLocaleString()}`}):null,
      item.source_text?el('details',{},el('summary',{text:'查看原话'}),el('blockquote',{text:item.source_text})):null)
    if(eligible.length) root.append(el('div',{style:{maxHeight:'480px',overflowY:'auto'}},...eligible.map(itemRow)))
    const held=plan.items.filter(r=>r.action==='hold')
    if(held.length) root.append(el('details',{'data-held':'1',open:heldOpen,style:{marginTop:'14px'}},
      el('summary',{text:`后台暂存 ${held.length} 条 · 无需逐条处理`}),
      el('p',{class:'note',text:'这些内容尚不能作为事实使用，保留等待新的依据；不是必须完成的任务。原消息缺失或有真实冲突时才需要进一步核对。可选择另行开启付费语义审核，或主动归档。'}),
      el('div',{style:{maxHeight:'480px',overflowY:'auto'}},...held.map(itemRow))))
    root.append(el('p',{class:'note',text:'批内确认一条后，其他候选的相关事实可能改变，会跳过而非强行确认。核心、待办及高重要记忆不建议归档；未过期候选不会因等得久被归档。'}),
      el('div',{class:'row',style:{flexWrap:'wrap'}},
        el('button',{class:'btn sm',disabled:busy,on:{click:()=>preview(cursor)}},'重新预览本页'),
        el('button',{class:'btn sm',disabled:busy || !plan.next,on:{click:()=>preview(plan.next)}},'下一页')))
  }
  draw()
  void loadAutomatic()
  return root
}
