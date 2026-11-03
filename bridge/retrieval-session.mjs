// One authorization/turn/source snapshot, shared by automatic and manual recall.
// No sending, model calls or memory reinforcement. References are opaque per turn.
import {randomBytes} from 'node:crypto';
export {renderEvidence} from './evidence-model-view.mjs';

export class RetrievalSessions {
  constructor({request,revision=()=>null,now=Date.now,maxSessions=128,timeoutMs=2000}={}){
    Object.assign(this,{request,revision,now,maxSessions,timeoutMs});this.sessions=new Map();this.inflight=0;
  }
  reset(){this.sessions.clear();}
  invalidate(){for(const s of this.sessions.values()){s.revision=null;s.refs.clear();}}
  async search({key,turn,query,anchors=[],current=()=>true,maxCalls=4,maxChars=6000,maxItems=10}={}){
    if(!/^(private|group):\d+$/.test(key)||!Number.isSafeInteger(turn)||typeof query!=='string'||!query.trim()||query.length>2000)throw Error('invalid retrieval request');
    if(!Array.isArray(anchors)||anchors.length>3||anchors.some(x=>typeof x!=='string'))throw Error('invalid anchors');
    if(!current())return {status:'stale',records:[]};
    const revision=this.revision();if(revision==='unavailable')return {status:'unavailable',records:[]};
    let s=this.sessions.get(key);
    if(!s||s.turn!==turn||s.revision!==revision||this.now()-s.at>600000){
      const prior=s?.turn===turn?s:null;
      s={turn,revision,at:this.now(),prefix:randomBytes(6).toString('hex'),serial:0,calls:prior?.calls||0,chars:prior?.chars||0,count:prior?.count||0,seen:new Set(),roots:new Set(),refs:new Map(),deliveries:new Map(),queries:new Set(),busy:false};
      this.sessions.set(key,s);while(this.sessions.size>this.maxSessions)this.sessions.delete(this.sessions.keys().next().value);
    }
    const valid=()=>current()&&this.revision()===revision&&this.sessions.get(key)===s;
    const stats=()=>({calls:s.calls,contextChars:s.chars,records:s.count,maxCalls,maxChars});
    if(anchors.some(id=>!s.refs.has(id)))return {status:'invalid-anchor',records:[],stats:stats()};
    maxCalls=Math.max(1,Math.min(6,Number(maxCalls)||4));maxChars=Math.max(500,Math.min(12000,Number(maxChars)||6000));maxItems=Math.max(1,Math.min(12,Number(maxItems)||10));
    const fingerprint=JSON.stringify([query.trim(),anchors]);
    if(s.queries.has(fingerprint))return {status:'no-new-evidence',records:[],stats:stats()};
    if(s.calls>=maxCalls||s.chars>=maxChars||s.count>=maxItems)return {status:'budget-exhausted',records:[],stats:stats()};
    if(s.busy||this.inflight>=2)return {status:'busy',records:[],stats:stats()};
    const versions=anchors.flatMap(id=>s.refs.get(id));
    const reserveFollowup=s.calls===0&&maxCalls>1&&maxItems>4&&maxChars>=2000;
    const responseLimit=reserveFollowup?Math.min(4,maxItems-s.count):Math.min(8,maxItems-s.count);
    const deliveryCeiling=reserveFollowup?Math.floor(maxChars*.65):maxChars;
    s.calls++;s.queries.add(fingerprint);s.busy=true;this.inflight++;
    const started=this.now();let timer;
    const work=Promise.resolve().then(()=>this.request('/evidence/search',{scope:key,query,anchors:versions.slice(0,3),exclude:[...s.roots].slice(0,128),limit:responseLimit,at:this.now()},this.timeoutMs));
    work.finally(()=>{s.busy=false;this.inflight--;}).catch(()=>{});
    try{
      const data=await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),this.timeoutMs);})]);
      if(!valid())return {status:'stale',records:[],stats:stats()};
      if(!Array.isArray(data.results))throw Error('invalid evidence response');
      const records=[],dropped=[];
      for(const row of data.results){
        if(row.scope!==key||row.contract?.scope!==key||typeof row.text!=='string'){dropped.push({id:row.id,reason:'scope-or-contract'});continue;}
        const roots=Array.isArray(row.contract.rootIds)?row.contract.rootIds:[];
        if(s.seen.has(row.id)||(roots.length&&roots.every(id=>s.roots.has(id)))){dropped.push({id:row.id,reason:'same-evidence-root'});continue;}
        const ref=s.prefix+':m'+(++s.serial);
        const item={ref,id:row.id,text:row.text,contract:row.contract,reason:{method:row.retrieval?.method},scope:row.scope,subject_id:row.subject_id||row.contract.speaker,tags:row.tags||'',score:row.score,associationId:row.associationId};
        const chars=JSON.stringify(item).length+1;
        if(s.chars+chars>deliveryCeiling||s.count>=maxItems){dropped.push({id:row.id,reason:'context-budget'});continue;}
        s.chars+=chars;s.count++;s.seen.add(row.id);roots.forEach(r=>s.roots.add(r));s.refs.set(ref,roots);s.deliveries.set(row.id,{ref,roots,chars});records.push(item);
      }
      return {status:records.length?'matched':data.results.length?'no-new-evidence':'empty',records,stats:stats(),
        trace:{query,selected:records.map(r=>r.id),dropped,elapsedMs:this.now()-started,vectorStatus:data.vectorStatus,localOnly:true}};
    }catch{return {status:valid()?'unavailable':'stale',records:[],stats:stats()};}
    finally{clearTimeout(timer);}
  }
  releaseUndelivered(key,turn,ids){
    const s=this.sessions.get(key);if(!s||s.turn!==turn)return;
    for(const id of ids){const item=s.deliveries.get(id);if(!item)continue;s.seen.delete(id);s.refs.delete(item.ref);s.deliveries.delete(id);s.chars-=item.chars;s.count--;}
    s.roots=new Set([...s.deliveries.values()].flatMap(x=>x.roots));
    if(ids.length)s.queries.clear(); // retries still consume the unchanged call budget
  }
}

