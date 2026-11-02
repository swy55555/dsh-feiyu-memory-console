#!/usr/bin/env node
// 把 ~/.dsh/memvec 的服务源码及证据索引模块同步到插件的 memvec/ 目录。
// 只复制源码；不碰 memories.db / hfcache / 日志 / 个人启动脚本。
//
//   node scripts/sync-memvec.mjs
//   node scripts/sync-memvec.mjs --from D:\some\memvec
//   node scripts/sync-memvec.mjs --check   # 只检查是否一致，不写

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEST = path.join(ROOT, 'memvec');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const fromIndex = args.indexOf('--from');
const FROM = fromIndex >= 0 && args[fromIndex + 1]
  ? path.resolve(args[fromIndex + 1])
  : path.join(os.homedir(), '.dsh', 'memvec');
const files=['server.py','evidence_store.py'];
// Validate the entire pair before any writes; never import production data.
const planned=files.map(name=>{
  const source=path.join(FROM,name),target=path.join(DEST,name);
  if(!fs.existsSync(source))throw Error(`Missing companion source: ${source}`);
  const content=fs.readFileSync(source,'utf8');
  if(/\b\d{8,12}\b|C:\\Users\\|\/home\/[^/\s]+/i.test(content))throw Error('Personal information in source: '+name);
  return {name,target,content,current:fs.existsSync(target)?fs.readFileSync(target,'utf8'):''};
});
if(checkOnly){
  const changed=planned.filter(p=>p.content!==p.current).map(p=>p.name);
  console.log(JSON.stringify({equal:!changed.length,changed}));process.exitCode=changed.length?1:0;
}else{
  fs.mkdirSync(DEST,{recursive:true});
  for(const p of planned)if(p.content!==p.current)fs.writeFileSync(p.target,p.content,'utf8');
  console.log('Synchronized memvec source pair; database and runtime untouched.');
}
