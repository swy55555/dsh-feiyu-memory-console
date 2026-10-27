#!/usr/bin/env node
// 把 ~/.dsh/memvec/server.py 同步到插件的 memvec/ 目录。
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
const SRC = path.join(FROM, 'server.py');
const OUT = path.join(DEST, 'server.py');

// 这些是个人路径/QQ 号特征；源码里出现就拒绝同步，避免把私人信息带进包。
const FORBIDDEN = [
  /\b\d{8,12}\b/,
  /C:\\Users\\/i,
  /\/home\/[^/\s]+/,
];

if (!fs.existsSync(SRC)) {
  console.error(`找不到源文件：${SRC}`);
  console.error('用 --from 指定 memvec 目录，或把 server.py 放在 ~/.dsh/memvec/。');
  process.exit(2);
}

const source = fs.readFileSync(SRC, 'utf8');
for (const re of FORBIDDEN) {
  if (re.test(source)) {
    console.error(`源文件里出现疑似个人信息（${re}），拒绝同步：${SRC}`);
    process.exit(3);
  }
}

fs.mkdirSync(DEST, { recursive: true });
const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
if (checkOnly) {
  if (current === source) {
    console.log('memvec/server.py 已是最新');
    process.exit(0);
  }
  console.error('memvec/server.py 与源文件不一致，运行 node scripts/sync-memvec.mjs 同步');
  process.exit(1);
}

if (current === source) {
  console.log('memvec/server.py 没有变化');
  process.exit(0);
}
fs.writeFileSync(OUT, source, 'utf8');
console.log(`已同步：${SRC} -> ${OUT}`);
