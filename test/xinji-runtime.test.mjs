import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {allowed, canonicalV2Key, modeAllowed} from '../bridge/xinji-policy.mjs';
import {retireLexiconTools} from '../bridge/retire-lexicon.mjs';
import {inspectRuntime} from '../bridge/xinji-engine.mjs';

test('shared access policy preserves deny precedence, numeric IDs and second-generation scopes',()=>{
  const cfg={ownerQQ:10,allow:{groups:[20],private:[10]},deny:{group:[30]},allowAllWhenEmpty:false};
  assert.equal(allowed('group','20',cfg),true);
  assert.equal(allowed('group',30,{...cfg,allow:{groups:[30]}}),false);
  assert.equal(allowed('group',40,cfg),false);
  assert.equal(modeAllowed('group:20','group',20,cfg,'reserved2'),true);
  assert.equal(modeAllowed('private:11','private',11,cfg,'closed-agent'),false);
  assert.equal(modeAllowed('private:10','private',10,cfg,'closed-agent'),true);
  assert.equal(canonicalV2Key(' group:00020 '),'group:20');
  for(const key of ['private:0','group:-1','group:9007199254740992','../state','private:1:2'])assert.equal(canonicalV2Key(key),null);
});

test('engine inspection never executes an adapter or creates state; absent modules are explicit',t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'xinji-check-'));t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
  fs.writeFileSync(path.join(tmp,'bridge-v09.js'),"import {x} from './missing.js';\nthrow Error('must never execute');");
  assert.deepEqual(inspectRuntime(tmp).missing,['missing.js']);
  assert.deepEqual(fs.readdirSync(tmp),['bridge-v09.js']);
  const child=spawnSync(process.execPath,[new URL('../bridge/xinji-engine.mjs',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),'--describe'],{encoding:'utf8',windowsHide:true});
  assert.equal(child.status,0);assert.equal(JSON.parse(child.stdout).engine,'xinji');
});

test('unknown MCP implementations are rejected before changing their content; clean files remain byte-identical',()=>{
  const clean=Buffer.from('export const keep = true;\r\n');assert.equal(retireLexiconTools(clean),clean);
  assert.throws(()=>retireLexiconTools(Buffer.from("server.tool('qq_slang_query', custom);")),/版本未知/);
});

test('meme library remains available without the automatic slang learner',async t=>{
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'xinji-api-'));process.env.DSH_HOME=tmp;
  const {createApiHandler}=await import('../lib/api.js');
  const server=http.createServer(createApiHandler());await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(tmp,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const get=await fetch(base+'/api/memes');assert.equal(get.status,200);
  const post=await fetch(base+'/api/memes/settings',{method:'POST',headers:{'content-type':'application/json','origin':base,'x-feiyu-console':'1'},body:'{"enabled":true}'});assert.equal(post.status,200);
  assert.equal(fs.existsSync(path.join(tmp,'qq-bridge/state/meme-play.json')),true);
});
