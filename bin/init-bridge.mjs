import os from 'node:os';
import path from 'node:path';
import {initializeBridge} from '../bridge/first-install.mjs';
const args = process.argv.slice(2), i = args.indexOf('--target');
try {
  if (i >= 0 && (!args[i + 1] || args[i + 1].startsWith('--'))) throw Error('--target 需要目录');
  if (args.some((arg, n) => !['--target', '--apply', '--check'].includes(arg) && n !== i + 1)) throw Error('未知参数');
  const target = i >= 0 ? args[i + 1] : path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'qq-bridge');
  console.log(JSON.stringify(initializeBridge(target, {apply: args.includes('--apply')}), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
