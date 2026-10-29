import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

// Update preset sources through their supported parser, then regenerate artifacts.
// Does not alter identity, private memories, tools, permissions, models or reasoning levels.
const args=process.argv.slice(2),index=args.indexOf('--target');
if(index<0||!args[index+1])throw Error('Use --target <existing bridge directory> [--apply]');
const root=path.resolve(args[index+1]),apply=args.includes('--apply');
const {extractPresetPrefix,renderPresetPromptYaml,presetPromptBlockers}=await import(pathToFileURL(path.join(root,'src/preset-prompt.js')));
const yaml=createRequire(path.join(root,'package.json'))('js-yaml');
const style=fs.readFileSync(new URL('../bridge/conversation-style.md',import.meta.url),'utf8').trim();
const startMarker='【自然表达与防 AI 味】',endMarker='【自然表达规则结束】';
const records=[];
for(const preset of ['qq-chat','qq-chat-v2']){
 const file=path.join(root,'dsh/agent-presets',preset,'agent.cordis.yml'),raw=fs.readFileSync(file,'utf8');
 let prefix=extractPresetPrefix(raw),start=prefix.indexOf(startMarker),end;
 if(start>=0){end=prefix.indexOf(endMarker,start);if(end<0)throw Error('Unterminated conversation style');end+=endMarker.length;}
 else{
  start=prefix.indexOf('【自然表达】');
  if(start<0)start=prefix.indexOf('【反 AI 味：拒绝有求必应】');
  // Original v1 presets had no dedicated style section. Append without deleting anything.
  if(start<0&&preset==='qq-chat'){start=prefix.length;prefix+='\n\n';start=prefix.length;end=start;}
  else{if(start<0)throw Error('Unknown preset style; inspect before replacing');end=prefix.indexOf('【',start+1);if(end<0)end=prefix.length;}
 }
 const next=(prefix.slice(0,start)+style+'\n\n'+prefix.slice(end).trimStart()).replace(/\r\n/g,'\n').replace(/\n+$/,'');
 const mode=preset==='qq-chat'?'v1':'v2';assert.deepEqual(presetPromptBlockers(next,mode),[]);
 const updated=renderPresetPromptYaml(raw,next,mode),before=yaml.load(raw),after=yaml.load(updated);
 before.find(r=>r.id==='persona').config.prefix=next;
 if(!isDeepStrictEqual(before,after))throw Error('Preset update changed fields outside the expected style text; no files written');
 records.push({file,raw,updated,preset,changed:prefix!==next});
}
if(!apply){console.log(JSON.stringify({ready:true,changes:records.filter(r=>r.changed).map(r=>r.preset)}));process.exit(0);}
if(!records.some(r=>r.changed)){console.log(JSON.stringify({status:'already-installed'}));process.exit(0);}
const backup=path.join(root,'.runtime-backups','style-'+Date.now());fs.mkdirSync(backup,{recursive:true});
const snapshots=[];
for(const r of records){
 for(const file of [r.file,path.join(root,'plugins/qq-agent-presets/presets',r.preset+'.patch.yml')]){
  const saved=path.join(backup,String(snapshots.length)+'.bak');fs.copyFileSync(file,saved);snapshots.push({file,saved});
 }
}
fs.writeFileSync(path.join(backup,'files.json'),JSON.stringify(snapshots,null,2));
try{
 for(const r of records){assert.equal(fs.readFileSync(r.file,'utf8'),r.raw);fs.writeFileSync(r.file,r.updated);}
 const builder=path.join(root,'scripts/build-agent-preset-patches.mjs');
 for(const extra of [[],['--check']]){
  const result=spawnSync(process.execPath,[builder,...extra],{encoding:'utf8',windowsHide:true});
  if(result.status!==0)throw Error(result.stderr||result.stdout||'Preset build failed');
 }
}catch(error){for(const s of snapshots)fs.copyFileSync(s.saved,s.file);throw error;}
console.log(JSON.stringify({status:'installed',backup,presets:records.map(r=>r.preset),restartRequired:true}));
