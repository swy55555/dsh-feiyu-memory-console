// Offline protocol preparation. Labels contribute category only, never retrieval.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [old,out]=process.argv.slice(2);if(!old||!out)throw Error('usage: node scripts/freeze-evidence-dev.mjs <old-run-root> <new-output>');
if(fs.existsSync(out))throw Error('preserve existing frozen protocol');
const hash=s=>createHash('sha256').update(s).digest('hex');
const allowed=new Set(['conv-26','conv-30','conv-41','conv-42','conv-43']);
const questions=fs.readFileSync(path.join(old,'inputs/questions.jsonl'),'utf8').trim().split('\n').map(JSON.parse).filter(r=>allowed.has(r.sampleId));
const categories=new Map();
for(const line of fs.readFileSync(path.join(old,'review-only/answers.jsonl'),'utf8').trim().split('\n')){
  if(![...allowed].some(id=>line.includes('"sampleId": "'+id+'"')))continue;
  const r=JSON.parse(line);categories.set(r.id,r.category);
}
if(questions.length!==762)throw Error('unexpected development pool');
const strata=new Map();for(const q of questions){const category=categories.get(q.id);if(!category)throw Error('missing category');const k=q.sampleId+'/'+category;if(!strata.has(k))strata.set(k,[]);strata.get(k).push({...q,category});}
const allocations=[...strata].map(([key,rows])=>({key,rows,n:Math.floor(rows.length*100/762),fraction:rows.length*100/762%1}));
let extra=100-allocations.reduce((s,r)=>s+r.n,0);for(const r of [...allocations].sort((a,b)=>b.fraction-a.fraction||a.key.localeCompare(b.key)))if(extra-->0)r.n++;
const seed='evidence-dev100-v1-2026-11-03';
const sample=allocations.flatMap(r=>r.rows.sort((a,b)=>hash(seed+a.id).localeCompare(hash(seed+b.id))).slice(0,r.n)).sort((a,b)=>a.id.localeCompare(b.id));
const bytes=sample.map(({category,...q})=>JSON.stringify(q)).join('\n')+'\n';
const protocol={version:1,seed,pool:762,heldOutUntouched:778,sample:100,sampleSha256:hash(bytes),selection:'largest-remainder proportional allocation by dialogue/category; SHA256 seeded ordering; no score selection',strata:allocations.map(({key,rows,n})=>({key,pool:rows.length,selected:n})),
 conditions:[{id:'legacy-auto',status:'preserved-existing-results',rerun:false},{id:'legacy-full',base:'142e99e99ae55135e20d9596072975c7d11ef94a',status:'future-authorized-run-only',tools:['qq_vmem_search'],candidatePolicy:'existing strict review; never auto-confirm all',summaries:'existing bounded implementation'},{id:'evidence-full',status:'offline-diagnostics-only; future-authorized-answer-run',tools:['qq_vmem_search']}],
 commonBudget:{callsPerTurn:4,recordsPerTurn:10,evidenceChars:6000,referenceChars:8000,timeoutMs:2000},
 models:{embedding:'BAAI/bge-small-zh-v1.5; existing local cache',answer:'must equal archived run-manifest; not invoked',judge:'must equal archived run-manifest; not invoked'},
 scoring:'Do not infer answer quality from source hits. Report source availability, retrieval, delivered context and answer accuracy separately.',paidAuthorization:false};
fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'questions.jsonl'),bytes);fs.writeFileSync(path.join(out,'protocol.json'),JSON.stringify(protocol,null,2));console.log(JSON.stringify({sample:sample.length,sha256:protocol.sampleSha256,strata:allocations.length,paidCalls:0}));
