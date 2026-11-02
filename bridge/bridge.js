// 心迹入口。部署时作为 src/bridge.js，继续兼容既有守护脚本。
// QQ 兼容适配层仍承载收发和二代调度；此入口不另起第二个监听器。
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {XINJI_IDENTITY} from './xinji-identity.mjs';

export function inspectRuntime(directory = path.dirname(fileURLToPath(import.meta.url))) {
  const adapter = path.join(directory, 'bridge-v09.js');
  const missing = [];
  if (!fs.existsSync(adapter)) missing.push('bridge-v09.js');
  else {
    // Check the adapter's direct local imports without executing configuration,
    // reading chat state, taking the process lock, or opening a connection.
    const source = fs.readFileSync(adapter, 'utf8');
    for (const match of source.matchAll(/\bfrom\s+['"]\.\/([^'"]+)['"]/g)) {
      if (!fs.existsSync(path.join(directory, match[1]))) missing.push(match[1]);
    }
  }
  return {...XINJI_IDENTITY, ok: missing.length === 0, missing,
    note: '只检查本地适配模块；网络、账号、DSH 和外部依赖需启动后验收。'};
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) {
  if (process.argv.includes('--describe')) console.log(JSON.stringify(XINJI_IDENTITY, null, 2));
  else if (process.argv.includes('--check')) {
    const report = inspectRuntime();
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
  } else {
    const report = inspectRuntime();
    if (!report.ok) {
      console.error('心迹缺少 QQ 基础适配模块：' + report.missing.join(', ') + '。请先按升级指南部署到已有桥接目录。');
      process.exitCode = 1;
    } else await import('./bridge-v09.js');
  }
}
