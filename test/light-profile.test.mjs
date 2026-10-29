import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'feiyu-profile-'));process.env.DSH_HOME=tmp;
try{
 fs.mkdirSync(path.join(tmp,'memvec'),{recursive:true});fs.mkdirSync(path.join(tmp,'qq-bridge/state'),{recursive:true});
 fs.writeFileSync(path.join(tmp,'qq-bridge/config.json'),JSON.stringify({ownerQQ:'123'}));
 fs.writeFileSync(path.join(tmp,'qq-bridge/state/social-v2.json'),JSON.stringify({conversations:{'private:123':{}}}));
 const db=new DatabaseSync(path.join(tmp,'memvec/memories.db'));
 db.exec(`CREATE TABLE memories(id TEXT,text TEXT,tags TEXT,scope TEXT,importance REAL,created_at REAL,last_access REAL,strength_days REAL,access_count INTEGER,status TEXT,fact_key TEXT,subject_id TEXT,source_id TEXT,source_text TEXT,source_time REAL,confidence REAL,expires_at REAL,superseded_by TEXT,last_reinforced REAL,tier TEXT,relation TEXT,related_id TEXT)`);
 const add=(id,scope,subject,status='active',expires=0,superseded='')=>db.prepare("INSERT INTO memories(id,text,scope,subject_id,status,expires_at,superseded_by,source_text,source_id,source_time) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id,'原话 '+id,scope,subject,status,expires,superseded,'依据 '+id,'source-'+id,Date.now()/1000);
 add('owner','private:123','123');add('wrong-person','private:123','456');add('other-chat','private:456','123');add('unknown','private:123','');
 add('candidate','private:123','123','candidate');add('deleted','private:123','123','deleted');add('expired','private:123','123','active',1);add('superseded','private:123','123','active',0,'new');
 add('group-a','group:1','123');add('group-b','group:1','456');db.close();
 const {lightGet}=await import('../lib/core.js');const owner=await lightGet('private:123');
 assert.deepEqual(owner.known.rows.map(r=>r.id),['owner']);assert.equal(owner.known.total,1);assert.equal(owner.known.rows[0].sourceText,'依据 owner');
 const group=await lightGet('group:1');assert.equal(group.known.total,2);assert.deepEqual(new Set(group.known.rows.map(r=>r.subjectId)),new Set(['123','456']));
 console.log('light profile OK: same-chat attribution, confirmed active only, expiry/supersession exclusion and original sources');
}finally{const rel=path.relative(os.tmpdir(),tmp);if(rel&&!rel.startsWith('..')&&!path.isAbsolute(rel))fs.rmSync(tmp,{recursive:true,force:true});}
