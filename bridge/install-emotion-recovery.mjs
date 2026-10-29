// Full runtime update with exact version hashes, backups and edit protection.
import os from 'node:os';
import path from 'node:path';
import {installRuntime} from './install-runtime-bundle.mjs';
const args=process.argv.slice(2),i=args.indexOf('--target');
const target=path.resolve(i>=0?args[i+1]:path.join(os.homedir(),'.dsh','qq-bridge'));
const mode=args.includes('--undo')?'undo':args.includes('--apply')?'apply':'check';
try { console.log(JSON.stringify(installRuntime(target,mode,{replaceLegacy:args.includes('--replace-legacy')}),null,2)); }
catch(error) { console.error(error.message);process.exitCode=1; }
