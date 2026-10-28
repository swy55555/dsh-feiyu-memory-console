// 修复桥接记忆整理：QQ 消息 id 是数字，模型返回的 source_id 是字符串，
// 旧代码用 m.id === String(source_id) 永远不相等，导致所有候选被丢掉。
// 用法：node bridge/install-daily-memory-fix.mjs --target <桥接目录> --check|--apply|--undo
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const has = (x) => args.includes(x);
const val = (x, d) => { const i = args.indexOf(x); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const target = path.resolve(val('--target', path.join(os.homedir(), '.dsh', 'qq-bridge')));
const file = path.join(target, 'src', 'daily-memory.js');
const receipt = path.join(target, 'state', 'daily-memory-fix.json');
const die = (m) => { console.error(m); process.exit(1); };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

if (!fs.existsSync(file)) die(`找不到桥接文件：${file}`);
const current = read(file);
const fixed = current.includes('String(m.id) === String(row.source_id)');

if (has('--check')) {
  console.log(fixed ? 'already-installed' : JSON.stringify({ target, installed: false }, null, 2));
  process.exit(0);
}
if (has('--undo')) {
  let r = {};
  try { r = JSON.parse(read(receipt) || '{}'); } catch {}
  if (!r.backup || !fs.existsSync(r.backup)) die('没有可用的安装回执/备份');
  fs.copyFileSync(r.backup, file);
  fs.rmSync(receipt, { force: true });
  console.log(`restored ${r.backup}`);
  process.exit(0);
}
if (!has('--apply')) die('用法：--check / --apply / --undo（可加 --target <桥接目录>）');
if (fixed) { console.log('already-installed'); process.exit(0); }

let next = current;
next = next.replace(
  'const src = messages.find(m => m.id === String(row.source_id));',
  'const src = messages.find(m => String(m.id) === String(row.source_id));',
);
next = next.replace(
  "const ownerAutoConfirm = opts.autoConfirm === true && row.kind !== 'episode';",
  'const ownerAutoConfirm = opts.autoConfirm === true;',
);
if (!next.includes('String(m.id) === String(row.source_id)')) die('桥接版本不兼容：找不到 source_id 比较代码');
const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const backup = `${file}.bak-daily-memory-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
fs.copyFileSync(file, backup);
fs.writeFileSync(file, next, 'utf8');
fs.mkdirSync(path.dirname(receipt), { recursive: true });
fs.writeFileSync(receipt, JSON.stringify({ backup, installedAt: new Date().toISOString(), target }, null, 2) + '\n', 'utf8');
console.log(`installed: ${file}`);
console.log(`backup: ${backup}`);
