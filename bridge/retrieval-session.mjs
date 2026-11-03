// One authorization/turn/source snapshot, shared by automatic and manual recall.
// No sending, model calls or memory reinforcement. References are opaque per turn.
import {randomBytes} from 'node:crypto';
import {deliveryChars,renderMemoryToolResult} from './evidence-model-view.mjs';
import {evidenceUnits} from './evidence-groups.mjs';
export {renderEvidence} from './evidence-model-view.mjs';

export class RetrievalSessions {
  constructor({request,revision=()=>null,now=Date.now,maxSessions=128,timeoutMs=2000}={}){
    Object.assign(this,{request,revision,now,maxSessions,timeoutMs});this.sessions=new Map();this.inflight=0;
  }
  reset(){this.sessions.clear();}
  invalidate(){for(const s of this.sessions.values()){s.revision=null;s.refs.clear();}}
  async search({key,turn,query,anchors=[],current=()=>true,maxCalls=4,maxChars=6000,maxItems=10,delivery='automatic'}={}){
    if(!/^(private|group):\d+$/.test(key)||!Number.isSafeInteger(turn)||typeof query!=='string'||!query.trim()||query.length>2000)throw Error('invalid retrieval request');
    if(!Array.isArray(anchors)||anchors.length>3||anchors.some(x=>typeof x!=='string'))throw Error('invalid anchors');
    if(!['automatic','manual'].includes(delivery))throw Error('invalid delivery mode');
    if(!current())return {status:'stale',records:[],modelText:''};
    const revision=this.revision();if(revision==='unavailable')return {status:'unavailable',records:[],modelText:''};
    maxCalls=Math.max(1,Math.min(6,Math.floor(Number(maxCalls)||4)));maxChars=Math.max(500,Math.min(12000,Math.floor(Number(maxChars)||6000)));maxItems=Math.max(1,Math.min(12,Math.floor(Number(maxItems)||10)));
    let s=this.sessions.get(key);
    if(!s||s.turn!==turn||s.revision!==revision||this.now()-s.at>600000){
      const prior=s?.turn===turn?s:null;
      s={turn,revision,at:this.now(),prefix:randomBytes(6).toString('hex'),serial:0,calls:prior?.calls||0,chars:prior?.chars||0,count:prior?.count||0,maxCalls:prior?.maxCalls??maxCalls,maxChars:prior?.maxChars??maxChars,maxItems:prior?.maxItems??maxItems,seen:new Set(),roots:new Set(),refs:new Map(),deliveries:new Map(),queries:new Set(),busy:false};
      this.sessions.set(key,s);while(this.sessions.size>this.maxSessions)this.sessions.delete(this.sessions.keys().next().value);
    }
    // A caller cannot enlarge an already established turn budget.
    maxCalls=s.maxCalls;maxChars=s.maxChars;maxItems=s.maxItems;
    const valid=()=>current()&&this.revision()===revision&&this.sessions.get(key)===s;
    const stats=()=>({calls:s.calls,contextChars:s.chars,records:s.count,maxCalls,maxChars});
    const publish=(status,records=[],trace)=>{
      let modelText=delivery==='manual'?renderMemoryToolResult({status,records}):undefined;
      let chars=delivery==='manual'?modelText.length:deliveryChars(records,delivery,status);
      // Empty control responses also consume budget. Once even the terminal
      // notice cannot fit, emit no text rather than silently exceeding the cap.
      if(s.chars+chars>maxChars){
        if(records.length)throw Error('evidence accounting overflow');
        status='budget-exhausted';modelText=delivery==='manual'?renderMemoryToolResult({status,records:[]}):undefined;
        chars=delivery==='manual'?modelText.length:0;
        if(s.chars+chars>maxChars){modelText='';chars=0;}
      }
      const batch={records:[...records],delivery,chars};
      s.chars+=chars;
      for(const item of records){
        const roots=item.contract.rootIds||[];s.count++;s.seen.add(item.id);roots.forEach(r=>s.roots.add(r));
        s.refs.set(item.ref,roots);s.deliveries.set(item.id,{ref:item.ref,roots,batch});
      }
      return {status,records,stats:stats(),trace,outputChars:chars,...(delivery==='manual'?{modelText}:{})};
    };
    if(anchors.some(id=>!s.refs.has(id)))return publish('invalid-anchor');
    const fingerprint=JSON.stringify([query.trim(),anchors]);
    if(s.queries.has(fingerprint))return publish('no-new-evidence');
    if(s.calls>=maxCalls||s.chars>=maxChars||s.count>=maxItems)return publish('budget-exhausted');
    if(s.busy||this.inflight>=2)return publish('busy');
    const versions=anchors.flatMap(id=>s.refs.get(id));
    const reserveFollowup=s.calls===0&&maxCalls>1&&maxItems>4&&maxChars>=2000;
    const responseLimit=reserveFollowup?Math.min(4,maxItems-s.count):Math.min(8,maxItems-s.count);
    const terminalReserve=renderMemoryToolResult({status:'budget-exhausted',records:[]}).length;
    const deliveryCeiling=reserveFollowup?Math.floor(maxChars*.65):maxChars-terminalReserve;
    s.calls++;s.queries.add(fingerprint);s.busy=true;this.inflight++;
    const started=this.now();let timer;
    const work=Promise.resolve().then(()=>this.request('/evidence/search',{scope:key,query,anchors:versions.slice(0,3),exclude:[...s.roots].slice(0,128),limit:responseLimit,at:this.now()},this.timeoutMs));
    work.finally(()=>{s.busy=false;this.inflight--;}).catch(()=>{});
    try{
      const data=await Promise.race([work,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('timeout')),this.timeoutMs);})]);
      if(!valid())return publish('stale');
      if(!Array.isArray(data.results))throw Error('invalid evidence response');
      const records=[],dropped=[],pendingRoots=new Set(s.roots),pendingIds=new Set(s.seen),eligible=[];
      for(const row of data.results){
        if(!row||typeof row.id!=='string'||row.scope!==key||row.contract?.scope!==key||typeof row.text!=='string'||!Array.isArray(row.contract.rootIds)||row.contract.rootIds.some(x=>typeof x!=='string'||!x)||['revoked','invalid','deleted'].includes(row.contract?.state)){dropped.push({id:row?.id,reason:'scope-or-contract'});continue;}
        eligible.push(row);
      }
      for(const unit of evidenceUnits(eligible,s.roots)){
        if(unit.missing){unit.rows.forEach(r=>dropped.push({id:r.id,reason:'incomplete-context-group'}));continue;}
        const additions=[],newIds=new Set(pendingIds),newRoots=new Set(pendingRoots);
        for(const row of unit.rows){
        const roots=Array.isArray(row.contract.rootIds)?row.contract.rootIds:[];
        if(newIds.has(row.id)||(roots.length&&roots.every(id=>newRoots.has(id)))){dropped.push({id:row.id,reason:'same-evidence-root'});continue;}
        const ref=s.prefix+':m'+(++s.serial);
        const item={ref,id:row.id,text:row.text,contract:row.contract,reason:{method:row.retrieval?.method},scope:row.scope,subject_id:row.subject_id||row.contract.speaker,tags:row.tags||'',score:row.score,associationId:row.associationId};
        if(unit.requiredRoots.length){item.contextVersions=unit.requiredRoots;item.contextRefs=[...s.deliveries.values()].filter(d=>d.roots.some(r=>unit.requiredRoots.includes(r))).map(d=>d.ref);}
        additions.push(item);newIds.add(row.id);roots.forEach(r=>newRoots.add(r));
        }
        if(!additions.length)continue;
        const chars=deliveryChars([...records,...additions],delivery);
        if(s.chars+chars>deliveryCeiling||s.count+records.length+additions.length>maxItems){additions.forEach(r=>dropped.push({id:r.id,reason:'context-budget'}));continue;}
        records.push(...additions);additions.forEach(r=>{pendingIds.add(r.id);r.contract.rootIds?.forEach(x=>pendingRoots.add(x));});
      }
      return publish(records.length?'matched':data.results.length?'no-new-evidence':'empty',records,
        {query,selected:records.map(r=>r.id),dropped,elapsedMs:this.now()-started,vectorStatus:data.vectorStatus,localOnly:true});
    }catch{return publish(valid()?'unavailable':'stale');}
    finally{clearTimeout(timer);}
  }
  releaseUndelivered(key,turn,ids){
    const s=this.sessions.get(key);if(!s||s.turn!==turn)return;
    const batches=new Set();
    const release=new Set(ids);
    for(const id of ids){const d=s.deliveries.get(id);if(!d||d.batch.delivery!=='automatic')continue;
      for(const u of evidenceUnits(d.batch.records))if(u.rows.some(r=>r.id===id))u.rows.forEach(r=>release.add(r.id));
    }
    for(const id of release){const item=s.deliveries.get(id);if(!item||item.batch.delivery!=='automatic')continue;
      batches.add(item.batch);item.batch.records=item.batch.records.filter(r=>r.id!==id);
      s.seen.delete(id);s.refs.delete(item.ref);s.deliveries.delete(id);s.count--;
    }
    for(const batch of batches){const next=deliveryChars(batch.records,batch.delivery);s.chars-=batch.chars-next;batch.chars=next;}
    s.roots=new Set([...s.deliveries.values()].flatMap(x=>x.roots));
    if(ids.length)s.queries.clear(); // retries still consume the unchanged call budget
  }
}

