import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {SourceValidity} from '../bridge/source-validity.mjs';import {Continuity} from '../bridge/continuity.mjs';import {ResponsePatterns} from '../bridge/response-patterns.mjs';import {SelfReference} from '../bridge/self-reference.mjs';
function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'source-validity-')),file=path.join(dir,'test.db'),db=new DatabaseSync(file);
 db.exec('CREATE TABLE source_corrections(source_version TEXT PRIMARY KEY,scope TEXT,event_id TEXT,state TEXT,revision INTEGER)');
 const v=new SourceValidity({file});return {v,db,revoke:(id,scope='private:1')=>db.prepare("INSERT OR REPLACE INTO source_corrections VALUES(?,?,?,'revoked',1)").run(scope+'/'+id,scope,id),undo:id=>db.prepare("UPDATE source_corrections SET state='restored',revision=2 WHERE event_id=?").run(id),close(){v.close();db.close();fs.rmSync(dir,{recursive:true,force:true})}};
}
const key='private:1',neutral=()=>({summary:'普通交流',appraisal:{kind:'neutral',target:'none',confidence:.95,intensity:0,evidence:[]},concerns:[],beliefs:[],focusIds:[],relationship:{kind:'none',quote:''}});
test('local reader detects commits, scopes IDs, survives reopen and does not hide absent evidence',()=>{
 const f=fixture();try{const before=f.v.revision();assert.equal(f.v.blocked(key,['e1']),false);f.revoke('e1');assert.notEqual(f.v.revision(),before);assert.equal(f.v.blocked(key,['e1']),true);assert.equal(f.v.blocked('group:1',['e1']),false);f.v.close();assert.equal(f.v.blocked(key,[{id:'e1'}]),true);f.undo('e1');assert.equal(f.v.blocked(key,['e1']),false);}finally{f.close()}
 const missing=new SourceValidity({file:path.join(os.tmpdir(),'absent-validity-db',Date.now()+'.db')});assert.equal(missing.blocked(key,['e1']),true);assert.equal(missing.blocked(key,[]),false);
});
test('withdrawal excludes concerns and beliefs from actual prompt and idle seed, keeping history and numbers',async()=>{
 const f=fixture();try{
 const c=new Continuity({enabled:()=>true,allowed:()=>true,sourceBlocked:(k,r)=>f.v.blocked(k,r),sourceRevision:()=>f.v.revision(),generate:async()=>JSON.stringify({...neutral(),concerns:[{id:'',action:'open',title:'周末旅行',detail:'周末准备出行',quote:'周末旅行',ttlHours:72}],beliefs:[{id:'',action:'propose',text:'也许喜欢旅行',quote:'周末旅行',evidenceKind:'new'}]})});
 await c.observe(key,{text:'周末旅行'},c.begin(key,'m1'));assert.match(c.prompt(key,{}),/周末旅行/);
 const saved=structuredClone(c.state(key)),id=c.state(key).concerns[0].evidence[0].id;f.revoke(id);
 assert.doesNotMatch(c.prompt(key,{}),/周末旅行|也许喜欢旅行/);assert.equal(c.idleQuery(key),'');assert.deepEqual(c.state(key).concerns,saved.concerns);assert.deepEqual(c.state(key).relation,saved.relation);assert.equal(c.snapshot(key).concerns[0].sourcePaused,true);
 f.undo(id);assert.match(c.prompt(key,{}),/周末旅行/);
 }finally{f.close()}
});
test('event-understanding result in flight is rejected when source validity changes',async()=>{
 const f=fixture();try{let finish;const c=new Continuity({enabled:()=>true,allowed:()=>true,sourceBlocked:(k,r)=>f.v.blocked(k,r),sourceRevision:()=>f.v.revision(),generate:()=>new Promise(r=>finish=r)});
 const work=c.observe(key,{text:'普通消息'},c.begin(key,'m2'));f.revoke('old');finish(JSON.stringify(neutral()));assert.equal(await work,null);assert.equal(c.state(key).events.at(-1).status,'interrupted');
 }finally{f.close()}
});
test('response feedback/adjustments and self-reference stop influencing prompts without deleting their evidence',()=>{
 const f=fixture();try{
 const p=new ResponsePatterns({allowed:()=>true,enabled:()=>true,sourceBlocked:(k,r)=>f.v.blocked(k,r)}),now=Date.now();
 p.observe(key,[{strategy:'concise_first',outcome:'helpful',experienceId:'',evidenceKind:'new',quote:'短一点更好',confidence:.96}],{id:'e1',at:now,original:'短一点更好'});
 assert.ok(p.candidates(key,'neutral').length);
 p.state(key).adjustments.push({id:'a1',sourceId:'e1',instruction:'简短表达',quote:'短一点更好',expiresAt:now+100000});
 const self=new SelfReference({enabled:()=>true,allowed:()=>true,sourceBlocked:r=>f.v.blocked(key,r),sourceRevision:()=>f.v.revision()});
 self.state.claims=[{id:'s1',category:'interest',text:'我对旅行好奇',evidence:[{id:'e1',quote:'旅行'}],evidenceDays:[1],confidence:.8,lastEvidenceAt:now,status:'tentative'}];
 const before=structuredClone(self.state);assert.match(self.render(key),/我对旅行好奇/);f.revoke('e1');
 assert.equal(p.candidates(key,'neutral').length,0);assert.equal(p.context(key).feedback.length,0);assert.equal(p.view(key).evidence[0].sourcePaused,true);
 assert.doesNotMatch(self.render(key),/我对旅行好奇/);assert.deepEqual(self.state,before);assert.equal(self.view().claims[0].sourcePaused,true);
 f.undo('e1');assert.match(self.render(key),/我对旅行好奇/);
 }finally{f.close()}
});
test('self-reference consolidation skips withdrawn queued inputs and discards pending output after correction',async()=>{
 const f=fixture();try{let calls=0,finish;const s=new SelfReference({enabled:()=>true,allowed:()=>true,sourceBlocked:r=>f.v.blocked(key,r),sourceRevision:()=>f.v.revision(),generate:()=>{calls++;return new Promise(r=>finish=r)}});
 s.observe(key,{id:'e1',at:Date.now(),original:'这次解释很具体',source:'user'});f.revoke('e1');assert.deepEqual(await s.consolidate({force:true}),{skipped:true});assert.equal(calls,0);
 f.undo('e1');const job=s.consolidate({force:true});f.revoke('e1');finish('{"changes":[]}');assert.deepEqual(await job,{skipped:true});assert.equal(s.state.claims.length,0);assert.equal(s.state.queue.length,1);
 }finally{f.close()}
});
