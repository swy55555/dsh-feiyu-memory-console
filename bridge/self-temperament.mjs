import {createHash} from 'node:crypto';
const DAY=86400000;
const clone=structuredClone;
const hash=s=>createHash('sha256').update(String(s).normalize('NFKC').replace(/[\s\p{P}\p{S}]+/gu,'')).digest('hex');
export function seedTemperament(persona){
 if(!persona?.spec?.dimensions?.length)return null;
 return {growthMode:'evidence',spec:clone(persona.spec),baseline:clone(persona.baseline),current:clone(persona.current),originBaseline:clone(persona.originBaseline||persona.baseline),history:[],receipts:[],pending:{},lastChangeAt:0};
}
export function temperamentLine(p){
 if(!p)return '';
 return '\n【缓慢变化的性格倾向】'+JSON.stringify(p.spec.dimensions.map(d=>({维度:d.label,含义:d.desc,倾向:p.current[d.key],参考起点:p.baseline[d.key]})))+'。0到100仅表示倾向，不是心情强度，也不是每轮必须表演的台词。结合当下语境与自我参考；高黏人不等于控制或索取，高嘴硬不要求撒谎、挖苦或否认真实感受。';
}
export function temperamentPrompt(p){
 return p?'\n同时参考六维倾向 '+JSON.stringify({dimensions:p.spec.dimensions,current:p.current,baseline:p.baseline,pending:p.pending})+'。每个 changes 条目可选 dimensionDeltas:{维度key:1或-1}，最多2维，仅原话明确支持的性格变化才提出。单次情绪、希望和指令不代表已经改变，不因数值高低自动修正。不同事件才能积累；只在跨至少3天的至少3次独立经历支持同方向、距上次变化至少7天时由程序缓慢落实。不要为了推动数值编造参考或证据。没有明确变化时省略。':'';
}
export function growTemperament(p,operations,now){
 if(!p)return null;
 const next=clone(p),known=new Set(p.spec.dimensions.map(d=>d.key));
 next.pending??={};next.receipts??=[];
 if(operations.some(({op})=>op.action==='retract'))next.pending={};
 for(const {op,evidence} of operations){
  if(op.dimensionDeltas===undefined)continue;
  const deltas=op.dimensionDeltas;
  if(!deltas||typeof deltas!=='object'||Array.isArray(deltas)||Object.keys(deltas).length>2||Object.entries(deltas).some(([k,v])=>!known.has(k)||![1,-1].includes(v)))throw Error('六维变化建议无效');
  if(op.confidence<.9||op.action==='retract')continue;
  for(const [key,delta] of Object.entries(deltas)){
   const experience=hash(op.experience),receipts=next.receipts.filter(r=>r.key===key);
   if(receipts.some(r=>r.experience===experience)||evidence.some(e=>receipts.some(r=>r.fp===e.fp)))continue;
   if(next.receipts.length+evidence.length>20000)continue;
   next.receipts.push(...evidence.map(e=>({key,experience,fp:e.fp})));
   const pending=next.pending[key];
   if(!pending||pending.delta!==delta)next.pending[key]={delta,events:[]};
   next.pending[key].events.push({at:Math.max(...evidence.map(e=>e.at)),experience,reason:op.experience,sourceIds:evidence.map(e=>e.id)});
   next.pending[key].events=next.pending[key].events.filter(e=>e.at>=now-90*DAY).slice(-32);
  }
 }
 if(now-(next.lastChangeAt||0)<7*DAY)return next;
 const changes=[];
 for(const d of next.spec.dimensions){
  const pending=next.pending[d.key];if(!pending)continue;
  const events=pending.events.filter(e=>e.at>=now-90*DAY);
  if(events.length<3||new Set(events.map(e=>Math.floor((e.at+8*3600000)/DAY))).size<3)continue;
  const before=next.current[d.key],anchor=next.baseline[d.key],band=d.band;
  const after=Math.max(0,anchor-band,Math.min(100,anchor+band,before+pending.delta));
  if(after===before)continue;
  next.current[d.key]=after;changes.push({key:d.key,before,after,evidence:clone(events)});delete next.pending[d.key];
  if(changes.length>=2)break;
 }
 if(changes.length){next.lastChangeAt=now;next.history=[...(next.history||[]),{at:now,source:'experience',changes}].slice(-60);}
 return next;
}
export function editTemperament(p,dimensions,reason,now){
 if(!p||!Array.isArray(dimensions)||dimensions.length!==p.spec.dimensions.length||typeof reason!=='string'||!reason.trim()||reason.length>160)throw Error('请填写全部维度及修正原因');
 const next=clone(p),seen=new Set(),changes=[];
 for(const row of dimensions){
  const d=next.spec.dimensions.find(d=>d.key===row?.key);
  if(!d||seen.has(d.key)||![row.current,row.baseline,row.band].every(Number.isInteger)||row.baseline<0||row.baseline>100||row.band<0||row.band>40||row.current<Math.max(0,row.baseline-row.band)||row.current>Math.min(100,row.baseline+row.band))throw Error('六维数值无效：0–100、边界0–40，当前值需在边界内');
  seen.add(d.key);changes.push({key:d.key,before:next.current[d.key],after:row.current,baselineBefore:next.baseline[d.key],baselineAfter:row.baseline,bandBefore:d.band,bandAfter:row.band});
  next.current[d.key]=row.current;next.baseline[d.key]=row.baseline;d.baseline=row.baseline;d.band=row.band;
 }
 next.pending={};next.lastChangeAt=now;next.history=[...(next.history||[]),{at:now,source:'manual',reason:reason.trim(),changes}].slice(-60);return next;
}
