// 安装 0.9 运行时：trace、回复绑定、纠错辅助接口、有边界的关联。
// 采用“整份桥接运行时替换”，因为 0.8.x 的桥接文件差异较大，逐段 patch 容易漏。
// 安装前备份 bridge.js / human-context.mjs，可用 --undo 恢复。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (x) => args.includes(x);
const val = (x, d) => { const i = args.indexOf(x); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const target = path.resolve(val('--target', path.join(os.homedir(), '.dsh', 'qq-bridge')));
const file = path.join(target, 'src', 'bridge.js');
const humanFile = path.join(target, 'src', 'human-context.mjs');
const receipt = path.join(target, 'state', 'v09-runtime.json');
const die = (m) => { console.error(m); process.exit(1); };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

if (!fs.existsSync(file)) die(`找不到桥接文件：${file}`);
const current = read(file);
const human = read(humanFile);
const installed = current.includes('retrieval-trace-replies') && human.includes('!r.associated');

if (has('--check')) {
  console.log(installed ? 'already-installed' : JSON.stringify({ target, installed: false }, null, 2));
  process.exit(0);
}
if (has('--undo')) {
  let r = {};
  try { r = JSON.parse(read(receipt)); } catch {}
  if (!r.backup || !fs.existsSync(r.backup)) die('没有可用的安装回执/备份');
  fs.copyFileSync(r.backup, file);
  if (r.humanBackup && fs.existsSync(r.humanBackup)) fs.copyFileSync(r.humanBackup, humanFile);
  fs.rmSync(receipt, { force: true });
  console.log(`restored ${r.backup}`);
  process.exit(0);
}
if (!has('--apply')) die('用法：--check / --apply / --undo（可加 --target <桥接目录>）');
if (installed) { console.log('already-installed'); process.exit(0); }

const stamp = Date.now();
const backup = `${file}.bak-v09-${stamp}.js`;
fs.copyFileSync(file, backup);
let humanBackup = '';
if (fs.existsSync(humanFile)) {
  humanBackup = `${humanFile}.bak-v09-${stamp}.mjs`;
  fs.copyFileSync(humanFile, humanBackup);
}
fs.copyFileSync(path.join(HERE, 'bridge-v09.js'), file);
if (fs.existsSync(humanFile) || true) fs.copyFileSync(path.join(HERE, 'human-context-v09.mjs'), humanFile);
fs.mkdirSync(path.dirname(receipt), { recursive: true });
fs.writeFileSync(receipt, JSON.stringify({ backup, humanBackup, installedAt: new Date().toISOString(), target }, null, 2) + '\n', 'utf8');
console.log(`installed: ${file}`);
console.log(`backup: ${backup}`);
