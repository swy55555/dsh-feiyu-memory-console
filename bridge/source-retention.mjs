// Evidence retention only. This module has no model runner or QQ sender.
import {createHash} from 'node:crypto';
const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
const key=o=>JSON.stringify([o.kind,o.id]);
const validResult=(r,total)=>r?.ok===true&&['matched','unavailable','mismatch'].every(k=>Number.isInteger(r[k])&&r[k]>=0)&&r.matched+r.unavailable+r.mismatch===total;

export function sourceOwners(scope,{continuity,patterns,self}={}){
  if(!/^private:\d+$/.test(scope))throw Error('source-retention scope must be owner private');
  const subject=scope.slice(8),owners=new Map(),completeKinds=[];
  function add(kind,id,refs){
    if(typeof id!=='string'||!id||!Array.isArray(refs))throw Error('invalid evidence owner');
    const k=key({kind,id}),o=owners.get(k)||{kind,id,refs:[]};
    for(const e of refs){
      if(typeof e?.id!=='string'||!e.id||typeof e.quote!=='string'||!e.quote.trim()||e.quote.length>2000)throw Error('invalid evidence reference');
      const r={namespace:'event',id:e.id,subject,quote:e.quote};
      if(!o.refs.some(x=>x.id===r.id&&x.quote===r.quote))o.refs.push(r);
    }
    owners.set(k,o);
  }
  function chat(file){
    if(!file||file.version!==1||!Array.isArray(file.chats))throw Error('unrecognized evidence state');
    const matches=file.chats.filter(x=>Array.isArray(x)&&x[0]===scope);
    if(matches.length>1)throw Error('ambiguous evidence chat');
    return matches[0]?.[1];
  }
  if(continuity!==null&&continuity!==undefined){
    const state=chat(continuity);
    for(const [list,kind]of [['concerns','concern'],['beliefs','belief']]){
      if(state&&!Array.isArray(state[list]))throw Error('invalid continuity evidence');
      for(const o of state?.[list]||[]){
        add(kind,o.id,o.evidence||[]);
        for(const r of o.revisions||[])add(kind,o.id,r.evidence||[]);
      }
      completeKinds.push(kind);
    }
  }
  if(patterns!==null&&patterns!==undefined){
    const state=chat(patterns);
    for(const [list,kind]of [['evidence','response-evidence'],['adjustments','response-adjustment']]){
      if(state&&state[list]!==undefined&&!Array.isArray(state[list]))throw Error('invalid response evidence');
      for(const o of state?.[list]||[])add(kind,o.id,[{id:o.sourceId,quote:o.quote}]);
      completeKinds.push(kind);
    }
  }
  if(self!==null&&self!==undefined){
    if(self.version!==1||!Array.isArray(self.claims))throw Error('unrecognized self reference');
    for(const s of [self,...(self.history||[])])for(const c of s.claims||[])add('self-reference',c.id,c.evidence||[]);
    completeKinds.push('self-reference');
  }
  return {scope,owners:[...owners.values()].sort((a,b)=>key(a).localeCompare(key(b))),completeKinds};
}

export class SourceRetention {
  constructor({snapshot,request,load=()=>null,save=()=>{},now=Date.now}){
    Object.assign(this,{snapshot,request,save,now});this.state=load()||{version:1,scopes:{}};
    this.receiptError=this.state.version!==1||!this.state.scopes||Array.isArray(this.state.scopes);
    this.busy=false;this.retryAt=0;
  }
  async tick(){
    if(this.receiptError)throw Error('invalid source-retention receipt; original file retained');
    if(this.busy||this.now()<this.retryAt)return {skipped:true};
    this.busy=true;
    try{
      const snap=this.snapshot();if(!snap)return {skipped:true};
      const signature=hash(snap),old=this.state.scopes[snap.scope]||{known:[]};
      if(old.signature===signature&&(!old.unavailable||this.now()-old.at<10*60000))return {skipped:true};
      const present=new Set(snap.owners.map(key)),known=[...new Set([...(old.known||[]),...present])];
      // Persist ownership before remote writes, including partial/failed attempts.
      this.state.scopes[snap.scope]={...old,known};this.save(structuredClone(this.state));
      let matched=0,unavailable=0,mismatch=0,calls=0;
      for(const owner of snap.owners){
        // Bound each local HTTP payload; chunks append, never replace another chunk.
        let chunk=[];
        const flush=async()=>{if(!chunk.length)return;const r=await this.request('/sources/retain',{scope:snap.scope,owners:[{...owner,refs:chunk}]},8000);if(!validResult(r,chunk.length))throw Error('source retention rejected');matched+=r.matched;unavailable+=r.unavailable;mismatch+=r.mismatch;calls++;chunk=[];};
        for(const ref of owner.refs){if(chunk.length>=32||Buffer.byteLength(JSON.stringify([...chunk,ref]))>48000)await flush();chunk.push(ref);}
        await flush();
      }
      // Do not retire owners if their state changed during the network requests.
      if(hash(this.snapshot())!==signature)return {changedDuringSync:true,matched,unavailable,mismatch,modelCalls:0};
      const retired=known.filter(k=>{const [kind]=JSON.parse(k);return !present.has(k)&&snap.completeKinds.includes(kind);});
      for(let i=0;i<retired.length;i+=64){
        const owners=retired.slice(i,i+64).map(k=>{const [kind,id]=JSON.parse(k);return {kind,id,refs:[],release:true};});
        const r=await this.request('/sources/retain',{scope:snap.scope,owners},8000);if(!validResult(r,0))throw Error('source release rejected');calls++;
      }
      this.state.scopes[snap.scope]={known:known.filter(k=>!retired.includes(k)),signature,at:this.now(),unavailable:unavailable+mismatch,
        result:{matched,unavailable,mismatch,localRequests:calls,modelCalls:0}};
      this.save(structuredClone(this.state));return this.state.scopes[snap.scope].result;
    }catch(e){this.retryAt=this.now()+60000;throw e;}finally{this.busy=false;}
  }
}
