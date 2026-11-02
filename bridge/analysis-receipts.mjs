import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const hash=v=>createHash('sha256').update(v).digest('hex');
const unknown=()=>Object.assign(Error('上次后台调用结果不明，已暂停自动重试；手动重试可能再次计费'),{code:'ANALYSIS_OUTCOME_UNKNOWN'});

// Separate from the fact database: receipts cannot themselves confirm a memory.
// Store result + digests only (no prompts/credentials); exact scope/version keys and revalidation.
export class AnalysisReceipts {
  constructor({file,now=Date.now,ttlMs=86400000,maxEntries=128,maxBytes=4*1024*1024}={}) {
    Object.assign(this,{now,ttlMs,maxEntries,maxBytes});this.pending=new Map();
    fs.mkdirSync(path.dirname(file),{recursive:true});this.db=new DatabaseSync(file);
    this.db.exec('PRAGMA busy_timeout=3000; PRAGMA secure_delete=ON;');
    this.db.exec(`CREATE TABLE IF NOT EXISTS receipts (
      key TEXT PRIMARY KEY,scope TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,
      created INTEGER NOT NULL,expires INTEGER NOT NULL,value TEXT,digest TEXT,hits INTEGER NOT NULL DEFAULT 0)`);
  }
  async get(kind,context,modelSignature,run,shouldCache=()=>true,{validate=()=>true,retryUnknown=false}={}) {
    const scope=context?.key;if(!/^(private|group):\d+$/.test(scope))throw Error('Invalid analysis receipt scope');
    const key=hash(JSON.stringify(canonical(['analysis-v1',kind,modelSignature,context])));
    if(this.pending.has(key))return structuredClone(await this.pending.get(key));
    const job=this.execute(key,scope,kind,run,shouldCache,validate,retryUnknown);this.pending.set(key,job);
    try{return structuredClone(await job);}finally{this.pending.delete(key);}
  }
  async execute(key,scope,kind,run,shouldCache,validate,retryUnknown) {
    let row=this.db.prepare('SELECT * FROM receipts WHERE key=?').get(key);
    if(row?.state==='success'&&row.expires>this.now()) {
      try {
        if(hash(row.value)!==row.digest)throw Error('receipt digest mismatch');
        const value=JSON.parse(row.value);if(validate(value)===false)throw Error('receipt validation failed');
        this.db.prepare('UPDATE receipts SET hits=hits+1 WHERE key=?').run(key);return value;
      }catch{this.db.prepare('DELETE FROM receipts WHERE key=?').run(key);row=null;}
    }
    if(row&&['running','unknown'].includes(row.state)&&!retryUnknown)throw unknown();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // A second bridge process must not submit the same task concurrently.
      const current=this.db.prepare('SELECT * FROM receipts WHERE key=?').get(key);
      if(current?.state==='success'&&current.expires>this.now()) {
        let value,valid=false;
        try {value=JSON.parse(current.value);valid=hash(current.value)===current.digest&&validate(value)!==false;}catch{}
        if(valid){this.db.prepare('UPDATE receipts SET hits=hits+1 WHERE key=?').run(key);this.db.exec('COMMIT');return value;}
      }
      if(current&&['running','unknown'].includes(current.state)&&!retryUnknown)throw unknown();
      this.db.prepare("DELETE FROM receipts WHERE state IN ('success','failed') AND expires<=?").run(this.now());
      const size=()=>this.db.prepare('SELECT COUNT(*) n,COALESCE(SUM(length(CAST(value AS BLOB))),0) bytes FROM receipts').get();
      let measured=size();
      while((measured.n>=this.maxEntries&&!this.db.prepare('SELECT 1 FROM receipts WHERE key=?').get(key))||measured.bytes>this.maxBytes){
        const oldest=this.db.prepare("SELECT key FROM receipts WHERE state IN ('success','failed') ORDER BY created LIMIT 1").get();
        if(!oldest)throw Error('后台结果回执已满，请先处理结果不明的任务');
        this.db.prepare('DELETE FROM receipts WHERE key=?').run(oldest.key);measured=size();
      }
      this.db.prepare(`INSERT OR REPLACE INTO receipts(key,scope,kind,state,created,expires) VALUES(?,?,?,'running',?,?)`).run(key,scope,kind,this.now(),this.now()+this.ttlMs);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
    let settled=false;
    try {
      const value=await run();settled=true;
      if(validate(value)===false)throw Error('Invalid analysis result');
      const encoded=JSON.stringify(value);
      if(shouldCache(value)&&Buffer.byteLength(encoded,'utf8')<=Math.min(256*1024,this.maxBytes)){
        this.db.prepare("UPDATE receipts SET state='success',value=?,digest=? WHERE key=?").run(encoded,hash(encoded),key);
      }else this.db.prepare("UPDATE receipts SET state='failed',value=NULL,digest=NULL WHERE key=?").run(key);
      return value;
    }catch(error){
      const known=settled||error.outcomeKnown===true;
      this.db.prepare('UPDATE receipts SET state=? WHERE key=?').run(known?'failed':'unknown',key);
      if(!known)throw unknown();
      throw error;
    }
  }
  stats(scope) {
    const rows=this.db.prepare('SELECT state,COUNT(*) count,SUM(hits) hits FROM receipts WHERE scope=? GROUP BY state').all(scope);
    return {retentionHours:this.ttlMs/3600000,states:rows.map(r=>({...r,state:r.state==='running'?'pending-or-unknown':r.state})),pending:this.pending.size};
  }
  close(){this.db.close();}
}
