// 心迹入口。部署时作为 src/bridge.js，继续兼容既有守护脚本。
// QQ 兼容适配层仍承载收发和二代调度；此入口不另起第二个监听器。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {XINJI_IDENTITY} from './xinji-identity.mjs';
import {inspectClosure} from './runtime-inspection.mjs';

export function inspectRuntime(directory = path.dirname(fileURLToPath(import.meta.url)), options = {}) {
  const sourceLayout = fs.existsSync(path.join(directory, 'xinji-engine.mjs'));
  return {...XINJI_IDENTITY, ...inspectClosure(directory, {sourceLayout, ...options}),
    note: '递归检查桥接与三个 MCP 的字面量导入；--dependencies 另检查 npm 包解析。网络、账号、DSH 与模型能力需单独验收。'};
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  if (process.argv.includes('--describe')) console.log(JSON.stringify(XINJI_IDENTITY, null, 2));
  else if (process.argv.includes('--check')) {
    const report = inspectRuntime(undefined, {dependencies: process.argv.includes('--dependencies')});
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } else {
    const report = inspectRuntime();
    if (!report.ok) {
      console.error('心迹运行时不完整，请检查安装包：' + JSON.stringify(report));
      process.exitCode = 1;
    } else await import('./bridge-v09.js');
  }
}
