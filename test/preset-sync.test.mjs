import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../bridge/bridge-v09.js',import.meta.url),'utf8');
const block=(a,b)=>source.slice(source.indexOf(a),source.indexOf(b,source.indexOf(a)));
function fixture(modern=true){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'preset-sync-')),name='qq-chat-v2',file=path.join(root,'source');fs.writeFileSync(file,'old');
 if(modern){fs.mkdirSync(path.join(root,'scripts'),{recursive:true});fs.writeFileSync(path.join(root,'scripts/build-agent-preset-patches.mjs'),'');fs.mkdirSync(path.join(root,'plugins/qq-agent-presets'),{recursive:true});}
 const artifact=modern?path.join(root,'plugins/qq-agent-presets/presets',name+'.patch.yml'):path.join(root,'.agent-presets',name,'agent.cordis.yml');
 fs.mkdirSync(path.dirname(artifact),{recursive:true});
 const render=()=>JSON.stringify([{insert:[{config:{id:name,plugins:[{id:'persona',config:{prefix:fs.readFileSync(file,'utf8')}}]}}]}]);
 fs.writeFileSync(artifact,modern?render():'old');
 const ctx=vm.createContext({ROOT:root,fs,path,process:{env:{DSH_HOME:root}},os,PRESET_NAMES:{v1:'qq-chat'},presetSourceYaml:()=>file,extractPresetPrefix:t=>t,readPresetPromptText:()=>({prefix:fs.readFileSync(file,'utf8')}),yaml:{load:JSON.parse},atomicWriteText:(p,t)=>fs.writeFileSync(p,t),backupPresetFile:()=>{},loadPresetRenderer:async()=>render});
 vm.runInContext(block('function dshHomeDir()', 'async function loadPresetRenderer(')+block('async function writeAndSyncPreset(', '// 这里**没有**')+block('function presetStatus(', '// 回复审计：'),ctx);
 return {root,file,artifact,ctx,status:()=>vm.runInContext('presetStatus("qq-chat-v2")',ctx),sync:text=>{ctx.nextText=text;return vm.runInContext('writeAndSyncPreset("qq-chat-v2",nextText)',ctx)},close:()=>fs.rmSync(root,{recursive:true,force:true})};
}
test('modern bundle detects exact content, updates artifact, and repairs unchanged source without claiming runtime load',async()=>{
 const f=fixture();try{
  assert.equal(f.status().synced,true);assert.equal(f.status().runtimeVerified,false);
  assert.equal((await f.sync('new style')).changed,true);assert.equal(f.status().synced,true);
  assert.equal((await f.sync('new style')).changed,false);
  fs.writeFileSync(f.artifact,'[]');assert.equal(f.status().installed,true);assert.equal(f.status().synced,false);
  assert.equal((await f.sync('new style')).changed,true);assert.equal(f.status().synced,true);
 }finally{f.close()}
});
test('failed generation restores both files, including restore requests; legacy installation remains supported',async()=>{
 const f=fixture();try{
  const before=fs.readFileSync(f.artifact,'utf8');f.ctx.loadPresetRenderer=async()=>()=>{throw Error('generation failed')};
  await assert.rejects(f.sync('broken'),/generation failed/);assert.equal(fs.readFileSync(f.file,'utf8'),'old');assert.equal(fs.readFileSync(f.artifact,'utf8'),before);
 }finally{f.close()}
 const legacy=fixture(false);try{await legacy.sync('legacy update');assert.equal(legacy.status().synced,true);assert.equal(legacy.status().format,'legacy')}finally{legacy.close()}
});
