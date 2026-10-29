// 一键安装/检查/撤销所有桥接补丁。
// 用法：
//   node bridge/install-all.mjs --check
//   node bridge/install-all.mjs --apply
//   node bridge/install-all.mjs --undo
// 可加 --target <桥接目录>；默认 ~/.dsh/qq-bridge。
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (x) => args.includes(x);
const val = (x, d) => { const i = args.indexOf(x); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const target = path.resolve(val('--target', path.join(os.homedir(), '.dsh', 'qq-bridge')));

const steps = [
  { file: 'install.mjs', name: '原文/摘要/会话轮换' },
  { file: 'install-daily-memory-fix.mjs', name: '记忆整理 source_id 修复' },
  { file: 'install-runtime-extras.mjs', name: '记忆共享/群目录/花费归属' },
  { file: 'install-owner-contact.mjs', name: '主动联系/催睡' },
  { file: 'install-meme-play.mjs', name: '主动玩梗 + 图片 OCR' },
  { file: 'install-contrarian.mjs', name: '情绪低唱反调' },
  { file: 'install-emotion-spillover.mjs', name: '跨聊天情绪分享' },
  { file: 'install-emotion-recovery.mjs', name: '情绪回弹' },
  { file: 'install-v09-runtime.mjs', name: '0.9 trace/回复绑定/关联' },
];

const mode = has('--apply') ? '--apply' : has('--undo') ? '--undo' : '--check';
const order = mode === '--undo' ? [...steps].reverse() : steps;
let failed = 0;

console.log(`目标桥接：${target}`);
console.log(`模式：${mode}\n`);
for (const step of order) {
  const script = path.join(HERE, step.file);
  console.log(`── ${step.name} (${step.file})`);
  const r = spawnSync(process.execPath, [script, '--target', target, mode], {
    stdio: 'inherit',
    cwd: HERE,
  });
  if (r.status !== 0) {
    failed += 1;
    console.error(`✗ ${step.name} 失败，退出码 ${r.status}`);
    if (mode === '--apply') {
      console.error('已应用的步骤不会自动回滚；修好后可重跑 --apply（幂等），或逐项 --undo。');
      break;
    }
  }
}

if (failed) process.exit(1);
if (mode === '--apply') {
  console.log('\n全部补丁已应用；重启桥接后生效。');
} else if (mode === '--check') {
  console.log('\n检查完成；缺的补丁用 --apply 一次装齐。');
} else {
  console.log('\n已按相反顺序撤销。');
}
