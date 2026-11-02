// Bounded local maintenance. It has no model runner and never sends chat messages.
export class LocalMemoryMaintenance {
  constructor({load,save,scopes,preview,apply,ready=async()=>true}) {
    Object.assign(this,{save,scopes,preview,apply,ready});this.busy=false;this.epoch=0
    const old=load()||{}
    const cursors=old.cursors&&typeof old.cursors==='object'&&!Array.isArray(old.cursors)?old.cursors:{}
    this.state={enabled:old.enabled!==false,cursors,lastScope:typeof old.lastScope==='string'?old.lastScope:'',records:(Array.isArray(old.records)?old.records:[]).slice(-30),error:''}
  }
  snapshot(){return {...this.state,cursors:undefined,running:this.busy,records:[...this.state.records].reverse(),modelCalls:0}}
  setEnabled(value){this.save({...this.state,enabled:value===true});this.state.enabled=value===true;this.epoch++;return this.snapshot()}
  dispose(){this.epoch++}
  async tick(){
    if(this.busy||!this.state.enabled)return this.snapshot()
    this.busy=true;const epoch=this.epoch,valid=()=>this.state.enabled&&this.epoch===epoch
    try {
      if(!await this.ready()||!valid())return this.snapshot()
      const scopes=(await this.scopes()).filter(s=>/^(private|group):\d+$/.test(s)).sort()
      if(!scopes.length||!valid())return this.snapshot()
      const scope=scopes.find(s=>s>this.state.lastScope)||scopes[0]
      this.save(this.state) // Fail before mutation if receipts cannot be persisted.
      const after=typeof this.state.cursors[scope]==='string'?this.state.cursors[scope]:''
      const plan=await this.preview(scope,after)
      if(!valid())return this.snapshot()
      const ids=plan.items.filter(r=>['experience','confirm','archive'].includes(r.action)).map(r=>r.id)
      let result={changed:0,skipped:[]}
      if(ids.length)result=await this.apply(scope,plan.token,ids)
      this.state.cursors[scope]=plan.next||'';this.state.lastScope=scope;this.state.error=result.auditWarning||''
      this.state.records=[...this.state.records,{scope,at:Date.now(),scanned:plan.items.length,changed:result.changed,
        skipped:result.skipped.length,auditId:result.auditId,undo:result.undo,modelCalls:0}].slice(-30)
      this.save(this.state)
    }catch(error){this.state.error=String(error.message||error)}finally{this.busy=false}
    return this.snapshot()
  }
}
