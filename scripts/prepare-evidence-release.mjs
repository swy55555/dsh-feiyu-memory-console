// Produces a reviewable package/manifest. No service restart, database overwrite,
// git push, dependency installation or production writes.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const status=spawnSync('git',['status','--porcelain'],{cwd:root,encoding:'utf8',windowsHide:true});
if(status.status||status.stdout.trim())throw Error('Commit the reviewed candidate before packaging; sourceCommit must identify the exact files');
const at=process.argv.indexOf('--out');if(at<0||!process.argv[at+1])throw Error('--out <new directory> required');
const out=path.resolve(process.argv[at+1]);if(fs.existsSync(out))throw Error('output already exists');
const relative=path.relative(root,out);if(!relative.startsWith('..')&&!path.isAbsolute(relative))throw Error('output must be outside package source');
const check=spawnSync(process.execPath,['scripts/check-release.mjs'],{cwd:root,encoding:'utf8',windowsHide:true});if(check.status)throw Error(check.stdout+check.stderr);
fs.mkdirSync(out,{recursive:true});
const npm=process.platform==='win32'?process.env.ComSpec:'npm';
const args=process.platform==='win32'?['/d','/s','/c','npm pack --ignore-scripts --json']:['pack','--ignore-scripts','--json'];
// npm writes to cwd; an explicit pack destination avoids touching the worktree.
const r=spawnSync(npm,args,{cwd:root,env:{...process.env,npm_config_pack_destination:out},encoding:'utf8',windowsHide:true,timeout:60000});
if(r.status)throw Error(r.stderr);const pkg=JSON.parse(r.stdout)[0];
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const manifest={base:'142e99e99ae55135e20d9596072975c7d11ef94a',sourceCommit:spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim(),
 package:pkg.filename,sha256:hash(path.join(out,pkg.filename)),files:pkg.files.map(f=>({path:f.path,sha256:hash(path.join(root,f.path))})),
 requiresRestart:['DSH','qq-bridge','memvec'],databaseSchema:2,memoryFiles:['server.py','evidence_store.py','lexical_rank.py'],productionChanged:false};
fs.writeFileSync(path.join(out,'deployment-manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({package:manifest.package,sha256:manifest.sha256,files:manifest.files.length,out}));
