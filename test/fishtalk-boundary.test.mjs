import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
test('fishtalk public adapter excludes private, unknown-origin and persona rows even when asked for them',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'style-public-'));
 try{
  fs.copyFileSync(new URL('../scripts/support/fishtalk-reference.cjs',import.meta.url),path.join(dir,'reference.cjs'));
  fs.writeFileSync(path.join(dir,'store.js'),`exports.all=()=>${JSON.stringify([{id:'a',source:'qq',where:'private:123',scene:'QQ私聊',text:'PRIVATE SECRET'},{id:'b',source:'persona',scene:'人设·禁用',text:'杭州机房出生'},{id:'c',source:'bili',scene:'视频',text:'这段讲得挺明白的'},{id:'d',source:'text',scene:'文本',text:'UNKNOWN SECRET'}])};exports.labels=()=>({a:'good',b:'good',c:'good',d:'good'});`);
  fs.writeFileSync(path.join(dir,'distill.js'),`exports.sceneOf=r=>r.scene;`);
  const r=spawnSync(process.execPath,['-e',`const r=require('./reference.cjs');console.log(r.read({}));console.log(r.read({scene:'QQ私聊'}))`],{cwd:dir,encoding:'utf8',windowsHide:true});
  assert.equal(r.status,0);assert.match(r.stdout,/这段讲得挺明白/);assert.doesNotMatch(r.stdout,/PRIVATE SECRET|UNKNOWN SECRET|杭州机房出生/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
