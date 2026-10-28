// 给 QQ 桥接装上“情绪回弹”：生气按强度随机挂 10–45 分钟，被哄缩短。
// 这个补丁替换 src/emotion.js，安装前会备份；不想用时 --undo。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (x) => args.includes(x);
const val = (x, d) => { const i = args.indexOf(x); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const target = path.resolve(val('--target', path.join(os.homedir(), '.dsh', 'qq-bridge')));
const file = path.join(target, 'src', 'emotion.js');
const receipt = path.join(target, 'state', 'emotion-recovery-install.json');
const srcFile = path.join(HERE, 'emotion.js');
const die = (m) => { console.error(m); process.exit(1); };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

if (!fs.existsSync(file)) die(`找不到桥接文件：${file}`);
if (!fs.existsSync(srcFile)) die('安装器缺少 emotion.js 模板');
const current = read(file);
const installed = current.includes('angerHoldMinMinutes');

if (has('--check')) {
  console.log(installed ? 'already-installed' : JSON.stringify({ target, installed: false }, null, 2));
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
if (installed) { console.log('already-installed'); process.exit(0); }

const d = new Date();
const pad = (n) => String(n).padStart(2, '0');
const backup = `${file}.bak-emotion-recovery-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
fs.copyFileSync(file, backup);
fs.copyFileSync(srcFile, file);
fs.mkdirSync(path.dirname(receipt), { recursive: true });
fs.writeFileSync(receipt, JSON.stringify({ backup, installedAt: new Date().toISOString(), target }, null, 2) + '\n', 'utf8');
console.log(`installed: ${file}`);
console.log(`backup: ${backup}`);
