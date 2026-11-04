import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {legacyRebaseRevision,planLegacyRebase,commitLegacyRebase,recoverLegacyRebase,LEGACY_REBASE_CONFIRMATION} from '../bridge/legacy-rebase.mjs';
import {SelfReference} from '../bridge/self-reference.mjs';

const card='小舟说话温暖。她喜欢看游戏视频。旧设定是在海边长大。';
const dims=[{key:'warm',label:'温度',baseline:42,band:20},{key:'playful',label:'玩心',baseline:68,band:20}];
const persona={version:3,spec:{dimensions:dims},baseline:{warm:42,playful:68},current:{warm:45,playful:66},originBaseline:{warm:42,playful:68},history:[]};
const selfState={version:1,revision:8,claims:[{id:'identity',category:'identity',text:'过去的身份'},{id:'origin',category:'origin',text:'过去的来历'},{id:'feedback',category:'trait',referenceKind:'interaction_feedback',text:'聊天反馈'},{id:'interest',category:'interest',text:'自己的兴趣'}],queue:[{id:'q1',text:'原话'}],seen:[{id:'q1'}],history:[],audit:[],legacy:{entries:{identity:[{text:'旧卡'}]}},temperament:{growthMode:'evidence',spec:{dimensions:dims},baseline:{warm:42,playful:68},current:{warm:45,playful:66},originBaseline:{warm:42,playful:68},history:[],receipts:[{key:'warm',fp:'prior'}],pending:{warm:{delta:1,events:[]}},lastChangeAt:1}};
const preview={dimensions:[{key:'warm',value:70,quote:'说话温暖'},{key:'playful',value:68,quote:''}],identity:[{text:'小舟',quote:'小舟说话温暖'}],background:[{text:'在海边长大',quote:'在海边长大'}],style:[],interest:[{text:'喜欢看游戏视频',quote:'喜欢看游戏视频'}]};
const input=()=>({persona:structuredClone(persona),selfState:structuredClone(selfState),card,preview,starter:[{key:'warm',value:72},{key:'playful',value:60}],revision:legacyRebaseRevision(persona,selfState),confirmation:LEGACY_REBASE_CONFIRMATION,now:1700000000000});

test('existing-user rebase replaces six dimensions and own identity only',()=>{
 const result=planLegacyRebase(input());
 assert.deepEqual(result.newDimensions,{warm:72,playful:60});
 assert.deepEqual(result.persona.current,result.persona.baseline);
 assert.deepEqual(result.selfState.temperament.current,result.selfState.temperament.baseline);
 assert.equal(result.selfState.temperament.spec.dimensions[0].baseline,72);
 assert.equal(result.removedIdentityClaims,2);
 assert.deepEqual(result.selfState.claims.map(c=>c.id),['feedback','interest']);
 assert.deepEqual(result.selfState.queue,selfState.queue);
 assert.deepEqual(result.selfState.seen,selfState.seen);
 assert.deepEqual(result.selfState.temperament.receipts,selfState.temperament.receipts);
 assert.deepEqual(result.selfState.temperament.pending,{});
 assert.equal(result.selfState.legacy.entries.interest[0].text,'喜欢看游戏视频');
 assert.deepEqual(persona.current,{warm:45,playful:66});
 assert.equal(selfState.claims.length,4);
});

test('rebase requires fresh preview and explicit confirmation',()=>{
 const good=input();
 assert.throws(()=>planLegacyRebase({...good,revision:'stale'}),/状态已变化/);
 assert.throws(()=>planLegacyRebase({...good,confirmation:'确认'}),/请确认/);
 assert.throws(()=>planLegacyRebase({...good,preview:{...preview,background:[{text:'虚构',quote:'不存在'}]}}),/原文依据/);
 assert.throws(()=>planLegacyRebase({...good,starter:[{key:'warm',value:101},{key:'playful',value:60}]}),/六维/);
});

test('backup is created before writes and pending journal restores both files',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'xinji-rebase-'));
 try{
  const personaFile=path.join(dir,'persona.json'),selfFile=path.join(dir,'self-reference.json'),backupRoot=path.join(dir,'backups');
  fs.writeFileSync(personaFile,JSON.stringify(persona));fs.writeFileSync(selfFile,JSON.stringify(selfState));
  const result=planLegacyRebase(input());
  const saved=commitLegacyRebase({personaFile,selfFile,backupRoot,persona:result.persona,selfState:result.selfState});
  assert.equal(JSON.parse(fs.readFileSync(personaFile)).current.warm,72);
  assert.equal(JSON.parse(fs.readFileSync(selfFile)).claims.length,2);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(backupRoot,saved.backupId,'persona.json'))),persona);
  assert.equal(recoverLegacyRebase({personaFile,selfFile,backupRoot}),false);
  fs.writeFileSync(path.join(backupRoot,'pending.json'),JSON.stringify({id:saved.backupId}));
  assert.equal(recoverLegacyRebase({personaFile,selfFile,backupRoot}),true);
  assert.deepEqual(JSON.parse(fs.readFileSync(personaFile)),persona);
  assert.deepEqual(JSON.parse(fs.readFileSync(selfFile)),selfState);
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
});

test('history restore cannot undo only half of a rebase',()=>{
 const result=planLegacyRebase(input());
 const ref=new SelfReference({enabled:()=>true,allowed:()=>true,load:()=>result.selfState,save:()=>{}});
 assert.throws(()=>ref.restore(8),/重建前的历史不能单独恢复/);
});
