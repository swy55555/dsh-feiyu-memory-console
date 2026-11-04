import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {accountManager} from '../lib/shiguang-account.js';
import {notePreference,preferenceSignal,weightedPool} from '../bridge/owner-interest.mjs';
test('only explicit first person preference affects three genuine choices',()=>{
 for(const s of ['我朋友喜欢露营','你喜欢露营吗？','我喜欢露营吗','他说“我喜欢露营”','一起看露营吧'])assert.equal(preferenceSignal(s,'owner'),null);
 const rows=[],topics=[{topic:'露营',strength:.2},{topic:'折布',strength:.2}];
 const p=preferenceSignal('我喜欢露营','owner');assert.ok(notePreference(rows,p));assert.ok(!notePreference(rows,p));assert.equal(weightedPool(topics.slice(0,1),rows).used.length,0);
 for(let i=0;i<4;i++){const {pool,used}=weightedPool(topics,rows);assert.ok(Math.abs(pool[0].strength-(i<3?.3:.2))<1e-8);for(const r of used)r.left--;assert.equal(notePreference(rows,p),false);}
 notePreference(rows,preferenceSignal('我不喜欢折布','self'));notePreference(rows,preferenceSignal('我喜欢折布','owner'));assert.equal(weightedPool(topics,rows).used.length,0);
});
test('renewal preserves old credentials on expiry, cancellation and wrong UID',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'shiguang-account-test-')),file=path.join(dir,'c.json');
 try{
 let code=86101,uid='123',navCode=0;
 const api=accountManager(async url=>url.includes('generate')?{code:0,data:{url:'https://passport.bilibili.com/test',qrcode_key:'fixture-key'}}:url.includes('poll?')?{code:0,data:{code,url:'https://passport.bilibili.com/?DedeUserID='+uid+'&SESSDATA=fixture%2Cdata&bili_jct=fixture'}}:{code:navCode,data:{isLogin:navCode===0,mid:uid,uname:'fixture'}});
 const op=(action,id)=>api(file,action,id);assert.equal((await op('status')).status,'signed-out');let x=await op('start');assert.ok(x.qr.startsWith('data:image/svg+xml;base64,'));assert.equal((await op('poll',x.id)).status,'waiting');
 code=86090;assert.equal((await op('poll',x.id)).status,'scanned');code=0;assert.equal((await op('poll',x.id)).status,'signed-in');const old=fs.readFileSync(file,'utf8');assert.equal(JSON.parse(old).sessdata,'fixture%2Cdata');
 uid='456';x=await op('start');await assert.rejects(op('poll',x.id),/原先绑定/);assert.equal(fs.readFileSync(file,'utf8'),old);
 x=await op('start');code=86038;assert.equal((await op('poll',x.id)).status,'expired');x=await op('start');assert.equal((await op('cancel',x.id)).status,'cancelled');assert.equal((await op('poll',x.id)).status,'expired');navCode=-101;assert.equal((await op('status')).status,'signed-out');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
