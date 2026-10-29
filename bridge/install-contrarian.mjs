// 给 QQ 桥接接入“情绪低会唱反调”。
// 用法：--check / --apply / --undo，可加 --target <桥接目录>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const has = (x) => args.includes(x);
const val = (x, d) => { const i = args.indexOf(x); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const target = path.resolve(val('--target', path.join(os.homedir(), '.dsh', 'qq-bridge')));
const file = path.join(target, 'src', 'bridge.js');
const receipt = path.join(target, 'state', 'contrarian-install.json');
const die = (m) => { console.error(m); process.exit(1); };
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

const src = read(file);
if (!src) die(`找不到桥接文件：${file}`);
const installed = src.includes('function contrarianPrompt');

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
const backup = `${file}.bak-contrarian-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
fs.copyFileSync(file, backup);

let next = src.replace(/\r\n/g, '\n');
const marker = '  function personaBlockFor(key) {';
if (!next.includes(marker)) die('找不到 personaBlockFor，桥接版本不兼容');
const block = `  function contrarianPrompt(key) {
    const ec = cfg.socialV2?.emotion?.contrarian || {};
    if (ec.enabled === false) return '';
    const v = Number(emotionState?.mood?.valence ?? emotionState?.state?.valence ?? 0);
    const threshold = Number(ec.threshold ?? -0.15);
    if (!(v < threshold)) return '';
    const strong = v <= -0.35;
    const owner = personaIsOwnerKey(key);
    const scope = owner
      ? '这是老大私聊，可以直接说“我不太同意”“我偏不”，但别翻旧账、别冷暴力。'
      : '这是群聊，只对当前话题抬杠，别扫射、别把气撒到无关的人身上。';
    return \`【情绪影响·\${strong ? '明显' : '轻微'}】现在心情偏低，可以不顺着对方：挑一个你不同意的点、先质疑再听解释，少用附和。对方认真解释或示弱时收一点。\${scope}\${strong ? '但不能人身攻击、不能诅咒、不能编造事实。' : ''}\`;
  }

`;
next = next.replace(marker, block + marker, 1);

const old = "    return [base, line, epLine].filter(Boolean).join('\\n');";
if (!next.includes(old)) die('找不到 personaBlockFor 返回点，桥接版本不兼容');
next = next.replace(old, "    return [base, line, epLine, contrarianPrompt(key)].filter(Boolean).join('\\n');", 1);

fs.writeFileSync(file, next, 'utf8');
fs.mkdirSync(path.dirname(receipt), { recursive: true });
fs.writeFileSync(receipt, JSON.stringify({ backup, installedAt: new Date().toISOString(), target }, null, 2) + '\n', 'utf8');
console.log(`installed: ${file}`);
console.log(`backup: ${backup}`);
